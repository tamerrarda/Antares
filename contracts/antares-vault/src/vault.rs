//! The constructor and parameter validation — `02-CONTRACT-SPEC.md` §1, §4, §11.
//!
//! **`validate_params` lives here rather than in `admin.rs`** even though
//! `set_epoch_params` is what calls it most: it is the thing that *bounds* that
//! setter, so it carries `vault`'s 0-MISSED mutation bar instead of admin's ≤5 %
//! (06-TEST-PLAN §6). It is also the only thing standing between a setter and an
//! `unresolved_after` that disables the one terminal path not depending on the
//! oracle — and that overflows `expiry + unresolved_after` on the unpausable exit
//! path.
//!
//! Arithmetic here is written with explicit `checked_*` even where the profile's
//! `overflow-checks` would catch it. §8's bounds are proofs *about the inputs*;
//! the checked operation is what turns a violated proof into a revert instead of
//! a wrap, and the lint refuses the unchecked form at compile time.

use price_source_api::PriceSourceClient;
use soroban_sdk::{contractimpl, Address, Env, String};

use crate::errors::Error;
use crate::events::Initialized;
use crate::storage::{self, Rent};
use crate::types::{Config, EpochParams, Phase, State, DEAD_SHARES, INITIAL_PPS};
// `#[contractimpl]` in a module other than the one holding `#[contract]` refers
// to the client and args types the latter generates, so they are imported rather
// than re-declared. This is what lets the contract surface be split across
// `vault`, `token`, `admin` and `views` instead of one file.
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

/// One year. Every duration is bounded on **both** sides.
///
/// The upper half is not decoration: before it, only `epoch_duration` had a
/// ceiling, and an unbounded `unresolved_after` both disabled the one terminal
/// path that does not depend on the oracle *and* overflowed `expiry +
/// unresolved_after` outright — turning a checked add into a permanent panic on
/// the exit path. Any parameter that appears in a timestamp sum needs a ceiling
/// for that reason, so they all have one (D-68).
pub const MAX_DURATION: u64 = 31_536_000;

/// 30 days (D-63). The allowlist expires on a timestamp fixed at construction and
/// there is **no setter** — the admin may open the vault early but can never keep
/// it closed, which is what makes the permissionless path a property rather than
/// an operational promise.
pub const MAX_ALLOWLIST_WINDOW: u64 = 2_592_000;

/// Basis points, as an integer bound.
const BPS_U32: u32 = 10_000;

/// `settle_bounty_bps` ceiling (D-51): an uncapped bounty is D-39's mistake
/// again — a live-read, participant-facing lever over money already committed.
const MAX_BOUNTY_BPS: u32 = 100;

/// `auction_duration ≤ epoch_duration / AUCTION_FRACTION`.
const AUCTION_FRACTION: u64 = 24;

/// `min_idle_gap ≥ epoch_duration / IDLE_GAP_FRACTION` — the guaranteed exit
/// window has to scale with the epoch, because a fixed hour on a weekly epoch is
/// not a window (D-33).
const IDLE_GAP_FRACTION: u64 = 50;

fn in_duration_range(d: u64) -> bool {
    d > 0 && d <= MAX_DURATION
}

/// §1's validation, in full. Every rule here has a test that drives it to reject;
/// §1 is an inventory, not a sample.
///
/// `round_span` is `0` from here — which makes `supports_round` skip condition 7,
/// deliberately. Sponsorship is a **liveness** fact and must not be allowed to
/// block a parameter repair: if the feed's runway were checked in
/// `set_epoch_params`, an admin could not lower `unresolved_after` to recover from
/// exactly the shortfall that triggered it (D-68). `open_epoch` passes
/// `epoch_duration + unresolved_after` and enforces it there instead.
pub fn validate_params(
    env: &Env,
    oracle: &Address,
    params: &EpochParams,
    deposit_cap: i128,
) -> Result<(), Error> {
    // -- every duration, both sides --
    for d in [
        params.epoch_duration,
        params.auction_duration,
        params.min_idle_gap,
        params.twap_window,
        params.guard_window,
        params.max_staleness,
        params.oracle_dead_after,
        params.settle_grace,
        params.unresolved_after,
    ] {
        if !in_duration_range(d) {
            return Err(Error::InvalidParams);
        }
    }

    // -- relations between durations --
    let auction_cap = params
        .epoch_duration
        .checked_div(AUCTION_FRACTION)
        .ok_or(Error::InvalidParams)?;
    if params.auction_duration > auction_cap {
        return Err(Error::InvalidParams);
    }

    let idle_floor = params
        .epoch_duration
        .checked_div(IDLE_GAP_FRACTION)
        .ok_or(Error::InvalidParams)?;
    if params.min_idle_gap < idle_floor {
        return Err(Error::InvalidParams);
    }

    if params.guard_window <= params.twap_window {
        return Err(Error::InvalidParams);
    }

    // The evidence-based window must open before the evidence-free fallback
    // closes it, or the void branch is unreachable.
    if params.unresolved_after <= params.oracle_dead_after {
        return Err(Error::InvalidParams);
    }

    // -- premium band --
    //
    // The lower bound on the floor is load-bearing: a floor of 0 satisfies every
    // other rule and then makes the curve reject every bid with `ZeroPremium`
    // once it arrives there, so the last stretch of every auction is dead.
    if params.premium_floor_bps == 0 || params.premium_floor_bps > params.premium_start_bps {
        return Err(Error::InvalidParams);
    }
    if params.premium_start_bps >= BPS_U32 {
        return Err(Error::InvalidParams);
    }

    // -- strike and breaker --
    if params.strike_bps_otm > BPS_U32 {
        return Err(Error::InvalidParams);
    }
    if params.max_deviation_bps == 0 || params.max_deviation_bps > BPS_U32 {
        return Err(Error::InvalidParams);
    }

    // -- dust guards --
    if params.min_fill <= 0 {
        return Err(Error::InvalidParams);
    }
    // `> DEAD_SHARES`, not merely `> 0`. §1's claim that the first deposit can
    // never underflow rested on the *default* being 10 XLM, which is an
    // observation about a value rather than a constraint on it: at `INITIAL_PPS`
    // a `min_deposit` of 1 stroop mints 1 share and `minted − DEAD_SHARES`
    // underflows a checked subtraction, contradicting the promise that no
    // foreseeable condition panics.
    if params.min_deposit <= DEAD_SHARES {
        return Err(Error::InvalidParams);
    }

    // The pair spans two structs and two setters, so either one alone can produce
    // a vault no deposit can enter. Re-asserted here as well as in
    // `set_deposit_cap`.
    if deposit_cap != 0 && deposit_cap < params.min_deposit {
        return Err(Error::InvalidParams);
    }

    if params.settle_bounty_bps > MAX_BOUNTY_BPS {
        return Err(Error::InvalidParams);
    }

    // -- and the feed's own answer --
    //
    // The adapter owns every rule that depends on its tick and reachable depth,
    // and answers yes or no, so the vault never grows a `resolution` field (D-58).
    // Called through the client's recoverable `try_` form (04-ORACLE §3b): a
    // trapping or budget-exhausted adapter must surface as `InvalidParams`, not
    // as a host trap escaping the constructor.
    //
    // outbound: config.oracle
    let client = PriceSourceClient::new(env, oracle);
    let supported = client
        .try_supports_round(
            &params.twap_window,
            &params.guard_window,
            &params.oracle_dead_after,
            &params.settle_grace,
            &params.unresolved_after,
            &0,
        )
        .map_err(|_| Error::InvalidParams)?
        .map_err(|_| Error::InvalidParams)?;

    if !supported {
        return Err(Error::InvalidParams);
    }

    Ok(())
}

/// §4's rent bound, shared by the constructor and `set_rent_params`.
///
/// The ceiling is read **live** from the network rather than compiled in (D-50).
/// This check is hygiene that catches typos at the door: the load-bearing defence
/// is the per-call clamp in `storage::Rent::effective`, because the network can
/// lower `max_ttl` by protocol vote after the value is stored, and this check
/// cannot see the future.
pub fn validate_rent(env: &Env, threshold: u32, extend_to: u32) -> Result<(), Error> {
    if threshold == 0 || threshold >= extend_to || extend_to > env.storage().max_ttl() {
        return Err(Error::InvalidParams);
    }
    Ok(())
}

/// §11. The contract's own address in any role, and the `asset == oracle`
/// collision.
///
/// Not cosmetic in either half: the vault calling itself as a token would make a
/// self-transfer succeed while moving nothing, and an oracle that is also the
/// asset means one address answers two interfaces it cannot both satisfy.
fn validate_addresses(
    env: &Env,
    admin: &Address,
    asset: &Address,
    oracle: &Address,
    fee_recipient: &Address,
) -> Result<(), Error> {
    let me = env.current_contract_address();
    if *admin == me || *asset == me || *oracle == me || *fee_recipient == me {
        return Err(Error::InvalidAddress);
    }
    if asset == oracle {
        return Err(Error::InvalidAddress);
    }
    Ok(())
}

#[contractimpl]
impl AntaresVault {
    /// Ten arguments, one transaction (D-56/D-63). Runs once by construction —
    /// there is no `initialize` function to call twice, which is why no
    /// `NotInitialized` error exists.
    ///
    /// Three `Config` fields are **genesis constants rather than arguments**
    /// (D-56), and each for a reason worth keeping:
    /// - `fee_bps = 0`, so a non-zero fee always costs a separate, publicly
    ///   visible `set_fee_bps` transaction;
    /// - `paused = false`, because the launch control is the cap, not pause;
    /// - `allowlist_enabled = true`, safe by default — and disabling it is the
    ///   on-chain evidence that the permissionless path is live.
    #[allow(clippy::too_many_arguments)] // ten of them, by D-56's design
    pub fn __constructor(
        env: Env,
        admin: Address,
        asset: Address,
        oracle: Address,
        fee_recipient: Address,
        params: EpochParams,
        token_suffix: String,
        deposit_cap: i128,
        rent_threshold: u32,
        rent_extend_to: u32,
        allowlist_expires_at: u64,
    ) -> Result<(), Error> {
        validate_addresses(&env, &admin, &asset, &oracle, &fee_recipient)?;

        if token_suffix.len() > 4 {
            return Err(Error::InvalidParams);
        }
        if deposit_cap < 0 {
            return Err(Error::InvalidParams);
        }
        validate_rent(&env, rent_threshold, rent_extend_to)?;

        // D-63: capped at construction, and there is no setter anywhere in the
        // contract that can move it afterwards.
        let horizon = env
            .ledger()
            .timestamp()
            .checked_add(MAX_ALLOWLIST_WINDOW)
            .ok_or(Error::InvalidParams)?;
        if allowlist_expires_at > horizon {
            return Err(Error::InvalidParams);
        }

        validate_params(&env, &oracle, &params, deposit_cap)?;

        let config = Config {
            admin: admin.clone(),
            pending_admin: None,
            asset: asset.clone(),
            oracle: oracle.clone(),
            fee_recipient: fee_recipient.clone(),
            token_suffix: token_suffix.clone(),
            fee_bps: 0,
            deposit_cap,
            paused: false,
            allowlist_enabled: true,
            allowlist_expires_at,
            params: params.clone(),
            rent_threshold,
            rent_extend_to,
        };

        // `round = 0` and `last_finalize_time = 0`, so the first `open_epoch` is
        // not gated by `min_idle_gap`. The first opened round is 1.
        let state = State {
            round: 0,
            phase: Phase::Idle,
            params: params.clone(),
            fee_bps_snapshot: 0,
            opened_at: 0,
            auction_end: 0,
            expiry: 0,
            feed_decimals: 0,
            strike: 0,
            open_twap: 0,
            notional_offered: 0,
            notional_sold: 0,
            premium_collected: 0,
            locked_at_open: 0,
            shares_snapshot: 0,
            burned_this_round: 0,
            locked_assets: 0,
            shares_outstanding: 0,
            last_pps: INITIAL_PPS,
            last_settled_spot: 0,
            last_finalize_time: 0,
            pending_deposits_total: 0,
            withdraw_claimable_total: 0,
            bidder_claimable_total: 0,
            fee_claimable: 0,
        };

        storage::set_config(&env, &config);
        storage::set_state(&env, &state);
        storage::set_app_version(&env, APP_VERSION);
        storage::bump_instance(&env, Rent::effective(&env, &config));

        Initialized {
            admin,
            asset,
            oracle,
            fee_recipient,
            token_suffix,
            deposit_cap,
            rent_threshold,
            rent_extend_to,
            allowlist_expires_at,
            params,
            fee_bps: 0,
            paused: false,
            allowlist_enabled: true,
            app_version: APP_VERSION,
        }
        .publish(&env);

        Ok(())
    }
}

/// Genesis schema version. `migrate` is monotonic from here (D-13).
pub const APP_VERSION: u32 = 1;
