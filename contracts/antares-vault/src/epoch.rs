#![allow(clippy::arithmetic_side_effects)] // there is none here; every sum below is `checked_`
//! `open_epoch` — the only way a round begins.
//!
//! `02-CONTRACT-SPEC.md` §4 and §5 step 3 are authoritative and §5 step 3 is **exhaustive for
//! round opening**: every `State` field whose value is fixed by the act of opening is set here, and
//! a field absent from that list is one this function must not touch. Three of them —
//! `fee_bps_snapshot`, `open_twap` and `opened_at` — were missing from that list until 2026-08-18
//! while §2 declared all three and `bid` and settle both read them, so an implementer following it
//! literally would have shipped a round with no curve origin, no auditable strike derivation, and a
//! settle dividing by a fee snapshot nobody wrote. It is built from the list as it stands now.
//!
//! # Why this file is DEV2's
//!
//! Opening a round *is* a guarded read plus `supports_round` — the oracle seam, not the accounting
//! (`DEV-PROTOCOL.md` §3). It reads DEV1's `locked_assets` and `shares_outstanding` and writes
//! their `State`, which is why DEV1 reviews the snapshot and DEV3 reviews the `epoch_opened`
//! payload their bidder decodes.
//!
//! # It does not use `vault.rs`'s `enter()`, and the reason is D-43
//!
//! `enter()` runs `lazy_finalize` and discards the bool it returns, which is right for every
//! function that shares it: for them, whether a lapse happened on the way in changes nothing. This
//! is the one entry point where it changes everything. **If `lazy_finalize` finalized a round and a
//! precondition then fails, `open_epoch` must return `false` rather than revert** — a revert would
//! roll the finalization back with it, and that deadlocked the vault once already. So the preamble
//! is written out here rather than shared, and the difference is the point rather than duplication.

use soroban_sdk::{contractimpl, Env};

use crate::errors::Error;
use crate::events::EpochOpened;
use crate::oracle;
use crate::storage::{self, Rent};
use crate::types::{Config, Phase, State, BPS};
use crate::vault::{lazy_finalize, mul_div_floor};
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

#[contractimpl]
impl AntaresVault {
    // Returns `true` when a round opened.
    //
    // **`false` is not an error and is not "nothing happened".** It means step 1's `lazy_finalize`
    // finalized a round and then a precondition failed — most often `min_idle_gap`, which an eager
    // keeper meets constantly. Reverting there would discard the finalization along with the
    // failed open, leaving the vault stuck in `Auction` with a lapsed round it had already closed
    // (D-43). When nothing was finalized the call reverts normally, which is why
    // `IdleGapNotElapsed` is reachable at all and is the error a caller meets most.
    //
    // Pausable — one of exactly three (§4). Pausing stops new risk being written; it never stops
    // an existing round being closed or a depositor being paid.
    /// Open a new round: fix the strike from the live price and put the vault into `Auction`.
    /// Returns `false` if a lapse was finalized first and the open then could not proceed.
    pub fn open_epoch(env: Env) -> Result<bool, Error> {
        let config: Config =
            storage::get_config(&env).expect("Config: unrepresentable after __constructor");
        let mut state: State =
            storage::get_state(&env).expect("State: unrepresentable after __constructor");
        let rent = Rent::effective(&env, &config);

        // Step 1's first half. Whatever it did, it is kept: from here on, every failure path
        // returns `Ok(false)` and commits rather than reverting.
        let finalized = lazy_finalize(&env, &mut state, rent)?;

        // The whole of the rest of this function is "fail = commit the lapse and answer false, or
        // revert if there was no lapse to protect". `bail!` is that sentence once.
        macro_rules! bail {
            ($err:expr) => {
                if finalized {
                    storage::set_state(&env, &state);
                    storage::bump_instance(&env, rent);
                    return Ok(false);
                }
                return Err($err);
            };
        }

        if config.paused {
            bail!(Error::Paused);
        }
        if state.phase != Phase::Idle {
            bail!(Error::WrongPhase);
        }

        let now = env.ledger().timestamp();

        // §15 and D-33: `min_idle_gap` comes from **`State.params`** — the snapshot of the round
        // that just finalized — and from `Config.params` only before round 1 exists. Reading the
        // live copy would let an admin shorten the gap and open immediately, closing a window
        // depositors were relying on to get out.
        let params = if state.round == 0 {
            config.params.clone()
        } else {
            state.params.clone()
        };
        let Some(gap_ends) = state.last_finalize_time.checked_add(params.min_idle_gap) else {
            bail!(Error::InvalidParams);
        };
        if now < gap_ends {
            bail!(Error::IdleGapNotElapsed);
        }

        // Normative order: shares **before** `min_fill` (§4). `shares == 0` implies
        // `locked == 0` — direct XLM transfers are not counted — so a later shares check could
        // never fire and `NoShares` would be dead code.
        if state.shares_outstanding == 0 {
            bail!(Error::NoShares);
        }
        // The round that is about to open uses the *new* params, which are `Config`'s: this is the
        // moment the pending `set_epoch_params` takes effect (§1, "next epoch only").
        if state.locked_assets < config.params.min_fill {
            bail!(Error::NothingOffered);
        }

        // Step 2. Live, because the strike must reflect the market at the moment the option is
        // written. Reverts on stale, deviation or an invalid price — all retryable, none of them
        // terminal, because nobody has committed anything yet.
        let (twap, feed_decimals) = match oracle::live_reading(
            &env,
            &config.oracle,
            &config.params,
            state.last_settled_spot,
        ) {
            Ok(v) => v,
            Err(e) => {
                bail!(e);
            }
        };

        // `supports_round` re-checked against the **live** `resolution()`, and this is the only
        // call site that passes `round_span > 0` — `validate_params` passes `0` and skips
        // condition 7. So this is the only path that can answer *will the feed's own sponsorship
        // outlive this round*, and the reason a feed whose funding expires mid-round can never
        // open one: eviction deletes records that existed at expiry, and an anchored read
        // afterwards finds an empty window and returns `Unusable` — the void branch, refunding a
        // bidder in full on a feed that was healthy when the option was written (D-68, 04-ORACLE
        // §5).
        let Some(round_span) = config
            .params
            .epoch_duration
            .checked_add(config.params.unresolved_after)
        else {
            bail!(Error::InvalidParams);
        };
        if !oracle::supports_round(
            &env,
            &config.oracle,
            config.params.twap_window,
            config.params.guard_window,
            config.params.oracle_dead_after,
            config.params.settle_grace,
            config.params.unresolved_after,
            round_span,
        ) {
            bail!(Error::InvalidParams);
        }

        // §6: the strike floors, so the error is a lower strike, which favours the bidder by one
        // stroop. Symmetric across parties over a round and negligible.
        let Some(otm) = BPS.checked_add(i128::from(config.params.strike_bps_otm)) else {
            bail!(Error::InvalidParams);
        };
        let strike = match mul_div_floor(twap, otm, BPS) {
            Ok(s) => s,
            Err(e) => {
                bail!(e);
            }
        };
        let (Some(expiry), Some(auction_end)) = (
            now.checked_add(config.params.epoch_duration),
            now.checked_add(config.params.auction_duration),
        ) else {
            bail!(Error::InvalidParams);
        };
        let Some(round) = state.round.checked_add(1) else {
            bail!(Error::InvalidParams);
        };

        // Step 3, and §5's list is exhaustive: every field below is one the act of opening fixes,
        // and no field outside it is touched here.
        state.params = config.params.clone();
        // D-39. The one rate that lives in `Config` and has no other snapshot — read live at
        // settle it would apply a fee nobody agreed to when the round opened, and can drive
        // `assets_R` negative.
        state.fee_bps_snapshot = config.fee_bps;
        state.strike = strike;
        // The number the strike was derived from, so the derivation is auditable from the event
        // and the view rather than only reproducible.
        state.open_twap = twap;
        // The curve's origin: `bid` computes `now − opened_at`. Without it the auction has none.
        state.opened_at = now;
        state.expiry = expiry;
        state.auction_end = auction_end;
        state.notional_offered = state.locked_assets;
        state.locked_at_open = state.locked_assets;
        state.shares_snapshot = state.shares_outstanding;
        state.burned_this_round = 0;
        state.notional_sold = 0;
        state.premium_collected = 0;
        // D-68: the scale this round's records are written under. The close compares against it
        // and treats a change as `Transient`.
        state.feed_decimals = feed_decimals;
        state.round = round;
        state.phase = Phase::Auction;

        storage::set_state(&env, &state);
        storage::bump_instance(&env, rent);

        // Carries every input the decay curve needs, so the reference bidder and the UI can
        // evaluate `premium_bps(t)` from events alone, without a view call (§10).
        EpochOpened {
            round: state.round,
            strike: state.strike,
            expiry: state.expiry,
            opened_at: state.opened_at,
            auction_end: state.auction_end,
            notional_offered: state.notional_offered,
            open_twap: state.open_twap,
            premium_start_bps: state.params.premium_start_bps,
            premium_floor_bps: state.params.premium_floor_bps,
        }
        .publish(&env);

        Ok(true)
    }
}
