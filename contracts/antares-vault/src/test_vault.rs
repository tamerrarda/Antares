//! §1's validation table, §4's constructor row and §11's address rules — every
//! one driven to **reject**.
//!
//! §1 is an inventory, not a sample: a guard with only a happy-path test is
//! untested, and this is the phase gate. The rules are exercised against
//! `validate_params` and `validate_rent` directly rather than through the
//! constructor, because a constructor that fails *panics* in the test
//! environment — `Env` has no `try_register` — and `#[should_panic]` cannot tell
//! `InvalidParams` from `InvalidAddress`. The constructor's own rules, the ones
//! that exist nowhere else, are tested through it with the error code asserted in
//! the panic message.
//!
//! The parameter set below is the **fast-test** profile of §1, at the mock's
//! default `resolution() = 1`: `twap_window = 10`, `guard_window = 20`,
//! `settle_grace = 10`, `oracle_dead_after = 60`, and `unresolved_after` inside
//! `(235, 245]` — the interval D-69 moved down by one tick when it measured the
//! feed's reachable depth at 255 rather than 256. Built on the pre-D-69 numbers
//! this profile would sit one tick past the horizon and produce a void on a
//! healthy feed.

#![allow(clippy::inconsistent_digit_grouping)]

use crate::errors::Error;
use crate::types::*;
use crate::vault::{validate_params, validate_rent, MAX_ALLOWLIST_WINDOW, MAX_DURATION};
use crate::AntaresVault;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env, String,
};

// ------------------------------------------------------------------ fixtures ---

use crate::test_common::{valid_params, CAP, RENT_EXTEND_TO, RENT_THRESHOLD};

struct Fixture {
    env: Env,
    vault: Address,
    oracle: Address,
}

/// Registers the mock and a bare vault address to run `as_contract` inside.
fn fixture() -> Fixture {
    let d = crate::test_common::deploy();
    Fixture {
        env: d.env,
        vault: d.vault,
        oracle: d.oracle,
    }
}

impl Fixture {
    fn check(&self, params: &EpochParams, cap: i128) -> Result<(), Error> {
        self.env.as_contract(&self.vault, || {
            validate_params(&self.env, &self.oracle, params, cap)
        })
    }

    /// One field differs from `valid_params()`; everything else is identical, so
    /// the rejection can only be attributable to that field.
    fn reject(&self, label: &str, mutate: impl FnOnce(&mut EpochParams)) {
        let mut p = valid_params();
        mutate(&mut p);
        assert_eq!(
            self.check(&p, CAP),
            Err(Error::InvalidParams),
            "expected rejection: {label}"
        );
    }
}

// ------------------------------------------------------------- the happy path ---

#[test]
fn the_fast_test_profile_is_admissible() {
    let f = fixture();
    assert_eq!(
        f.check(&valid_params(), CAP),
        Ok(()),
        "the worked fast-test set of §1 must pass on its merits — the mock has no reject switch"
    );
}

/// The band's edges, asserted rather than assumed: D-69 moved both by one tick,
/// and a profile built on the old pair would have voided on a healthy feed.
#[test]
fn the_unresolved_after_band_is_exactly_235_to_245() {
    let f = fixture();

    let mut at_low = valid_params();
    at_low.unresolved_after = 235;
    assert_eq!(
        f.check(&at_low, CAP),
        Err(Error::InvalidParams),
        "235 is the reach limit itself, and the bound is strict"
    );

    let mut just_in = valid_params();
    just_in.unresolved_after = 236;
    assert_eq!(
        f.check(&just_in, CAP),
        Ok(()),
        "236 is the first admissible"
    );

    let mut at_high = valid_params();
    at_high.unresolved_after = 245;
    assert_eq!(f.check(&at_high, CAP), Ok(()), "245 is the last admissible");

    let mut over = valid_params();
    over.unresolved_after = 246;
    assert_eq!(
        f.check(&over, CAP),
        Err(Error::InvalidParams),
        "246 is past reach_limit + settle_grace"
    );
}

// ---------------------------------------------- every duration, both sides ------

#[test]
fn every_duration_is_rejected_at_zero() {
    let f = fixture();
    f.reject("epoch_duration = 0", |p| p.epoch_duration = 0);
    f.reject("auction_duration = 0", |p| p.auction_duration = 0);
    f.reject("min_idle_gap = 0", |p| p.min_idle_gap = 0);
    f.reject("twap_window = 0", |p| p.twap_window = 0);
    f.reject("guard_window = 0", |p| p.guard_window = 0);
    f.reject("max_staleness = 0", |p| p.max_staleness = 0);
    f.reject("oracle_dead_after = 0", |p| p.oracle_dead_after = 0);
    f.reject("settle_grace = 0", |p| p.settle_grace = 0);
    f.reject("unresolved_after = 0", |p| p.unresolved_after = 0);
}

/// The upper half is what stops `expiry + unresolved_after` overflowing on the
/// unpausable exit path — a checked add that would panic there instead of
/// reverting a call nobody can avoid making.
#[test]
fn every_duration_is_rejected_above_one_year() {
    let f = fixture();
    let over = MAX_DURATION + 1;
    f.reject("epoch_duration > 1y", |p| p.epoch_duration = over);
    f.reject("auction_duration > 1y", |p| p.auction_duration = over);
    f.reject("min_idle_gap > 1y", |p| p.min_idle_gap = over);
    f.reject("twap_window > 1y", |p| p.twap_window = over);
    f.reject("guard_window > 1y", |p| p.guard_window = over);
    f.reject("max_staleness > 1y", |p| p.max_staleness = over);
    f.reject("oracle_dead_after > 1y", |p| p.oracle_dead_after = over);
    f.reject("settle_grace > 1y", |p| p.settle_grace = over);
    f.reject("unresolved_after > 1y", |p| p.unresolved_after = over);
}

// ------------------------------------------------- relations between durations --

#[test]
fn the_auction_may_not_exceed_a_twenty_fourth_of_the_epoch() {
    let f = fixture();
    f.reject("auction_duration one second over the cap", |p| {
        p.auction_duration = 101
    });
}

/// D-33: the guaranteed exit window scales with the epoch, because a fixed hour
/// on a weekly epoch is not a window.
#[test]
fn the_idle_gap_may_not_fall_below_a_fiftieth_of_the_epoch() {
    let f = fixture();
    f.reject("min_idle_gap one second under the floor", |p| {
        p.min_idle_gap = 47
    });
}

#[test]
fn the_guard_window_must_be_strictly_longer_than_the_twap_window() {
    let f = fixture();
    f.reject("guard_window == twap_window", |p| {
        p.guard_window = p.twap_window
    });
    f.reject("guard_window < twap_window", |p| p.guard_window = 5);
}

/// The evidence-based window must open before the evidence-free fallback closes
/// it, or the void branch is unreachable.
#[test]
fn the_fallback_may_not_precede_the_void_window() {
    let f = fixture();
    f.reject("unresolved_after == oracle_dead_after", |p| {
        p.unresolved_after = p.oracle_dead_after
    });
    f.reject("unresolved_after < oracle_dead_after", |p| {
        p.unresolved_after = p.oracle_dead_after - 1
    });
}

// ---------------------------------------------------------------- the band ------

/// A floor of 0 satisfies every other rule and then makes the curve reject every
/// bid with `ZeroPremium` once it arrives there — the last stretch of every
/// auction would be dead.
#[test]
fn a_zero_premium_floor_is_rejected() {
    let f = fixture();
    f.reject("premium_floor_bps = 0", |p| p.premium_floor_bps = 0);
}

#[test]
fn the_floor_may_not_exceed_the_start() {
    let f = fixture();
    f.reject("floor > start", |p| {
        p.premium_floor_bps = p.premium_start_bps + 1
    });
}

#[test]
fn the_start_may_not_reach_one_hundred_percent() {
    let f = fixture();
    f.reject("premium_start_bps = 10_000", |p| {
        p.premium_start_bps = 10_000
    });
}

#[test]
fn the_strike_offset_and_breaker_are_bounded() {
    let f = fixture();
    f.reject("strike_bps_otm > 10_000", |p| p.strike_bps_otm = 10_001);
    f.reject("max_deviation_bps = 0", |p| p.max_deviation_bps = 0);
    f.reject("max_deviation_bps > 10_000", |p| {
        p.max_deviation_bps = 10_001
    });
}

// ----------------------------------------------------------- the dust guards ----

#[test]
fn min_fill_must_be_positive() {
    let f = fixture();
    f.reject("min_fill = 0", |p| p.min_fill = 0);
    f.reject("min_fill < 0", |p| p.min_fill = -1);
}

/// `> DEAD_SHARES`, not merely `> 0`. At `INITIAL_PPS` a one-stroop minimum mints
/// one share and `minted − DEAD_SHARES` underflows a checked subtraction — a
/// foreseeable condition panicking, which §12 enumerates as impossible.
#[test]
fn min_deposit_must_exceed_the_dead_shares() {
    let f = fixture();
    f.reject("min_deposit = 0", |p| p.min_deposit = 0);
    f.reject("min_deposit = 1", |p| p.min_deposit = 1);
    f.reject("min_deposit == DEAD_SHARES", |p| {
        p.min_deposit = DEAD_SHARES
    });

    let mut p = valid_params();
    p.min_deposit = DEAD_SHARES + 1;
    assert_eq!(
        f.check(&p, CAP),
        Ok(()),
        "one stroop above is admissible — the bound is exclusive, not a range"
    );
}

/// The pair spans two structs and two setters, so either alone can produce a
/// vault no deposit can enter.
#[test]
fn a_cap_below_the_minimum_deposit_is_rejected() {
    let f = fixture();
    let p = valid_params();
    assert_eq!(
        f.check(&p, p.min_deposit - 1),
        Err(Error::InvalidParams),
        "a cap under min_deposit admits no deposit at all"
    );
    assert_eq!(
        f.check(&p, p.min_deposit),
        Ok(()),
        "equal is admissible — exactly one deposit fits"
    );
    assert_eq!(f.check(&p, 0), Ok(()), "zero means uncapped, not closed");
}

/// An uncapped bounty is D-39's mistake again: a participant-facing lever over
/// money already committed.
#[test]
fn the_settle_bounty_is_capped_at_one_percent() {
    let f = fixture();
    f.reject("settle_bounty_bps = 101", |p| p.settle_bounty_bps = 101);

    let mut p = valid_params();
    p.settle_bounty_bps = 100;
    assert_eq!(
        f.check(&p, CAP),
        Ok(()),
        "100 bps is the boundary and admissible"
    );
}

// ------------------------------------------------------- the feed's own answer --

/// The vault never learns the resolution — it asks and is told yes or no (D-58).
/// Driving the answer to `false` therefore means making the *feed* incompatible,
/// not flipping a switch: the mock has none.
#[test]
fn a_profile_the_feed_cannot_honour_is_rejected() {
    let f = fixture();
    let client = mock_price_source::MockPriceSourceClient::new(&f.env, &f.oracle);

    // At a 300-second tick the fast-test windows are far below condition 1's
    // `twap_window ≥ 2·res`, which is exactly why §1 says a second-scale profile
    // cannot be built against the real feed.
    client.set_resolution(&300);
    assert_eq!(
        f.check(&valid_params(), CAP),
        Err(Error::InvalidParams),
        "the vault must refuse a round its feed cannot answer"
    );

    client.set_resolution(&1);
    assert_eq!(
        f.check(&valid_params(), CAP),
        Ok(()),
        "and accept it again when the feed can — so the rejection was the feed, not the profile"
    );
}

// ------------------------------------------------------------- the rent bound ---

#[test]
fn rent_bounds_are_enforced_at_both_ends() {
    let f = fixture();
    f.env.as_contract(&f.vault, || {
        let ceiling = f.env.storage().max_ttl();
        assert_eq!(validate_rent(&f.env, 0, 100), Err(Error::InvalidParams));
        assert_eq!(validate_rent(&f.env, 100, 100), Err(Error::InvalidParams));
        assert_eq!(validate_rent(&f.env, 101, 100), Err(Error::InvalidParams));
        assert_eq!(
            validate_rent(&f.env, 100, ceiling + 1),
            Err(Error::InvalidParams),
            "the ceiling is read live from the network, never compiled in"
        );
        assert_eq!(validate_rent(&f.env, 100, ceiling), Ok(()));
    });
}

// -------------------------------------------------- the constructor's own rules --

/// Ten arguments, and the ones only the constructor checks. A failing
/// constructor panics — `Env` has no `try_register` — so the error code is
/// asserted through the panic message instead.
// Mirrors a constructor D-56 fixes at ten arguments; a builder here would hide
// which argument a rejecting test is actually varying.
#[allow(clippy::too_many_arguments)]
fn construct(
    env: &Env,
    admin: &Address,
    asset: &Address,
    oracle: &Address,
    fee_recipient: &Address,
    suffix: &str,
    cap: i128,
    rent: (u32, u32),
    allowlist_expires_at: u64,
) -> Address {
    env.register(
        AntaresVault,
        (
            admin.clone(),
            asset.clone(),
            oracle.clone(),
            fee_recipient.clone(),
            valid_params(),
            String::from_str(env, suffix),
            cap,
            rent.0,
            rent.1,
            allowlist_expires_at,
        ),
    )
}

struct Roles {
    env: Env,
    admin: Address,
    asset: Address,
    oracle: Address,
    fee_recipient: Address,
}

fn roles() -> Roles {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle = env.register(mock_price_source::MockPriceSource, (admin.clone(), 14u32));
    Roles {
        asset: Address::generate(&env),
        fee_recipient: Address::generate(&env),
        admin,
        oracle,
        env,
    }
}

const RENT: (u32, u32) = (RENT_THRESHOLD, RENT_EXTEND_TO);

#[test]
fn the_constructor_writes_genesis() {
    let r = roles();
    let id = construct(
        &r.env,
        &r.admin,
        &r.asset,
        &r.oracle,
        &r.fee_recipient,
        "-A",
        CAP,
        RENT,
        0,
    );

    r.env.as_contract(&id, || {
        let cfg = crate::storage::get_config(&r.env).expect("config written");
        let st = crate::storage::get_state(&r.env).expect("state written");

        // Genesis constants, not arguments (D-56).
        assert_eq!(
            cfg.fee_bps, 0,
            "a non-zero fee always costs a visible setter tx"
        );
        assert!(!cfg.paused, "the launch control is the cap, not pause");
        assert!(cfg.allowlist_enabled, "safe by default");
        assert_eq!(cfg.pending_admin, None);

        assert_eq!(st.round, 0);
        assert_eq!(st.phase, Phase::Idle);
        assert_eq!(st.last_pps, INITIAL_PPS);
        assert_eq!(st.last_settled_spot, 0);
        assert_eq!(
            st.last_finalize_time, 0,
            "so the first open_epoch is not gated by min_idle_gap"
        );
        assert_eq!(st.shares_outstanding, 0);
        assert_eq!(st.locked_assets, 0);
        assert_eq!(crate::storage::get_app_version(&r.env), 1);
    });
}

#[test]
#[should_panic(expected = "#53")]
fn the_contracts_own_address_is_rejected_as_asset() {
    let r = roles();
    // `register_at` lets the vault's own address be known before construction,
    // which is the only way to hand it to itself.
    let me = Address::generate(&r.env);
    r.env.register_at(
        &me,
        AntaresVault,
        (
            r.admin.clone(),
            me.clone(), // asset == the contract itself
            r.oracle.clone(),
            r.fee_recipient.clone(),
            valid_params(),
            String::from_str(&r.env, ""),
            CAP,
            RENT_THRESHOLD,
            RENT_EXTEND_TO,
            0u64,
        ),
    );
}

#[test]
#[should_panic(expected = "#53")]
fn asset_and_oracle_may_not_be_the_same_address() {
    let r = roles();
    construct(
        &r.env,
        &r.admin,
        &r.oracle,
        &r.oracle,
        &r.fee_recipient,
        "",
        CAP,
        RENT,
        0,
    );
}

#[test]
#[should_panic(expected = "#41")]
fn a_suffix_longer_than_four_characters_is_rejected() {
    let r = roles();
    construct(
        &r.env,
        &r.admin,
        &r.asset,
        &r.oracle,
        &r.fee_recipient,
        "-LONG",
        CAP,
        RENT,
        0,
    );
}

#[test]
#[should_panic(expected = "#41")]
fn a_negative_deposit_cap_is_rejected() {
    let r = roles();
    construct(
        &r.env,
        &r.admin,
        &r.asset,
        &r.oracle,
        &r.fee_recipient,
        "",
        -1,
        RENT,
        0,
    );
}

/// D-63: capped at construction, with no setter anywhere that can move it. The
/// gate that can end this project cannot be frozen by inaction.
#[test]
#[should_panic(expected = "#41")]
fn an_allowlist_expiry_beyond_thirty_days_is_rejected() {
    let r = roles();
    let now = r.env.ledger().timestamp();
    construct(
        &r.env,
        &r.admin,
        &r.asset,
        &r.oracle,
        &r.fee_recipient,
        "",
        CAP,
        RENT,
        now + MAX_ALLOWLIST_WINDOW + 1,
    );
}

#[test]
fn an_allowlist_expiry_at_exactly_thirty_days_is_accepted() {
    let r = roles();
    let now = r.env.ledger().timestamp();
    construct(
        &r.env,
        &r.admin,
        &r.asset,
        &r.oracle,
        &r.fee_recipient,
        "",
        CAP,
        RENT,
        now + MAX_ALLOWLIST_WINDOW,
    );
}

#[test]
#[should_panic(expected = "#41")]
fn a_rent_ceiling_above_the_network_maximum_is_rejected() {
    let r = roles();
    let ceiling = r.env.as_contract(&r.oracle, || r.env.storage().max_ttl());
    construct(
        &r.env,
        &r.admin,
        &r.asset,
        &r.oracle,
        &r.fee_recipient,
        "",
        CAP,
        (RENT_THRESHOLD, ceiling + 1),
        0,
    );
}

/// §10: `initialized` can only ever be emitted here, and it carries the whole
/// starting configuration because an events-only indexer has no other source.
#[test]
fn the_constructor_emits_initialized_once() {
    let r = roles();
    construct(
        &r.env,
        &r.admin,
        &r.asset,
        &r.oracle,
        &r.fee_recipient,
        "-A",
        CAP,
        RENT,
        0,
    );
    let events = r.env.events().all();
    assert_eq!(
        events.events().len(),
        1,
        "exactly one event, and it is initialized — the constructor is the only place it can be emitted"
    );
}

// ================ the boundaries mutation testing found unpinned ================
//
// A 174-mutant run against `vault.rs` left fourteen survivors and nine were one
// shape: **every guard has a test that drives it to reject, and none pins the
// largest value it accepts.** A `>` silently widened to `>=` changes nothing any
// existing test observes, because no test stands on the boundary.
//
// These functions are covered by any line count. The gap is in what the assertions
// *pin*, and only mutation testing names that.

fn build(r: &Roles, p: EpochParams, suffix: &str, cap: i128) -> Address {
    r.env.register(
        AntaresVault,
        (
            r.admin.clone(),
            r.asset.clone(),
            r.oracle.clone(),
            r.fee_recipient.clone(),
            p,
            String::from_str(&r.env, suffix),
            cap,
            RENT_THRESHOLD,
            RENT_EXTEND_TO,
            0u64,
        ),
    )
}

#[test]
fn a_floor_equal_to_the_start_is_accepted() {
    let r = roles();
    let mut p = valid_params();
    // The rule rejects `floor > start`. `floor == start` is a degenerate but legal
    // curve — it opens at its floor and decays nowhere. Nothing forbids it, and
    // until now nothing said so either, which is what let `>` widen to `>=`.
    p.premium_floor_bps = p.premium_start_bps;
    build(&r, p, "", CAP);
}

#[test]
#[should_panic(expected = "#41")]
fn a_floor_one_stroop_above_the_start_is_not() {
    let r = roles();
    let mut p = valid_params();
    p.premium_floor_bps = p.premium_start_bps + 1;
    build(&r, p, "", CAP);
}

#[test]
fn a_strike_at_the_ceiling_is_accepted() {
    let r = roles();
    let mut p = valid_params();
    p.strike_bps_otm = 10_000;
    // The breaker must stay under half the strike, so it moves with it rather than
    // being left at a value the new strike would fail against.
    p.max_deviation_bps = 4_999;
    build(&r, p, "", CAP);
}

#[test]
fn a_breaker_at_the_ceiling_is_accepted() {
    let r = roles();
    let mut p = valid_params();
    // On-chain the only bound is `0 < max_deviation_bps <= BPS`. The tighter rule —
    // under half the strike — is an off-chain coherence gate, not this function's,
    // so the ceiling here is reachable and a test had to stand on it.
    p.max_deviation_bps = 10_000;
    build(&r, p, "", CAP);
}

#[test]
#[should_panic(expected = "#41")]
fn a_breaker_above_the_ceiling_is_not() {
    let r = roles();
    let mut p = valid_params();
    p.max_deviation_bps = 10_001;
    build(&r, p, "", CAP);
}

#[test]
fn a_four_character_suffix_is_accepted() {
    let r = roles();
    // Four is the longest legal name. A test that only proves five is refused
    // leaves the cap itself unstated, which is what the surviving mutant used.
    build(&r, valid_params(), "-ABC", CAP);
}

#[test]
fn a_zero_deposit_cap_is_legal_at_genesis_and_means_uncapped() {
    let r = roles();
    // The setter accepts zero and §16 says it means uncapped. Whether the
    // *constructor* admits the same value is what a surviving `deposit_cap < 0`
    // mutant was asking, and no test answered it either way.
    let vault = build(&r, valid_params(), "", 0);
    let cfg = r
        .env
        .as_contract(&vault, || crate::storage::get_config(&r.env).unwrap());
    assert_eq!(cfg.deposit_cap, 0);
}

#[test]
#[should_panic(expected = "#53")]
fn the_contracts_own_address_is_rejected_as_admin() {
    let r = roles();
    let me = Address::generate(&r.env);
    r.env.register_at(
        &me,
        AntaresVault,
        (
            me.clone(),
            r.asset.clone(),
            r.oracle.clone(),
            r.fee_recipient.clone(),
            valid_params(),
            String::from_str(&r.env, ""),
            CAP,
            RENT_THRESHOLD,
            RENT_EXTEND_TO,
            0u64,
        ),
    );
}

#[test]
#[should_panic(expected = "#53")]
fn the_contracts_own_address_is_rejected_as_fee_recipient() {
    let r = roles();
    let me = Address::generate(&r.env);
    // Three of the four positions had no rejecting test — only `asset` did — which
    // is why a `||` in the four-way chain could flip to `&&` and survive.
    r.env.register_at(
        &me,
        AntaresVault,
        (
            r.admin.clone(),
            r.asset.clone(),
            r.oracle.clone(),
            me.clone(),
            valid_params(),
            String::from_str(&r.env, ""),
            CAP,
            RENT_THRESHOLD,
            RENT_EXTEND_TO,
            0u64,
        ),
    );
}
