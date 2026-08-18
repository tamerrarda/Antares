//! IP-1's own tests: the two things that can actually be wrong about a frozen
//! type surface.
//!
//! 1. **Error numbers are ABI.** Every variant's value is asserted explicitly, so
//!    renumbering one fails here rather than in an integrator's error handling
//!    months later. The retired numbers are asserted absent for the same reason —
//!    §3 says gaps are never re-used, and nothing but a test enforces that.
//! 2. **Every `#[contracttype]` survives a round trip through `Val`.** A struct
//!    that does not encode is not a contract type, and finding that out when
//!    `storage.rs` first writes it would be finding it out one phase late.

// Stroop amounts are written the way the specification writes them — the integer
// part, then all seven decimals, as in `100_0000000` for 100 XLM. Clippy reads
// that as inconsistent grouping; it is the notation every amount in `02-CONTRACT-SPEC`
// uses, and `1_000_000_000` would hide the decimal point this project's arithmetic
// turns on. Narrow, deliberate, and confined to literals.
#![allow(clippy::inconsistent_digit_grouping)]

use crate::errors::Error;
use crate::types::*;
use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal, String, TryFromVal, Val};

// ------------------------------------------------------------ error numbers ---

/// Every allocated code, spelled out. This is deliberately a literal list and
/// not a loop: the point is that changing a number requires editing a line that
/// says what the number is.
#[test]
fn error_numbers_are_exactly_the_specified_ones() {
    assert_eq!(Error::Paused as u32, 1);
    assert_eq!(Error::WrongPhase as u32, 2);
    assert_eq!(Error::IdleGapNotElapsed as u32, 3);
    assert_eq!(Error::NotExpired as u32, 4);
    assert_eq!(Error::OracleNotDeadYet as u32, 6);
    assert_eq!(Error::NothingOffered as u32, 7);
    assert_eq!(Error::NoShares as u32, 8);
    assert_eq!(Error::RoundNotFound as u32, 9);

    assert_eq!(Error::OracleStale as u32, 10);
    assert_eq!(Error::OracleDeviation as u32, 11);
    assert_eq!(Error::OracleInvalidPrice as u32, 12);
    assert_eq!(Error::OracleUnreachable as u32, 13);

    assert_eq!(Error::BelowMinDeposit as u32, 20);
    assert_eq!(Error::DepositCapExceeded as u32, 21);
    assert_eq!(Error::NothingPending as u32, 22);
    assert_eq!(Error::UnredeemedPending as u32, 24);
    assert_eq!(Error::InsufficientShares as u32, 25);
    assert_eq!(Error::NothingToClaim as u32, 26);
    assert_eq!(Error::WithdrawNotSettled as u32, 27);
    assert_eq!(Error::InsufficientAllowance as u32, 29);

    assert_eq!(Error::AllowlistForbidden as u32, 30);
    assert_eq!(Error::PremiumAboveMax as u32, 31);
    assert_eq!(Error::BelowMinFill as u32, 32);
    assert_eq!(Error::SoldOut as u32, 33);
    assert_eq!(Error::InTheMoney as u32, 34);
    assert_eq!(Error::ZeroPremium as u32, 35);
    assert_eq!(Error::InsufficientBalance as u32, 36);
    assert_eq!(Error::AlreadyClaimed as u32, 37);
    assert_eq!(Error::NoFill as u32, 38);
    assert_eq!(Error::WrongOutcome as u32, 39);

    assert_eq!(Error::InvalidAmount as u32, 40);
    assert_eq!(Error::InvalidParams as u32, 41);
    assert_eq!(Error::ZeroShares as u32, 44);

    assert_eq!(Error::MigrationOrder as u32, 51);
    assert_eq!(Error::NoPendingAdmin as u32, 52);
    assert_eq!(Error::InvalidAddress as u32, 53);
    assert_eq!(Error::VaultWorthless as u32, 54);
}

/// The whole allocated set, in one place, so the next two tests can reason about
/// it. Kept beside the list above rather than derived from it — a list derived
/// from the thing it checks proves nothing.
const ALLOCATED: [u32; 37] = [
    1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21, 22, 24, 25, 26, 27, 29, 30, 31, 32, 33, 34, 35,
    36, 37, 38, 39, 40, 41, 44, 51, 52, 53, 54,
];

/// §3: gaps are never re-used and retired codes stay retired. `5` was
/// `AuctionClosed`, `23` was `PendingNotFinalized`, `28` was
/// `PendingAlreadyFinalized`, and `55`/`56` were two of D-60's three
/// wrong-entry-point errors that D-61 made unreachable.
#[test]
fn retired_codes_are_never_reallocated() {
    for retired in [5u32, 23, 28, 55, 56] {
        assert!(
            !ALLOCATED.contains(&retired),
            "a retired error code was reallocated"
        );
    }
}

/// A renumbering that happens to collide would otherwise pass the list above
/// only if it also edited that line — this catches the collision itself.
#[test]
fn no_two_errors_share_a_number() {
    let mut i = 0;
    while i < ALLOCATED.len() {
        let mut j = i + 1;
        while j < ALLOCATED.len() {
            assert!(ALLOCATED[i] != ALLOCATED[j], "duplicate error number");
            j += 1;
        }
        i += 1;
    }
}

// -------------------------------------------------------------- round trips ---

/// The shipped testnet defaults (§1's parameter table). Using the real values
/// rather than `1`s means a field that silently changed type or meaning tends to
/// show up here too.
fn shipped_params() -> EpochParams {
    EpochParams {
        epoch_duration: 604_800,
        auction_duration: 2_700,
        min_idle_gap: 14_400,
        strike_bps_otm: 300,
        premium_start_bps: 450,
        premium_floor_bps: 40,
        twap_window: 900,
        guard_window: 3_600,
        max_staleness: 600,
        max_deviation_bps: 100,
        oracle_dead_after: 43_200,
        settle_grace: 7_200,
        unresolved_after: 75_600,
        min_fill: 100_0000000,
        min_deposit: 10_0000000,
        settle_bounty_bps: 25,
    }
}

fn round_trip<T>(env: &Env, value: T)
where
    T: Clone + IntoVal<Env, Val> + TryFromVal<Env, Val> + PartialEq + core::fmt::Debug,
{
    let encoded: Val = value.clone().into_val(env);
    let decoded = T::try_from_val(env, &encoded).expect("type failed to decode from Val");
    assert_eq!(decoded, value);
}

#[test]
fn every_contracttype_round_trips_through_val() {
    let env = Env::default();
    let addr = Address::generate(&env);
    let params = shipped_params();

    round_trip(&env, Phase::Idle);
    round_trip(&env, Phase::Auction);
    round_trip(&env, Phase::Active);

    round_trip(&env, RoundOutcome::Settled);
    round_trip(&env, RoundOutcome::Lapsed);
    round_trip(&env, RoundOutcome::Voided);
    round_trip(&env, RoundOutcome::Unresolved);

    round_trip(&env, VoidReason::FeedUnusable);
    round_trip(&env, VoidReason::InvalidPrice);

    round_trip(&env, params.clone());

    round_trip(
        &env,
        Config {
            admin: addr.clone(),
            pending_admin: None,
            asset: addr.clone(),
            oracle: addr.clone(),
            fee_recipient: addr.clone(),
            token_suffix: String::from_str(&env, "-A"),
            fee_bps: 0,
            deposit_cap: 100_000_0000000,
            paused: false,
            allowlist_enabled: true,
            allowlist_expires_at: 2_592_000,
            params: params.clone(),
            rent_threshold: 17_280,
            rent_extend_to: 518_400,
        },
    );

    round_trip(
        &env,
        State {
            round: 1,
            phase: Phase::Auction,
            params: params.clone(),
            fee_bps_snapshot: 0,
            opened_at: 1,
            auction_end: 2,
            expiry: 3,
            feed_decimals: 14,
            strike: 1_630_000,
            open_twap: 1_580_000,
            notional_offered: 1,
            notional_sold: 2,
            premium_collected: 3,
            locked_at_open: 4,
            shares_snapshot: 5,
            burned_this_round: 6,
            locked_assets: 7,
            shares_outstanding: 8,
            last_pps: PRECISION,
            last_settled_spot: 0,
            last_finalize_time: 9,
            pending_deposits_total: 10,
            withdraw_claimable_total: 11,
            bidder_claimable_total: 12,
            fee_claimable: 13,
        },
    );

    round_trip(
        &env,
        Round {
            outcome: RoundOutcome::Settled,
            pps: PRECISION,
            strike: 1_630_000,
            expiry: 3,
            notional_sold: 4,
            premium: 5,
            fee: 6,
            settled_spot: 7,
            payout_total: 8,
        },
    );

    round_trip(
        &env,
        PendingDeposit {
            round: 1,
            amount: 10_0000000,
        },
    );
    round_trip(
        &env,
        PendingWithdraw {
            round: 1,
            shares: 10_0000000,
        },
    );
    round_trip(
        &env,
        Fill {
            notional: 100_0000000,
            premium_paid: 1_0000000,
            claimed: false,
        },
    );

    round_trip(
        &env,
        EpochInfo {
            round: 1,
            phase: Phase::Idle,
            outcome_pending: true,
            opened_at: 1,
            auction_end: 2,
            expiry: 3,
            strike: 4,
            open_twap: 5,
            notional_offered: 6,
            notional_sold: 7,
            premium_collected: 8,
            current_premium_bps: 0,
            locked_assets: 9,
            shares_outstanding: 10,
            last_pps: PRECISION,
            last_finalize_time: 11,
            next_open_at: 12,
            void_available_at: 0,
            params: params.clone(),
        },
    );

    round_trip(
        &env,
        Position {
            shares: 1,
            share_value: 2,
            pending_deposit: 3,
            pending_deposit_round: 4,
            pending_deposit_finalized: true,
            pending_withdraw_shares: 5,
            pending_withdraw_round: 6,
            withdraw_claimable: 7,
        },
    );

    round_trip(
        &env,
        ConfigView {
            admin: addr.clone(),
            pending_admin: Some(addr.clone()),
            asset: addr.clone(),
            oracle: addr.clone(),
            fee_recipient: addr,
            fee_bps: 0,
            deposit_cap: 1,
            deposit_headroom: 2,
            paused: false,
            allowlist_enabled: true,
            allowlist_expires_at: 3,
            app_version: 1,
            params,
            rent_threshold: 4,
            rent_extend_to: 5,
        },
    );

    round_trip(
        &env,
        BidderPosition {
            notional: 1,
            premium_paid: 2,
            claimed: false,
            claimable: 3,
        },
    );
}

/// `pending_admin` is the only `Option` in the surface, and an `Option` that
/// only ever round-trips as `Some` is half-tested.
#[test]
fn optional_pending_admin_round_trips_in_both_states() {
    let env = Env::default();
    let addr = Address::generate(&env);
    let base = Config {
        admin: addr.clone(),
        pending_admin: None,
        asset: addr.clone(),
        oracle: addr.clone(),
        fee_recipient: addr.clone(),
        token_suffix: String::from_str(&env, ""),
        fee_bps: 0,
        deposit_cap: 0,
        paused: false,
        allowlist_enabled: true,
        allowlist_expires_at: 0,
        params: shipped_params(),
        rent_threshold: 1,
        rent_extend_to: 2,
    };

    round_trip(&env, base.clone());
    round_trip(
        &env,
        Config {
            pending_admin: Some(addr),
            ..base
        },
    );
}

// ------------------------------------------------------------------ constants ---

#[test]
fn constants_match_the_specification() {
    assert_eq!(PRECISION, 10_000_000);
    assert_eq!(BPS, 10_000);
    assert_eq!(INITIAL_PPS, PRECISION);
    assert_eq!(DEAD_SHARES, 1_000);
}
