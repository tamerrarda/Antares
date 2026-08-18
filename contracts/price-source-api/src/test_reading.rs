//! The anchored read's arithmetic: the grid, the reach check, normalization and the fold.
//!
//! The cases that matter here are the **routing** ones. Three sources of failure exist and they pay
//! different parties, so misfiling one is a transfer of money (`04-ORACLE.md` §2):
//!
//! | the fault is about… | class | terminal effect |
//! |---|---|---|
//! | the records inside the window | `Unusable` | **void** — bidder refunded in full |
//! | the anchor being older than the feed serves | `OutOfReach` | **unresolved** — depositors keep the premium |
//! | the feed's live configuration | `Err(BadConfig)` | *nothing* — retry, and step 2 bounds the wait |
//!
//! The third row is the one that keeps being misfiled, because it *feels* like a dead feed. It is
//! not: the records are intact, only our ability to derive a grid over them has lapsed, and a feed
//! that re-times itself can re-time itself back. These are the tests that catch a healthy feed
//! being annulled (rows O-15, O-16, O-16b).

use crate::{
    fold, grid, normalize, out_of_reach, AdapterError, ReadResult, Sample, RECORD_CAP_TICKS,
};

const RES: u64 = 300;
const TW: u64 = 900;
const GW: u64 = 3_600;
/// A tick-aligned anchor well clear of the origin, so a fresh-ledger underflow is not what is
/// being tested here — that has its own case below.
const END: u64 = 1_787_000_000 - (1_787_000_000 % RES);

fn sample(px: i128, ts: u64) -> Option<Sample> {
    Some(Sample {
        raw_price: px,
        reported_ts: ts,
    })
}

/// Seven healthy samples at the feed's own scale (`decimals = 14`), all stamped on their slot.
fn healthy(points: &[u64; 7], prices: [i128; 7]) -> [Option<Sample>; 7] {
    let mut out = [None; 7];
    for i in 0..7 {
        out[i] = sample(prices[i], points[i]);
    }
    out
}

// -------------------------------------------------------------------------------------------------
// The grid
// -------------------------------------------------------------------------------------------------

#[test]
fn the_derived_grid_reproduces_the_old_fixed_grid_at_shipped_parameters() {
    // 06-TEST-PLAN §2's adapter assert. Before D-58 the grid ignored its own arguments; the repair
    // has to leave the shipped numbers untouched, or D-48's measured seven-point budget no longer
    // carries forward.
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    assert_eq!(end, END);
    assert_eq!(g[0], END);
    assert_eq!(g[1], END - 300, "short_step = 300 = res");
    assert_eq!(g[2], END - 600);
    assert_eq!(g[3], END - 900, "guard_step = 900 = 3*res");
    assert_eq!(g[4], END - 1_800);
    assert_eq!(g[5], END - 2_700);
    assert_eq!(g[6], END - 3_600);
}

#[test]
fn anchor_zero_means_ending_now_and_snaps_down_to_a_tick() {
    let now = END + 217; // mid-tick
    let (end, g) = grid(RES, 0, now, TW, GW).unwrap();
    assert_eq!(end, END, "snapped down, never up");
    assert_eq!(g[0], END);
}

#[test]
fn every_live_configuration_fault_is_bad_config_and_never_unusable() {
    // O-16, the whole point of the routing rule. Each of these is reachable on a HEALTHY feed after
    // a Reflector tick change, and filing any as `Unusable` annuls the round and refunds the bidder.
    assert_eq!(
        grid(0, END, END, TW, GW),
        Err(AdapterError::BadConfig),
        "res = 0"
    );
    assert_eq!(
        grid(451, END, END, TW, GW),
        Err(AdapterError::BadConfig),
        "res = 451: the short window can no longer hold three ticks — the minimal violation"
    );
    assert_eq!(
        grid(451, END, END, 1_000, 1_800),
        Err(AdapterError::BadConfig),
        "the isolating direction tw < gw < 2*tw, where only the guard rule is violated"
    );
    assert_eq!(
        grid(14, END, END, TW, GW),
        Err(AdapterError::BadConfig),
        "res = 14: guard_window >= R, so reach_limit would underflow"
    );
}

#[test]
fn a_fresh_test_ledger_underflows_into_bad_config_rather_than_wrapping() {
    // The environmental argument — a ledger timestamp is ~1.8e9 while the offsets are bounded by a
    // year — is true of a real network and FALSE here. 02-CONTRACT-SPEC §1's fast-test profiles run
    // second-scale windows against a clock that starts near zero.
    assert_eq!(grid(RES, 600, 600, TW, GW), Err(AdapterError::BadConfig));
}

#[test]
fn an_anchor_in_the_future_is_refused() {
    assert_eq!(
        grid(RES, END + RES, END, TW, GW),
        Err(AdapterError::BadConfig)
    );
}

// -------------------------------------------------------------------------------------------------
// Reach
// -------------------------------------------------------------------------------------------------

#[test]
fn out_of_reach_fires_strictly_past_the_reach_limit() {
    let reach_limit = RECORD_CAP_TICKS * RES - GW; // 72 900
    assert_eq!(reach_limit, 72_900);
    assert_eq!(
        out_of_reach(RES, GW, END + reach_limit, END),
        Ok(false),
        "at the limit, still readable"
    );
    assert_eq!(out_of_reach(RES, GW, END + reach_limit + 1, END), Ok(true));
}

#[test]
fn the_horizon_is_the_larger_of_now_and_last_timestamp() {
    // D-69's second half. A feed that runs ahead of the ledger clock would, under a `now`-only
    // check, let the adapter request an anchor the feed then refuses — a dropped sample, a short
    // count, `Unusable`, and a void on a healthy feed. Taking the larger is never wrong in that
    // direction.
    let reach_limit = RECORD_CAP_TICKS * RES - GW;
    let now = END + reach_limit;
    let last_ahead = now + 1;
    assert_eq!(out_of_reach(RES, GW, now.max(last_ahead), END), Ok(true));
    assert_eq!(out_of_reach(RES, GW, now, END), Ok(false));
}

// -------------------------------------------------------------------------------------------------
// Normalization
// -------------------------------------------------------------------------------------------------

#[test]
fn normalization_floors_downward_from_the_feed_scale() {
    assert_eq!(
        normalize(123_456_789_012_345, 14),
        Some(12_345_678),
        "14 -> 7 divides by 1e7"
    );
    assert_eq!(
        normalize(12_345_678, 7),
        Some(12_345_678),
        "identity at the target scale"
    );
    assert_eq!(
        normalize(1_234, 4),
        Some(1_234_000),
        "the multiplying direction exists too"
    );
    assert_eq!(
        normalize(9_999_999, 14),
        Some(0),
        "a price below one stroop floors to zero"
    );
}

#[test]
fn an_absurd_scale_overflows_into_none_rather_than_wrapping() {
    assert_eq!(
        normalize(1, 46),
        None,
        "the divisor exceeds i128 before any price is touched"
    );
    assert_eq!(
        normalize(i128::MAX, 0),
        None,
        "the multiplying direction is checked"
    );
}

// -------------------------------------------------------------------------------------------------
// The fold
// -------------------------------------------------------------------------------------------------

#[test]
fn seven_healthy_samples_produce_both_medians() {
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    // short slots 0,1,2 -> 3, 1, 2 (median 2); guard slots 0,3,4,5,6 -> 3, 9, 7, 5, 8 (median 7)
    let px = [3, 1, 2, 9, 7, 5, 8].map(|n: i128| n * 10_000_000);
    let r = fold(end, &g, &healthy(&g, px), TW, GW, 7).unwrap();
    let ReadResult::Reading(reading) = r else {
        panic!("expected a reading")
    };
    assert_eq!(reading.short_twap, 2 * 10_000_000);
    assert_eq!(reading.guard_twap, 7 * 10_000_000);
    assert_eq!(
        reading.newest_ts, end,
        "rule 6: the newest timestamp among valid records"
    );
    assert_eq!(reading.feed_decimals, 7);
}

#[test]
fn two_of_three_short_samples_is_unusable_not_a_reading() {
    // D-65 tightened this from "at least two". A median of two has zero outlier resistance, which
    // contradicts the estimator's own justification while still calling the result
    // settlement-grade — and it left the settlement price undefined for an accepted input.
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    let mut s = healthy(&g, [3, 1, 2, 9, 7, 5, 8].map(|n: i128| n * 10_000_000));
    s[2] = None;
    assert_eq!(fold(end, &g, &s, TW, GW, 7), Ok(ReadResult::Unusable));
}

#[test]
fn two_of_five_guard_samples_is_unusable() {
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    let mut s = healthy(&g, [3, 1, 2, 9, 7, 5, 8].map(|n: i128| n * 10_000_000));
    s[4] = None;
    s[5] = None;
    s[6] = None;
    assert_eq!(fold(end, &g, &s, TW, GW, 7), Ok(ReadResult::Unusable));
}

#[test]
fn four_valid_guard_samples_drop_the_furthest_and_match_feeding_those_three_directly() {
    // O-4d. The even-count case never reaches an averaging branch, because none exists.
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    let px = [3, 1, 2, 9, 7, 5, 8].map(|n: i128| n * 10_000_000);

    let mut four = healthy(&g, px);
    four[5] = None; // guard set {0,3,4,6} = 3, 9, 7, 8 — four values, and slot 6 is the furthest
    let r_four = fold(end, &g, &four, TW, GW, 7).unwrap();

    let mut three = healthy(&g, px);
    three[5] = None;
    three[6] = None; // guard set {0,3,4} = 3, 9, 7
    let r_three = fold(end, &g, &three, TW, GW, 7).unwrap();

    assert_eq!(
        r_four, r_three,
        "dropping the furthest must be identical to never having had it"
    );
    let ReadResult::Reading(reading) = r_four else {
        panic!("expected a reading")
    };
    assert_eq!(reading.guard_twap, 7 * 10_000_000);
}

#[test]
fn a_stamp_outside_its_own_window_is_dropped() {
    // O-4b: records out of order, duplicated, or stamped outside the window they were fetched for.
    // The feed's answer is evidence about the moment it *claims*, not about the slot we asked for.
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    let mut s = healthy(&g, [3, 1, 2, 9, 7, 5, 8].map(|n: i128| n * 10_000_000));
    s[1] = sample(10_000_000, end + RES); // stamped after the anchor
    assert_eq!(
        fold(end, &g, &s, TW, GW, 7),
        Ok(ReadResult::Unusable),
        "short count falls to 2"
    );
}

#[test]
fn a_non_positive_record_is_a_record_fault_and_is_dropped() {
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    let mut s = healthy(&g, [3, 1, 2, 9, 7, 5, 8].map(|n: i128| n * 10_000_000));
    s[1] = sample(0, g[1]);
    assert_eq!(fold(end, &g, &s, TW, GW, 7), Ok(ReadResult::Unusable));
}

#[test]
fn every_surviving_sample_normalizing_to_zero_is_a_scale_fault_not_a_dead_window() {
    // Rule 5. A `decimals` large enough to floor every price to zero is a fact about the feed's
    // configuration — `Transient` — and the round settles normally once the feed restores it.
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    let s = healthy(&g, [1; 7]);
    assert_eq!(fold(end, &g, &s, TW, GW, 30), Err(AdapterError::BadConfig));
}

#[test]
fn one_zeroing_sample_among_many_is_an_ordinary_bad_print() {
    // An earlier draft escalated a SINGLE zeroing sample to a whole-read config fault, which handed
    // one malformed tick the power to push a round to `Unresolved` and burn an in-the-money
    // bidder's payout — the precise outlier sensitivity D-42 chose the median to remove.
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    let mut px = [3, 1, 2, 9, 7, 5, 8].map(|n: i128| n * 10_000_000);
    px[5] = 1; // normalizes to 0 at decimals = 14
    let s = healthy(&g, px);
    let r = fold(end, &g, &s, TW, GW, 14);
    assert!(
        matches!(r, Ok(ReadResult::Reading(_))),
        "dropped like any other bad print, got {r:?}"
    );
}

#[test]
fn an_empty_window_is_unusable_and_never_bad_config() {
    // The vacuous-truth case. "Every sample normalized to zero" is true of the empty set, and a rule
    // phrased that way would route the clearest dead-window case — the canonical void — to
    // `Transient`. If no raw-valid sample survived there is nothing to say about the scale.
    let (end, g) = grid(RES, END, END, TW, GW).unwrap();
    assert_eq!(
        fold(end, &g, &[None; 7], TW, GW, 30),
        Ok(ReadResult::Unusable)
    );
}
