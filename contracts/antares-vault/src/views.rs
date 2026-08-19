//! The read surface — `02-CONTRACT-SPEC.md` §12.
//!
//! A public API, not an implementation detail: the keeper, the reference bidder
//! and all four UI pages compile against these, the TS bindings are generated
//! from them, and IP-5 freezes their shapes. "Extend freely" is exactly backwards
//! for a type other people build against — these may only be extended by
//! **appending**.
//!
//! **No view bumps a TTL.** Views may compute; they may not write. That is why
//! none of them takes the `Rent` every mutating path threads through, and why
//! reading a position never costs the reader rent.
//!
//! **`epoch()` reports the phase a mutating call would produce**, not the one in
//! storage. A round past `auction_end` with no fills reads `Idle` with
//! `outcome_pending = true` *before* anyone touches the contract. This logic
//! exists precisely so the keeper and the UI do not each reimplement lazy
//! finalization off-chain and get it subtly different.

use soroban_sdk::{contractimpl, Address, Env};

use crate::auction;
use crate::errors::Error;
use crate::storage;
use crate::types::{
    BidderPosition, Config, ConfigView, EpochInfo, EpochParams, Phase, Position, State, PRECISION,
};
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

fn load(env: &Env) -> (Config, State) {
    (
        storage::get_config(env).expect("Config: unrepresentable after __constructor"),
        storage::get_state(env).expect("State: unrepresentable after __constructor"),
    )
}

/// The phase a mutating call would leave behind, and whether a finalization is
/// owed.
///
/// Mirrors `lazy_finalize`'s branch without writing: an auction past its end with
/// fills is `Active` and still owes the oracle a close; without fills it has
/// lapsed and reads `Idle`.
fn effective_phase(env: &Env, state: &State) -> (Phase, bool) {
    if state.phase == Phase::Auction && env.ledger().timestamp() >= state.auction_end {
        if state.notional_sold > 0 {
            return (Phase::Active, false);
        }
        return (Phase::Idle, true);
    }
    (state.phase, false)
}

/// §15: the copy the *contract* enforces, not the newest one.
///
/// `State.params` is the snapshot of the round that created the window, so a
/// `set_epoch_params` cannot retroactively close a window depositors are relying
/// on. Before round 1 there is no snapshot and `Config.params` applies. Reading
/// the wrong copy makes the view disagree with the contract after any parameter
/// change — which is worse than not having the field.
fn governing_params<'a>(config: &'a Config, state: &'a State) -> &'a EpochParams {
    if state.round == 0 {
        &config.params
    } else {
        &state.params
    }
}

fn floor_at_zero(value: i128) -> i128 {
    if value < 0 {
        0
    } else {
        value
    }
}

fn mul_div_floor(a: i128, b: i128, d: i128) -> i128 {
    a.checked_mul(b).and_then(|p| p.checked_div(d)).unwrap_or(0)
}

#[contractimpl]
impl AntaresVault {
    /// The current epoch, with the phase a mutating call would produce.
    pub fn epoch(env: Env) -> EpochInfo {
        let (config, state) = load(&env);
        let (phase, outcome_pending) = effective_phase(&env, &state);
        let governing = governing_params(&config, &state);

        // `last_finalize_time + min_idle_gap`, from the copy the contract
        // enforces. Saturating rather than checked: both are bounded by
        // `validate_params`, and a view must answer rather than trap.
        let next_open_at = state
            .last_finalize_time
            .saturating_add(governing.min_idle_gap);

        // Zero when no round is live — there is nothing to void.
        let void_available_at = if state.phase == Phase::Idle {
            0
        } else {
            state.expiry.saturating_add(governing.oracle_dead_after)
        };

        EpochInfo {
            round: state.round,
            phase,
            outcome_pending,
            opened_at: state.opened_at,
            auction_end: state.auction_end,
            expiry: state.expiry,
            strike: state.strike,
            open_twap: state.open_twap,
            notional_offered: state.notional_offered,
            notional_sold: state.notional_sold,
            premium_collected: state.premium_collected,
            // Wired to the curve, 2026-08-19 (DEV3), when `auction.rs` landed.
            //
            // **A call, never a copy** — the reason DEV1 left this at 0 rather
            // than reimplementing it: a second copy of the curve would be diffed
            // by nothing, since `curve_ref.py` mirrors `auction.rs`, so a
            // duplicate here sits outside every layer that would catch it
            // drifting. Note what that means for the test that pins this field:
            // asserting `current_premium_bps == curve(now)` **cannot** tell a call
            // from an identical copy — both agree on day one and diverge only
            // later — and the mutation gate cannot either, because mutating a
            // duplicate breaks this view's own test and so counts as covered.
            // Only reading the code catches it. Hence the structural rule that
            // goes with the equality: **`views.rs` performs no arithmetic on
            // `premium_start_bps` or `premium_floor_bps`.** It performs none.
            //
            // `state` is passed with its **stored** phase, not the effective one
            // computed above, and the two cannot disagree here: a stored
            // `Auction` past `auction_end` is exactly the case the curve already
            // answers 0 for on the window test, so lazy finalization does not
            // need to be modelled twice.
            current_premium_bps: auction::premium_bps(&state, env.ledger().timestamp()),
            locked_assets: state.locked_assets,
            shares_outstanding: state.shares_outstanding,
            last_pps: state.last_pps,
            last_finalize_time: state.last_finalize_time,
            next_open_at,
            void_available_at,
            params: if state.round == 0 {
                config.params.clone()
            } else {
                state.params.clone()
            },
        }
    }

    /// One address's holdings, pending deposit and pending withdrawal.
    pub fn position(env: Env, user: Address) -> Position {
        let (_, state) = load(&env);
        let shares = storage::get_shares(&env, &user);

        let (pending_deposit, pending_deposit_round, pending_deposit_finalized) =
            match storage::get_pending_deposit(&env, &user) {
                // Finalized means *redeemable* — and it stays cancellable, which
                // D-37 made true and the old comment denied. A UI built on the
                // old meaning would grey out a button the contract still honours.
                Some(p) => (
                    p.amount,
                    p.round,
                    storage::get_round(&env, p.round).is_some(),
                ),
                None => (0, 0, false),
            };

        let (pending_withdraw_shares, pending_withdraw_round, withdraw_claimable) =
            match storage::get_pending_withdraw(&env, &user) {
                Some(p) => {
                    let claimable = match storage::get_round(&env, p.round) {
                        Some(r) => mul_div_floor(p.shares, r.pps, PRECISION),
                        // 0 until that round finalizes, which is a different
                        // statement from "nothing is owed".
                        None => 0,
                    };
                    (p.shares, p.round, claimable)
                }
                None => (0, 0, 0),
            };

        Position {
            shares,
            share_value: mul_div_floor(shares, state.last_pps, PRECISION),
            pending_deposit,
            pending_deposit_round,
            pending_deposit_finalized,
            pending_withdraw_shares,
            pending_withdraw_round,
            withdraw_claimable,
        }
    }

    /// The configuration, plus the headroom a depositor actually has.
    pub fn config(env: Env) -> ConfigView {
        let (config, state) = load(&env);

        // `cap − (locked + pending)`, floored at 0. A zero cap means uncapped,
        // not closed, so it reports the whole balance as headroom would be
        // meaningless — it reports 0, which is what `deposit` enforces: no cap.
        let deposit_headroom = if config.deposit_cap == 0 {
            0
        } else {
            floor_at_zero(
                config.deposit_cap.saturating_sub(
                    state
                        .locked_assets
                        .saturating_add(state.pending_deposits_total),
                ),
            )
        };

        ConfigView {
            admin: config.admin,
            pending_admin: config.pending_admin,
            asset: config.asset,
            oracle: config.oracle,
            fee_recipient: config.fee_recipient,
            fee_bps: config.fee_bps,
            deposit_cap: config.deposit_cap,
            deposit_headroom,
            paused: config.paused,
            allowlist_enabled: config.allowlist_enabled,
            allowlist_expires_at: config.allowlist_expires_at,
            app_version: storage::get_app_version(&env),
            params: config.params,
            rent_threshold: config.rent_threshold,
            rent_extend_to: config.rent_extend_to,
        }
    }

    /// What one bidder holds in one round.
    ///
    /// A zeroed struct for an address that never filled — **not** an error. The
    /// Claims page scans rounds looking for money owed, so "no fill" is its
    /// ordinary answer and must be cheap and unambiguous; an error would make the
    /// common case indistinguishable from a malformed call. `RoundNotFound` is
    /// still returned for a round that never existed.
    pub fn bidder_position(env: Env, round: u32, bidder: Address) -> Result<BidderPosition, Error> {
        let (_, state) = load(&env);
        if round == 0 || round > state.round {
            return Err(Error::RoundNotFound);
        }

        let Some(fill) = storage::get_fill(&env, round, &bidder) else {
            return Ok(BidderPosition {
                notional: 0,
                premium_paid: 0,
                claimed: false,
                claimable: 0,
            });
        };

        // `claimable` depends on the round's outcome, which is why the Claims
        // page cannot be built from `Fill` alone. Settlement and refund arithmetic
        // are DEV2's and DEV3's; until `settle.rs` and `claims.rs` land this
        // reports the fill honestly and leaves the amount at 0 rather than
        // guessing at a formula that lives elsewhere.
        Ok(BidderPosition {
            notional: fill.notional,
            premium_paid: fill.premium_paid,
            claimed: fill.claimed,
            claimable: 0,
        })
    }

    /// A finalized round's recorded price. A live round returns `last_pps`.
    ///
    /// Not an error for the live round: a live round has no price yet, and
    /// erroring would make "not settled" indistinguishable from "does not exist".
    pub fn price_per_share(env: Env, round: u32) -> Result<i128, Error> {
        let (_, state) = load(&env);
        match storage::get_round(&env, round) {
            Some(r) => Ok(r.pps),
            None if round == state.round && state.phase != Phase::Idle => Ok(state.last_pps),
            None => Err(Error::RoundNotFound),
        }
    }

    /// Capital actually backing shares.
    ///
    /// Deliberately excludes pending deposits (not yet shares), claimable
    /// balances (already owed to someone) and raw donations (belong to nobody).
    /// External tooling reads this as TVL, which is why it is pinned rather than
    /// convenient.
    pub fn total_assets(env: Env) -> i128 {
        let (_, state) = load(&env);
        state.locked_assets
    }

    /// Indicative conversion at the last settled price.
    ///
    /// Does **not** imply a mint is currently possible: minting happens only in
    /// the idle window (D-18), and not at all while the vault is worthless.
    pub fn convert_to_shares(env: Env, assets: i128) -> i128 {
        let (_, state) = load(&env);
        if state.last_pps == 0 {
            return 0;
        }
        mul_div_floor(assets, PRECISION, state.last_pps)
    }
}
