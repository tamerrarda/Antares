//! `open_epoch` — every precondition driven to reject, and the two regressions that cost this
//! project a deadlock.
//!
//! The failure modes come from the mock rather than from waiting: a settable `resolution()`,
//! settable records, a settable `expires()` and a trap switch between them reach every guard in the
//! live ladder and both halves of D-43.
//!
//! Two of these tests are not about a guard at all. **D-43** is about what happens when a guard
//! fires *after* `lazy_finalize` has already finalized something, and **D-38** is about the same
//! two operations succeeding in one transaction. Both were real deadlocks; neither is reachable by
//! testing the guards individually.

// The stroop notation of the specification — the integer part, then all seven decimals — the same
// exception `test_common.rs` takes and for the same reason: `1_000_0000000` shows the decimal
// point that this project's arithmetic turns on, and `10_000_000_000` hides it.
#![allow(clippy::inconsistent_digit_grouping)]

use crate::test_common::{deploy, valid_params, Deployed};
use crate::types::Phase;
use crate::Error;
use mock_price_source::{MockPriceSourceClient, Mode};
use price_source_api::OracleReading;

/// The fast-test profile's numbers, restated so a failing assertion reads locally.
const EPOCH: u64 = 2_400;
const AUCTION: u64 = 100;
const GAP: u64 = 48;
const UNRESOLVED: u64 = 240;
/// `epoch_duration + unresolved_after` — the span condition 7 is asked about.
const ROUND_SPAN: u64 = EPOCH + UNRESOLVED;
/// 0.16 USD at the mock's 14 decimals, and the same price at 1e7.
const PX: i128 = 16_000_000_000_000;
const PX_1E7: i128 = 1_600_000;

fn oracle(d: &Deployed) -> MockPriceSourceClient<'_> {
    MockPriceSourceClient::new(&d.env, &d.oracle)
}

/// A vault that can open: funded, deposited, with a healthy feed and a funded one.
///
/// The feed has to be *sponsored past the round* as well as healthy — condition 7 is the guard
/// `open_epoch` alone can reach, and a mock whose `expires()` answers too early makes every open
/// refuse and stalls a whole harness on a condition nobody was watching (02-CONTRACT-SPEC §1).
fn ready() -> Deployed {
    let d = deploy();
    let user = d.user(10_000_0000000);
    d.client().deposit(&user, &1_000_0000000);

    // Advance **first**, then feed. The other order looks equivalent and is not: `max_staleness`
    // is 30 s in this profile and the gap is 48, so a feed filled before the wait is already stale
    // by the time the open happens — every test would then fail on step 2 having never reached the
    // guard it was written for. That is the fixture failing, not the vault, and it is worth the
    // comment because the symptom points at the wrong file.
    d.advance(GAP);
    let now = d.env.ledger().timestamp();
    let o = oracle(&d);
    o.fill(&now, &40, &PX);
    o.set_expires(&Some(now + ROUND_SPAN + 1));
    d
}

// =================================================================================================
// The happy path, and §5 step 3's list in full
// =================================================================================================

#[test]
fn opening_snapshots_exactly_the_fields_step_3_lists() {
    // §5 step 3 is **exhaustive for round opening**: every field the act of opening fixes is set,
    // and a field absent from the list is one this function must not touch. Three of them —
    // fee_bps_snapshot, open_twap and opened_at — were missing from that list until 2026-08-18
    // while §2 declared all three and `bid` and settle both read them. This asserts all of them,
    // because the ones that were missing are exactly the ones nothing else would catch.
    let d = ready();
    let before = d.state();
    let now = d.env.ledger().timestamp();

    assert!(d.client().open_epoch());
    let s = d.state();

    assert_eq!(s.round, before.round + 1);
    assert_eq!(s.phase, Phase::Auction);
    assert_eq!(
        s.params,
        valid_params(),
        "the round runs on the params it opened under"
    );
    assert_eq!(
        s.fee_bps_snapshot, 0,
        "D-39: fee fixed at open, not read live at settle"
    );
    assert_eq!(
        s.open_twap, PX_1E7,
        "the number the strike was derived from"
    );
    assert_eq!(
        s.opened_at, now,
        "the curve's origin — `bid` computes now − opened_at"
    );
    // §6: the strike floors, so the error is a lower strike and the bidder gains a stroop.
    assert_eq!(s.strike, PX_1E7 * (10_000 + 300) / 10_000);
    assert_eq!(s.expiry, now + EPOCH);
    assert_eq!(s.auction_end, now + AUCTION);
    assert_eq!(s.notional_offered, before.locked_assets);
    assert_eq!(
        s.locked_at_open, before.locked_assets,
        "I2 is stated against this"
    );
    assert_eq!(s.shares_snapshot, before.shares_outstanding);
    assert_eq!(
        s.feed_decimals, 14,
        "D-68: the scale this round's records are written under"
    );
    assert_eq!(
        (s.notional_sold, s.premium_collected, s.burned_this_round),
        (0, 0, 0)
    );

    // And the fields the list does **not** carry are untouched — that is the other half of
    // "exhaustive", and the half a test usually forgets.
    assert_eq!(s.locked_assets, before.locked_assets);
    assert_eq!(s.shares_outstanding, before.shares_outstanding);
    assert_eq!(s.last_pps, before.last_pps);
    assert_eq!(s.last_settled_spot, before.last_settled_spot);
    assert_eq!(s.pending_deposits_total, before.pending_deposits_total);
    assert_eq!(s.fee_claimable, before.fee_claimable);
}

// =================================================================================================
// Every precondition, driven to reject
// =================================================================================================

fn expect(d: &Deployed, err: Error) {
    assert_eq!(d.client().try_open_epoch().err().unwrap().unwrap(), err);
}

#[test]
fn a_paused_vault_does_not_open_a_round() {
    // Pausable — one of exactly three (§4). Pause stops new risk being written; it never stops a
    // round being closed or a depositor being paid, which is I8.
    let d = ready();
    // `set_paused` is DEV1's and lands with the setters; until it does, the flag is set through
    // storage. A harness affordance, not a call path — and recorded as one rather than left to
    // look like an API (DEV2.md §2.3 asks for exactly that distinction to be written down).
    d.env.as_contract(&d.vault, || {
        let mut c = crate::storage::get_config(&d.env).unwrap();
        c.paused = true;
        crate::storage::set_config(&d.env, &c);
    });
    expect(&d, Error::Paused);
}

#[test]
fn a_live_round_does_not_open_a_second_one() {
    let d = ready();
    assert!(d.client().open_epoch());
    expect(&d, Error::WrongPhase);
}

#[test]
fn the_idle_gap_is_the_guaranteed_exit_window() {
    // D-18: the gap is what a depositor relies on to get out between rounds, so it is a
    // precondition rather than a courtesy.
    let d = deploy();
    let user = d.user(10_000_0000000);
    d.client().deposit(&user, &1_000_0000000);
    d.advance(GAP - 1);
    let now = d.env.ledger().timestamp();
    oracle(&d).fill(&now, &40, &PX);
    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));
    expect(&d, Error::IdleGapNotElapsed);

    d.advance(1);
    let now = d.env.ledger().timestamp();
    oracle(&d).fill(&now, &40, &PX);
    // Re-set the expiry too, and not for tidiness: condition 7 is `expires > now + round_span`,
    // strictly, so an expiry pinned one second earlier fails by exactly that second. The first
    // draft of this test set it before the `advance` and got `InvalidParams` — which is the
    // condition working, and worth leaving documented since a one-second miss reads like a bug in
    // the vault rather than in the fixture.
    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));
    let r = d.client().try_open_epoch();
    assert!(r.is_ok(), "at exactly the gap it opens, got {:?}", r.err());
    assert!(r.unwrap().unwrap(), "and it returns true");
}

#[test]
fn the_idle_gap_comes_from_the_finalized_rounds_snapshot_and_not_from_config() {
    // §15 / D-33. Reading the live copy would let an admin shorten the gap and open immediately,
    // closing a window depositors were relying on. The snapshot is the round that just finalized;
    // `Config.params` governs only before round 1 exists.
    let d = ready();
    assert!(d.client().open_epoch());

    // Put the vault back to Idle with a *long* gap recorded in the round's own snapshot, while
    // Config still carries the short one.
    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.phase = Phase::Idle;
        s.last_finalize_time = d.env.ledger().timestamp();
        s.params.min_idle_gap = 10_000;
        crate::storage::set_state(&d.env, &s);
    });
    d.advance(GAP + 1); // past Config's gap, nowhere near the snapshot's
    expect(&d, Error::IdleGapNotElapsed);
}

#[test]
fn no_shares_is_checked_before_min_fill_or_it_would_be_dead_code() {
    // The normative order, and the reason for it: `shares == 0` implies `locked == 0`, since direct
    // XLM transfers are not counted. So a later shares check could never fire and `NoShares` would
    // be an error nothing can produce.
    let d = deploy();
    d.advance(GAP);
    let now = d.env.ledger().timestamp();
    oracle(&d).fill(&now, &40, &PX);
    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));

    assert_eq!(d.state().shares_outstanding, 0);
    assert_eq!(d.state().locked_assets, 0);
    expect(&d, Error::NoShares);
}

#[test]
fn a_pool_below_min_fill_offers_nothing() {
    let d = deploy();
    let user = d.user(10_000_0000000);
    // Above min_deposit (10 XLM), below min_fill (100 XLM): shares exist, the offer would not.
    d.client().deposit(&user, &50_0000000);
    d.advance(GAP);
    let now = d.env.ledger().timestamp();
    oracle(&d).fill(&now, &40, &PX);
    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));

    assert!(
        d.state().shares_outstanding > 0,
        "shares first, so this is not the NoShares path"
    );
    expect(&d, Error::NothingOffered);
}

#[test]
fn a_pool_of_exactly_min_fill_does_open() {
    // §4 pins this with `locked_assets ≥ min_fill`, and the boundary had no test: the case above
    // deposits 50 XLM against a 100 XLM floor, which is strictly below and says nothing about the
    // edge. `cargo-mutants` found it by flipping `<` to `<=`, under which **the smallest viable
    // vault could never open a round at all** — it would hold exactly enough and be told it had
    // nothing to offer.
    let d = deploy();
    let user = d.user(10_000_0000000);
    let min_fill = valid_params().min_fill;
    d.client().deposit(&user, &min_fill);
    d.advance(GAP);
    let now = d.env.ledger().timestamp();
    oracle(&d).fill(&now, &40, &PX);
    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));

    assert_eq!(
        d.state().locked_assets,
        min_fill,
        "exactly the floor, not a stroop more"
    );
    assert!(d.client().open_epoch(), "and it opens");
    assert_eq!(d.state().notional_offered, min_fill);
}

#[test]
fn a_pool_one_stroop_under_min_fill_does_not() {
    // The other side of the same edge, so the pair pins the comparison rather than one direction
    // of it.
    let d = deploy();
    let user = d.user(10_000_0000000);
    d.client().deposit(&user, &(valid_params().min_fill - 1));
    d.advance(GAP);
    let now = d.env.ledger().timestamp();
    oracle(&d).fill(&now, &40, &PX);
    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));

    expect(&d, Error::NothingOffered);
}

// =================================================================================================
// The live guard ladder — O-2, O-3, O-3d, O-10
// =================================================================================================

#[test]
fn a_stale_feed_does_not_fix_a_strike() {
    // O-2, and live mode only: at close, freshness against `now` is meaningless for frozen history.
    let d = ready();
    d.advance(valid_params().max_staleness + 1);
    expect(&d, Error::OracleStale);
}

#[test]
fn a_sparse_window_is_stale_rather_than_a_void() {
    // O-10. In live mode there is nothing to classify — anything but a price is a revert, and
    // nobody has committed anything, so a retry costs nothing.
    let d = ready();
    oracle(&d).set_mode(&Mode::ForceUnusable);
    expect(&d, Error::OracleStale);
}

/// Force a usable reading with a chosen `newest_ts` and a chosen pair of TWAPs.
///
/// `ForceReading` rather than `fill`, and that is the whole point of these two tests: a *stale*
/// mock feed produces `Unusable`, and `live_reading` maps `Unusable` to `OracleStale` before the
/// staleness line is ever evaluated. Both existing `OracleStale` tests reject through that branch.
fn force_live(d: &Deployed, newest_ts: u64, short_twap: i128, guard_twap: i128) {
    oracle(d).set_mode(&Mode::ForceReading(OracleReading {
        short_twap,
        guard_twap,
        newest_ts,
        feed_decimals: 14,
    }));
}

#[test]
fn the_staleness_guard_rejects_at_its_own_line_and_the_bound_is_strict() {
    // **Found by mutation, 2026-08-20.** `replace > with ==` and `replace > with >=` at
    // `oracle.rs:271` both survived the whole suite, which says nothing about that line's logic and
    // everything about its reachability: `a_stale_feed_does_not_fix_a_strike` lets the mock's
    // records age, so the *adapter* answers `Unusable`, and `live_reading` maps `Unusable` to
    // `OracleStale` at step 1 — several lines above the staleness comparison. **O-2's test was
    // green for a different reason than the one it is named for**, and the guard it is named for
    // had no test at all.
    //
    // Reaching the line needs a reading that is *usable* and *old*, which only `ForceReading` can
    // produce, because a mock stale enough to fail step 2 has already failed rule 2.
    let max = valid_params().max_staleness;

    // Exactly at the bound is fresh enough — the comparison is strict. A `>=` here would refuse a
    // reading precisely as fresh as the parameter permits.
    let d = ready();
    let now = d.env.ledger().timestamp();
    force_live(&d, now - max, PX_1E7, PX_1E7);
    assert!(
        d.client().open_epoch(),
        "an age of exactly max_staleness is admissible; `>` is strict and `>=` would throw a \
         whole second of permitted freshness away"
    );

    // One second past the bound rejects, and it is this line that does it.
    let d = ready();
    let now = d.env.ledger().timestamp();
    force_live(&d, now - max - 1, PX_1E7, PX_1E7);
    expect(&d, Error::OracleStale);

    // **Two cases, not three, and the reason is worth stating.** A "far past the bound" case looks
    // necessary to separate `>` from `==` and is not: the at-bound case above kills *both* mutants
    // on its own, because `>=` and `==` each fire at exactly `max_staleness` where the real guard
    // does not, and that case asserts the round opens. The one-past case then confirms the guard
    // actually rejects rather than merely being strict about nothing. A third case was written
    // first, underflowed the test ledger's clock, and would have added no coverage had it run.
}

#[test]
fn the_deviation_breaker_is_strict_at_its_own_bound() {
    // **Found by mutation, 2026-08-20.** `replace > with >=` at `oracle.rs:297` survived because
    // the existing breaker test sits at a 100 % divergence against a 1 % allowance — far enough
    // past the bound that the bound itself is never exercised. A breaker that fires *at* its
    // threshold rather than past it voids rounds a correctly-configured feed produces.
    let max = i128::from(valid_params().max_deviation_bps);
    let guard = PX_1E7;

    // `deviation = |short − guard| × BPS / guard`, so a gap of `guard × max / BPS` is exactly `max`.
    let at_bound = guard + guard * max / 10_000;
    let d = ready();
    let now = d.env.ledger().timestamp();
    force_live(&d, now, at_bound, guard);
    assert!(
        d.client().open_epoch(),
        "a deviation of exactly max_deviation_bps is admissible; the breaker fires strictly past it"
    );

    // One basis point past. Integer division floors, so the smallest gap that *reports* `max + 1`
    // is `guard × (max + 1) / BPS` — computing it rather than adding one to the gap, which floors
    // straight back to `max` and would have made this test agree with the mutant.
    let past_bound = guard + guard * (max + 1) / 10_000;
    let d = ready();
    let now = d.env.ledger().timestamp();
    force_live(&d, now, past_bound, guard);
    expect(&d, Error::OracleDeviation);
}

#[test]
fn the_deviation_breaker_fires_only_here_and_a_real_move_does_not_trip_it() {
    // O-3 and O-3b. The breaker exists for feed malfunction, not for markets: a single-tick
    // artifact skews the short window hard and the long one barely, while a genuine trend moves
    // both together (D-25). Comparing the two *at the same moment* is what tells them apart.
    let d = ready();
    let anchor = d.env.ledger().timestamp();

    oracle(&d).set_mode(&Mode::ForceReading(OracleReading {
        short_twap: PX_1E7 * 2, // 100 % apart; the profile allows 1 %
        guard_twap: PX_1E7,
        newest_ts: anchor,
        feed_decimals: 14,
    }));
    expect(&d, Error::OracleDeviation);

    // Both windows moved together by the same 100 %: a real market, and it opens.
    oracle(&d).set_mode(&Mode::ForceReading(OracleReading {
        short_twap: PX_1E7 * 2,
        guard_twap: PX_1E7 * 2,
        newest_ts: anchor,
        feed_decimals: 14,
    }));
    assert!(d.client().open_epoch());
    assert_eq!(d.state().strike, PX_1E7 * 2 * 10_300 / 10_000);
}

#[test]
fn a_non_positive_price_is_refused_before_it_can_become_a_zero_strike() {
    // O-3d, and this is the only place `OracleInvalidPrice` is pinned on the open side. A zero
    // here would set `strike = 0`: every bid rejected as in-the-money forever, and a division by
    // zero at settlement.
    let d = ready();
    let anchor = d.env.ledger().timestamp();
    oracle(&d).set_mode(&Mode::ForceReading(OracleReading {
        short_twap: 0,
        guard_twap: PX_1E7,
        newest_ts: anchor,
        feed_decimals: 14,
    }));
    expect(&d, Error::OracleInvalidPrice);
}

#[test]
fn the_coarse_bound_is_skipped_on_the_first_round() {
    // O-8, and it asserts a **skip** rather than a rejection — the phase gate's "every guard has a
    // rejecting test" clause does not reach it, so it is here on its own merits. With
    // `last_settled_spot == 0` there is nothing to compare against, which is why step 3 has to be
    // unconditional.
    let d = ready();
    let anchor = d.env.ledger().timestamp();
    let absurd = PX_1E7 * 1_000;
    oracle(&d).set_mode(&Mode::ForceReading(OracleReading {
        short_twap: absurd,
        guard_twap: absurd,
        newest_ts: anchor,
        feed_decimals: 14,
    }));
    assert_eq!(d.state().last_settled_spot, 0);
    assert!(
        d.client().open_epoch(),
        "no prior settle, so no band to be outside of"
    );
}

#[test]
fn an_unreachable_adapter_surfaces_as_an_error_and_not_as_a_trap() {
    // The wrapper's regression test on the open side: a trapping source must arrive as a typed
    // error, never as a host trap escaping the call.
    let d = ready();
    oracle(&d).set_trap(&true);
    expect(&d, Error::OracleUnreachable);
    oracle(&d).set_trap(&false);
    assert!(d.client().open_epoch());
}

// =================================================================================================
// Condition 7 — the one `open_epoch` alone can reach
// =================================================================================================

#[test]
fn a_feed_whose_sponsorship_will_not_outlive_the_round_cannot_open_one() {
    // O-13f. `validate_params` passes `round_span = 0` and skips this, so the constructor and
    // `set_epoch_params` never see it — which is deliberate, so that a sponsorship shortfall
    // cannot block the very call that repairs it. `open_epoch` is the only caller that asks.
    //
    // It matters because eviction **deletes records that existed at expiry**: an anchored read
    // afterwards finds an empty window and returns `Unusable`, which is the void branch, refunding
    // a bidder in full on a feed that was perfectly healthy when the option was written.
    let d = ready();

    oracle(&d).set_expires(&None);
    expect(&d, Error::InvalidParams);

    let now = d.env.ledger().timestamp();
    oracle(&d).set_expires(&Some(now + ROUND_SPAN));
    expect(&d, Error::InvalidParams);

    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));
    assert!(d.client().open_epoch());
}

#[test]
fn the_span_asked_about_is_the_round_and_not_the_dead_window() {
    // 04-ORACLE §5: the older `+ oracle_dead_after` form is *weaker than the gate*, so a deploy
    // would pass and the first open refuse. A feed funded past the dead window but not past the
    // round must be refused here.
    let d = ready();
    let now = d.env.ledger().timestamp();
    oracle(&d).set_expires(&Some(now + valid_params().oracle_dead_after + 1));
    expect(&d, Error::InvalidParams);
}

#[test]
fn supports_round_is_rechecked_against_the_live_resolution() {
    // The residual I10 names, bounded to one round: a feed that re-times itself makes the round's
    // timing inadmissible, and this is the check that stops the *next* round opening on it.
    let d = ready();
    oracle(&d).set_resolution(&2); // the profile's windows are sized for res = 1
    expect(&d, Error::InvalidParams);
    oracle(&d).set_resolution(&1);
    assert!(d.client().open_epoch());
}

// =================================================================================================
// D-43 and D-38 — the two deadlocks
// =================================================================================================

/// Put the vault in `Auction` with an empty book whose auction window has closed: the exact state
/// `lazy_finalize` lapses.
fn with_a_lapsable_round(d: &Deployed) {
    let now = d.env.ledger().timestamp();
    d.open_round_manually(1, Phase::Auction, now + AUCTION);
    d.advance(AUCTION + 1);
}

#[test]
fn a_failed_open_after_a_lapse_returns_false_and_keeps_the_lapse() {
    // **D-43, and it is the whole reason `open_epoch` returns a bool.** `lazy_finalize` has just
    // finalized a lapsed round; the open then fails on the idle gap. Reverting would roll the
    // finalization back with it and leave the vault in `Auction` with a round it had already
    // closed — which is a deadlock, and it happened.
    let d = ready();
    with_a_lapsable_round(&d);

    // The gap has not elapsed since the lapse, so the open cannot proceed.
    let opened = d.client().open_epoch();
    assert!(!opened, "false rather than a revert");

    let s = d.state();
    assert_eq!(
        s.phase,
        Phase::Idle,
        "the lapse persisted — this is the assertion that matters"
    );
    assert_eq!(s.round, 1, "and no new round was opened");
    assert!(d
        .env
        .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1).is_some()));
}

#[test]
fn without_a_lapse_to_protect_the_same_failure_reverts() {
    // The other arm, and it is what keeps `IdleGapNotElapsed` reachable at all. `false` means "a
    // finalization is being protected", not "the open failed" — conflating the two would make the
    // error an eager keeper meets most into a silent no-op.
    let d = ready();
    assert!(d.client().open_epoch());
    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.phase = Phase::Idle;
        s.last_finalize_time = d.env.ledger().timestamp();
        crate::storage::set_state(&d.env, &s);
    });
    expect(&d, Error::IdleGapNotElapsed);
}

#[test]
fn a_lapse_never_wedges_the_vault_in_auction_and_the_next_round_opens_later() {
    // **The lapse-deadlock regression, and it is D-43's rather than D-38's.**
    //
    // This test asked for the lapse *and* the open in one transaction until 2026-08-19, which asks
    // for D-38 back — a decision marked "dead, do not implement" and superseded by D-43 the same
    // day. It is not reachable and must not be made so: `finalize_round` sets
    // `last_finalize_time = now`, so a lapse taken on the way in resets the idle-gap clock, and
    // `open_epoch`'s own gap check cannot pass in that same call while `min_idle_gap > 0` — which
    // `validate_params` enforces through `in_duration_range`'s flat `d > 0`, not through
    // `min_idle_gap >= epoch_duration / IDLE_GAP_FRACTION`. That distinction matters: the fraction
    // floors to 0 on an epoch shorter than 50, so resting the argument on it would leave an edge
    // where the deadlock returns. Resting it on `d > 0` survives a change to the constant. D-38's fix was to stop a lapse resetting the clock; D-43
    // rejected it, because a vault with no bidders (the expected case during counterparty
    // discovery) would then have had zero idle seconds and nobody could mint, redeem or exit.
    //
    // So there is one behaviour with four assertions, not two arms.
    let d = ready();
    with_a_lapsable_round(&d);

    // 1. The call answers `false` rather than reverting.
    assert!(!d.client().open_epoch(), "false, not a revert");

    // 2. The lapse was not rolled back, and 3. the vault is Idle rather than wedged in Auction —
    //    which is the deadlock this exists to catch.
    let s = d.state();
    assert_eq!(
        s.phase,
        Phase::Idle,
        "the wedge is the bug; Auction here would be it"
    );
    assert_eq!(s.round, 1);
    assert!(d
        .env
        .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1).is_some()));
    let lapsed_at = s.last_finalize_time;
    assert_eq!(
        lapsed_at,
        d.env.ledger().timestamp(),
        "the lapse set the idle clock"
    );

    // 4. And the next round opens on a later call, once the gap has elapsed **from the lapse** —
    //    depositors are owed that window after a lapse exactly as after a settle (D-18).
    d.advance(GAP);
    let now = d.env.ledger().timestamp();
    oracle(&d).fill(&now, &40, &PX);
    oracle(&d).set_expires(&Some(now + ROUND_SPAN + 1));

    assert!(d.client().open_epoch(), "and now it opens");
    let s = d.state();
    assert_eq!(s.phase, Phase::Auction);
    assert_eq!(s.round, 2);
    assert!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1).is_some()),
        "round 1's record survived both calls"
    );
}
