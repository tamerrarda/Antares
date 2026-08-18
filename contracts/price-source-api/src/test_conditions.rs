//! `supports_round`'s eight conditions, driven one at a time.
//!
//! **Every rejection here is paired with a repair.** A test that only asserts `false` proves the
//! function rejects *something*; what the Phase-2 gate asks for is that each independently violable
//! condition can be driven false **for its own reason** (`00-ROADMAP.md` Phase 2,
//! `06-TEST-PLAN.md` §2, O-13). So each case fixes exactly the one input under test and asserts the
//! same parameter set then passes — which is what rules out the rejection having come from
//! somewhere else.
//!
//! Two conditions have no case, for two *different* reasons, and 04-ORACLE §2 records both so that
//! neither absence reads as an oversight. **Condition 5** is implied by condition 4 and can never
//! be the sole cause of a rejection — there is no input to write. **Condition 0** is not
//! independently violable either; the live-configuration faults it describes are reachable inside
//! `reading()` and are tested there (rows O-16/O-16b). Writing a case for either would repeat the
//! unconstructible-test defect D-68 cleaned out.
//!
//! These are the unit-level tests of the shared evaluator. The **contract-level** matrix — the same
//! conditions driven through `MockPriceSource` on the vault's constructor *and* on
//! `set_epoch_params` — is Phase 2's gate and lands with the vault.

use crate::{supports_round, RECORD_CAP_TICKS};

/// `02-CONTRACT-SPEC.md` §1's shipped table, instance A.
const RES: u64 = 300;
const TW: u64 = 900;
const GW: u64 = 3_600;
const ODA: u64 = 43_200;
const SG: u64 = 7_200;
const UA: u64 = 75_600;
const NOW: u64 = 1_787_000_000;

/// The shipped set, with condition 7 skipped — the shape `validate_params` calls with.
fn shipped() -> bool {
    supports_round(RES, TW, GW, ODA, SG, UA, 0, None, NOW)
}

#[allow(clippy::too_many_arguments)]
fn with(res: u64, tw: u64, gw: u64, oda: u64, sg: u64, ua: u64) -> bool {
    supports_round(res, tw, gw, oda, sg, ua, 0, None, NOW)
}

fn reach_limit(res: u64, gw: u64) -> u64 {
    RECORD_CAP_TICKS * res - gw
}

// -------------------------------------------------------------------------------------------------
// The baseline, and the numbers D-69 moved
// -------------------------------------------------------------------------------------------------

#[test]
fn the_shipped_parameter_set_is_admissible() {
    assert!(
        shipped(),
        "02-CONTRACT-SPEC §1's shipped table must satisfy its own on-chain gate"
    );
}

#[test]
fn reach_limit_is_255_ticks_minus_the_guard_window() {
    // D-69: the bitmask holds 256 records, which span 255 intervals, and R is a depth. Measured
    // against the live feed 2026-08-19. This test is what stops the constant drifting back.
    assert_eq!(RECORD_CAP_TICKS, 255);
    assert_eq!(reach_limit(RES, GW), 72_900);
    assert_eq!(RECORD_CAP_TICKS * RES, 76_500);
}

#[test]
fn the_admissible_unresolved_after_band_is_exactly_conditions_3_and_6() {
    let rl = reach_limit(RES, GW);
    assert!(
        !with(RES, TW, GW, ODA, SG, rl),
        "condition 3 is strict: ua == reach_limit rejects"
    );
    assert!(
        with(RES, TW, GW, ODA, SG, rl + 1),
        "one second above reach_limit is the floor"
    );
    assert!(
        with(RES, TW, GW, ODA, SG, rl + SG),
        "reach_limit + settle_grace is the ceiling, inclusive"
    );
    assert!(
        !with(RES, TW, GW, ODA, SG, rl + SG + 1),
        "one second above the ceiling rejects"
    );
    assert_eq!((rl, rl + SG), (72_900, 80_100));
}

#[test]
fn the_shipped_table_is_writable_only_for_resolutions_283_to_310() {
    // D-68's band, re-derived by D-69. `verify-environment.ts` E-11 reports the same interval from
    // the live resolution, and the two agreeing is the point: one is the contract's arithmetic,
    // the other is a script's, and a drift between them is a finding.
    let mut lo = 0;
    let mut hi = 0;
    let mut count = 0;
    for r in 1..=500 {
        if with(r, TW, GW, ODA, SG, UA) {
            if lo == 0 {
                lo = r;
            }
            hi = r;
            count += 1;
        }
    }
    assert_eq!((lo, hi), (283, 310));
    // Contiguous — a hole would mean two conditions crossing in a way nobody predicted.
    assert_eq!(count, hi - lo + 1);
}

// -------------------------------------------------------------------------------------------------
// Each independently violable condition, driven false for its own reason
// -------------------------------------------------------------------------------------------------

#[test]
fn condition_1_the_short_window_cannot_hold_three_ticks() {
    // One second below 2*res, everything else shipped.
    assert!(!with(RES, 2 * RES - 1, GW, ODA, SG, UA));
    assert!(
        with(RES, 2 * RES, GW, ODA, SG, UA),
        "repaired at exactly 2*res"
    );
}

#[test]
fn condition_1_the_guard_window_cannot_hold_five_ticks() {
    // Isolating this one takes more care than the short-window case, and the first attempt at this
    // test got it wrong in a way worth keeping as a comment: the guard window appears in conditions
    // 2, 3, 4 and 6 as well, so moving it moves reach_limit, the realized spans and the admissible
    // `unresolved_after` band all at once. A set that "only" violates condition 1 has to be built
    // deliberately rather than borrowed from the shipped table.
    //
    // Here: res 200 (R = 51 000), a short window at exactly 2*res so its realized span is 400
    // against the guard's 800 — which keeps condition 2 satisfied — and oracle_dead_after pulled
    // down to 20 000 so condition 4 has room inside the smaller R.
    let res = 200;
    let tw = 2 * res; // 400
    let oda = 20_000;

    let narrow = 4 * res - 1; // 799 — one second short of five distinct ticks
    let rl_narrow = RECORD_CAP_TICKS * res - narrow;
    assert!(!with(res, tw, narrow, oda, SG, rl_narrow + 1));

    let ok = 4 * res; // 800
    let rl_ok = RECORD_CAP_TICKS * res - ok;
    assert!(
        with(res, tw, ok, oda, SG, rl_ok + 1),
        "repaired at exactly 4*res"
    );
}

#[test]
fn condition_2_compares_realized_spans_and_not_the_arguments() {
    // O-13's worked counter-example. Both of these pass `guard_window > twap_window`, which is what
    // the vault checks; the second fails on the spans the breaker actually compares.
    let tw = 3_000;
    let gw = 3_100;
    assert!(
        gw > tw,
        "the argument-level rule this case exists to defeat"
    );
    let rl = RECORD_CAP_TICKS * RES - gw;
    assert!(
        !with(RES, tw, gw, ODA, SG, rl + 1),
        "spans 2400 vs 3000 — the guard is the shorter side"
    );
    // Repair by widening the guard so its realized span clears the short one.
    let gw_ok = 12_000;
    let rl_ok = RECORD_CAP_TICKS * RES - gw_ok;
    assert!(with(RES, tw, gw_ok, ODA, SG, rl_ok + 1));
}

#[test]
fn condition_3_is_strict_at_the_boundary() {
    // O-13b. `unresolved_after == reach_limit` is the one-second disagreement between the fallback
    // and a working adapter that the strict `>` exists to remove.
    let rl = reach_limit(RES, GW);
    assert!(!with(RES, TW, GW, ODA, SG, rl));
    assert!(with(RES, TW, GW, ODA, SG, rl + 1));
}

#[test]
fn condition_4_bounds_the_dead_window_inside_the_reachable_depth() {
    let oda = 70_000; // 70000 + 3600 + 7200 = 80800 >= 76500
    assert!(!with(RES, TW, GW, oda, SG, UA));
    assert!(
        with(RES, TW, GW, ODA, SG, UA),
        "repaired by the shipped oracle_dead_after"
    );
}

#[test]
fn condition_4_rejects_before_the_subtraction_that_would_underflow() {
    // O-13d. `guard_window` of one year against R = 76 500: `R - guard_window` underflows, and the
    // ordering rule is what stops it being reached. This tests the ORDER, not the checked
    // arithmetic — no input surviving condition 4 can still underflow.
    let one_year = 31_536_000;
    assert!(!with(RES, TW, one_year, ODA, SG, UA));
}

#[test]
fn condition_6_is_a_ceiling() {
    // O-13c. Without it `set_epoch_params` could push the oracle-free terminal path out until it
    // never fired.
    let rl = reach_limit(RES, GW);
    assert!(!with(RES, TW, GW, ODA, SG, rl + SG + 1));
    assert!(with(RES, TW, GW, ODA, SG, rl + SG));
}

#[test]
fn condition_7_is_skipped_at_round_span_zero_and_enforced_above_it() {
    // O-13f. `validate_params` passes 0 so a sponsorship shortfall can never block the very call
    // that repairs it; `open_epoch` passes epoch_duration + unresolved_after and enforces it.
    let span = 604_800 + UA;

    assert!(
        supports_round(RES, TW, GW, ODA, SG, UA, 0, None, NOW),
        "round_span == 0 skips condition 7 even with no expiry at all"
    );
    assert!(
        !supports_round(RES, TW, GW, ODA, SG, UA, span, None, NOW),
        "a None expiry is an unfunded feed"
    );
    assert!(
        !supports_round(RES, TW, GW, ODA, SG, UA, span, Some(NOW + span), NOW),
        "expiry exactly at the deadline is not strictly beyond it"
    );
    assert!(supports_round(
        RES,
        TW,
        GW,
        ODA,
        SG,
        UA,
        span,
        Some(NOW + span + 1),
        NOW
    ));
}

#[test]
fn condition_7_uses_the_full_round_span_and_not_the_dead_window() {
    // 04-ORACLE §5: the older `+ oracle_dead_after` form is *weaker than the gate*, so a deploy
    // would pass and the first open_epoch refuse. A feed funded past `now + oracle_dead_after` but
    // not past `now + epoch_duration + unresolved_after` must be refused here.
    let span = 604_800 + UA;
    assert!(!supports_round(
        RES,
        TW,
        GW,
        ODA,
        SG,
        UA,
        span,
        Some(NOW + ODA + 1),
        NOW
    ));
}

// -------------------------------------------------------------------------------------------------
// Totality — the rule that this function returns `false`, never a panic
// -------------------------------------------------------------------------------------------------

#[test]
fn condition_0_rejects_a_zero_resolution_without_dividing_by_it() {
    assert!(!with(0, TW, GW, ODA, SG, UA));
}

#[test]
fn no_input_can_make_it_panic() {
    // The vault's validation bounds every duration to one year, but `supports_round` is a public
    // contract function and the vault's call pattern is not a guarantee about every caller.
    let extremes = [0u64, 1, 2, RES, u64::MAX / 2, u64::MAX - 1, u64::MAX];
    for &res in &extremes {
        for &d in &extremes {
            // Whatever it returns, it returns — the assertion is that control reaches here.
            let _ = supports_round(res, d, d, d, d, d, d, Some(d), d);
            let _ = supports_round(res, d, d, d, d, d, 0, None, d);
        }
    }
}

#[test]
fn a_now_plus_round_span_overflow_rejects_rather_than_wrapping() {
    assert!(!supports_round(
        RES,
        TW,
        GW,
        ODA,
        SG,
        UA,
        u64::MAX,
        Some(u64::MAX),
        u64::MAX
    ));
}

// -------------------------------------------------------------------------------------------------
// The fast-test profile — the obligation 04-ORACLE §2 attaches to "no reject switch"
// -------------------------------------------------------------------------------------------------

#[test]
fn the_fast_test_profile_passes_all_eight_conditions_at_the_mocks_default_resolution() {
    // 02-CONTRACT-SPEC §1 is the single home for what a fast-test profile is, and its worked set
    // rests on `mock.resolution()` defaulting to 1 second. The mock has no reject switch, so the
    // profile has to pass on its merits — and if it did not, that sentence in 04-ORACLE §2 would be
    // false. This is the test that keeps it honest.
    //
    // The worked set moves with D-69: at res = 1, reach_limit is 255 - 20 = 235, so
    // `unresolved_after` lands in (235, 245] rather than the (236, 246] printed before the cap was
    // measured.
    let (res, tw, gw, sg, oda) = (1, 10, 20, 10, 60);
    assert_eq!(reach_limit(res, gw), 235);
    assert!(!with(res, tw, gw, oda, sg, 235), "the floor is exclusive");
    assert!(with(res, tw, gw, oda, sg, 236));
    assert!(with(res, tw, gw, oda, sg, 245));
    assert!(
        !with(res, tw, gw, oda, sg, 246),
        "the ceiling is 235 + settle_grace"
    );

    // And with condition 7 in play, which is the one the worked set cannot settle on its own
    // because it depends on epoch_duration and the mock's expires().
    let epoch_duration = 60;
    let ua = 240;
    let span = epoch_duration + ua;
    assert!(supports_round(
        res,
        tw,
        gw,
        oda,
        sg,
        ua,
        span,
        Some(NOW + span + 1),
        NOW
    ));
    assert!(
        !supports_round(res, tw, gw, oda, sg, ua, span, Some(NOW + span), NOW),
        "a mock whose expires() answers too early makes open_epoch refuse and stalls the harness"
    );
}

#[test]
fn a_second_scale_profile_cannot_be_constructed_against_a_300_second_tick() {
    // The other half of §1's definition: a fast-test profile is deployed against the mock and
    // never against Reflector, and this is *why* rather than a convenience. At res = 300 condition
    // 1 alone forces twap_window >= 600.
    assert!(!with(300, 10, 20, 60, 10, 236));
}
