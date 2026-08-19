//! The anchored guard ladder, every branch forced through `MockPriceSource`.
//!
//! **The four `GuardOutcome` values partition the branches exhaustively**, and that is what I10
//! rests on: `close_round` is one `match` over them behind one time check, so "at most one
//! terminal outcome, always reachable" is a property of the shape of the code. A test suite that
//! reached only three of the four would leave the fourth an assumption.
//!
//! Every case below is a *classification* assertion, not an arithmetic one. The arithmetic is
//! tested once in `price-source-api`, where both sources call it. What is tested here is the thing
//! that decides who gets paid: whether a given failure is read as a fact about the **expiry
//! window** — evidence a round may be annulled on — or a fact about **now**, which is not.

use crate::oracle::{anchored_reading, live_reading, spot_check, supports_round, GuardOutcome};
use crate::types::{EpochParams, VoidReason};
use crate::Error;
use mock_price_source::{MockPriceSource, MockPriceSourceClient, Mode};
use price_source_api::OracleReading;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

const RES: u32 = 300;
const DEC: u32 = 14;
/// A multiple of the shipped tick, so no assertion carries a snapping offset.
const ANCHOR: u64 = 1_786_999_800;
/// 0.16 USD at `decimals = 14`.
const PX: i128 = 16_000_000_000_000;
/// The same price after normalization to 1e7 — what the ladder should hand back.
const PX_1E7: i128 = 1_600_000;
const TW: u64 = 900;
const GW: u64 = 3_600;

struct F<'a> {
    env: Env,
    mock: MockPriceSourceClient<'a>,
    oracle: Address,
}

fn setup() -> F<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(ANCHOR);
    let admin = Address::generate(&env);
    let oracle = env.register(MockPriceSource, (admin, DEC));
    let mock = MockPriceSourceClient::new(&env, &oracle);
    mock.set_resolution(&RES);
    mock.fill(&ANCHOR, &20, &PX);
    F { mock, oracle, env }
}

/// The shipped call shape: anchored at expiry, opened under `DEC`, no prior settle.
fn read(f: &F) -> GuardOutcome {
    anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC, 0)
}

// =================================================================================================
// All four outcomes are reachable — the exhaustiveness I10 rests on
// =================================================================================================

#[test]
fn a_healthy_anchored_read_is_a_price_carrying_the_scale_it_was_normalized_from() {
    let f = setup();
    assert_eq!(read(&f), GuardOutcome::Price(PX_1E7, DEC));
}

#[test]
fn an_unusable_window_is_evidence_about_expiry_and_reaches_the_void_branch() {
    // O-4. A fact about frozen history: the feed had nothing usable at that moment and never will.
    // This is the canonical void, and the only kind of evidence a round may be annulled on.
    let f = setup();
    f.mock.set_mode(&Mode::ForceUnusable);
    assert_eq!(
        read(&f),
        GuardOutcome::DeadAtExpiry(VoidReason::FeedUnusable)
    );

    // And the honest route to the same place: one missing tick in the short window (D-65).
    f.mock.set_mode(&Mode::Normal);
    f.mock.clear_price(&(ANCHOR - 300));
    assert_eq!(
        read(&f),
        GuardOutcome::DeadAtExpiry(VoidReason::FeedUnusable)
    );
}

#[test]
fn an_aged_out_anchor_is_out_of_reach_and_never_the_void_branch() {
    // O-12, the regression test for the eighteen-hour free option. `OutOfReach` and `Unusable` are
    // opposites: one says the feed was dead at that moment, the other says we can no longer see
    // that moment. Returning a bare `None` for both is what let a healthy feed produce a void
    // eighteen hours after expiry and refund an out-of-the-money bidder his entire premium for
    // doing nothing (D-59).
    let f = setup();
    f.mock.set_mode(&Mode::ForceOutOfReach);
    assert_eq!(read(&f), GuardOutcome::OutOfReach);

    // The honest route: reach_limit = 255*300 − 3600 = 72 900 (D-69).
    f.mock.set_mode(&Mode::Normal);
    f.env.ledger().set_timestamp(ANCHOR + 72_901);
    assert_eq!(read(&f), GuardOutcome::OutOfReach);
    f.env.ledger().set_timestamp(ANCHOR + 72_900);
    assert_eq!(
        read(&f),
        GuardOutcome::Price(PX_1E7, DEC),
        "at the limit, still readable"
    );
}

#[test]
fn a_trapping_adapter_is_transient_and_must_not_permit_the_void_path() {
    // O-3c, and it is the sharpest of the four. A trap is a fact about **this ledger**, not about
    // the expiry window, so it must never be admissible as evidence for annulment. Before D-60 it
    // was: a single congested ledger past the grace period could void a settleable round.
    let f = setup();
    f.mock.set_trap(&true);
    let outcome = read(&f);
    assert_eq!(outcome, GuardOutcome::Transient);
    assert!(
        !matches!(outcome, GuardOutcome::DeadAtExpiry(_)),
        "a trap must never reach the void branch — that is the whole of D-60"
    );

    // And it clears. `Transient` blocks all three evidence-based paths and the round closes
    // normally once the fault goes away — which is the property the classification exists for.
    f.mock.set_trap(&false);
    assert_eq!(read(&f), GuardOutcome::Price(PX_1E7, DEC));
}

/// A source that answers `reading` with the wrong type. It exists because the conversion arm
/// cannot otherwise be reached: through a typed `#[contracttrait]` client every honest
/// implementation returns a `ReadResult` by construction, so the only way to hand the vault
/// something undecodable is to put a *different contract* at the oracle address.
///
/// The arity and the name match the trait deliberately. A wrong name or a wrong argument count
/// fails in the host before any conversion is attempted and lands in `Err(..)` — the trap arm,
/// which O-3c already covers. Only a correct call whose *return value* is the wrong shape reaches
/// `Ok(Err(conversion))`, and that is the arm O-3f is about.
///
/// `#[contractimpl]` exports survive linking, so this would leak into a shipped wasm if it lived
/// anywhere but a test — `test_oracle` is `#[cfg(test)]`, which is what keeps it out.
#[contract]
struct UndecodableSource;

#[contractimpl]
impl UndecodableSource {
    pub fn reading(_env: Env, _anchor: u64, _short_window: u64, _guard_window: u64) -> u32 {
        7
    }
}

#[test]
fn a_return_value_that_does_not_decode_is_transient_exactly_like_a_trap() {
    // O-3f. `Ok(Err(conversion))` and `Err(..)` are the same fact about **now** (D-64), and the
    // ladder is written to fold them into one arm rather than to distinguish them. The risk this
    // pins is not that the conversion arm is misclassified today — it is that it looks like a
    // formality next to the trap arm and gets given its own, more specific, treatment later. A
    // garbled return is not evidence about the expiry window, and nothing about it may reach the
    // void branch.
    let f = setup();
    f.env.register_at(&f.oracle, UndecodableSource, ());

    let outcome = read(&f);
    assert_eq!(
        outcome,
        GuardOutcome::Transient,
        "an undecodable answer is a fact about now, not about expiry"
    );
    assert!(
        !matches!(outcome, GuardOutcome::DeadAtExpiry(_)),
        "the void path must be unreachable here for the same reason it is under a trap"
    );

    // Byte-for-byte the trap's classification, which is the row's actual claim: not merely that
    // both are non-fatal, but that the vault cannot tell them apart.
    let g = setup();
    g.mock.set_trap(&true);
    assert_eq!(outcome, read(&g), "identical to a trap, not merely similar");

    // The above is exactly the assertion that could pass for the wrong reason: both arms fold into
    // `Transient`, so a test that reached the *trap* arm here would be indistinguishable from one
    // that reached the conversion arm. Which arm fires was therefore measured rather than reasoned
    // about — the two arms were split and made to panic distinctly, and this test stopped at
    // `oracle.rs:101` (`Ok(Err(_))`) while `a_trapping_adapter_..` stopped at `oracle.rs:102`
    // (`Err(_)`). If those two ever collapse onto one arm, this comment is the thing that is wrong,
    // not the test.
}

// =================================================================================================
// The two steps that exist because the vault does not trust the adapter
// =================================================================================================

#[test]
fn a_non_positive_aggregate_is_a_dead_feed_at_expiry_not_a_transient_fault() {
    // Step 3, unconditional and before any division. The adapter filters non-positive *records*,
    // but nothing guarantees the returned aggregate is positive — a correct source cannot produce
    // one, which is exactly why the mock has to be able to lie for this branch to be reachable at
    // all. Without the check a zero price makes `strike = 0`: every bid rejected as in the money,
    // forever, and a division by zero at settlement.
    //
    // Records that exist but are nonsense are still a dead feed at expiry. If the void branch
    // refused them the round would drift to `Unresolved` and hand depositors the premium — which
    // is depositors profiting from an oracle failure, and D-51 forbids it.
    let f = setup();
    for (short, guard) in [(0i128, PX_1E7), (PX_1E7, 0), (-1, PX_1E7)] {
        f.mock.set_mode(&Mode::ForceReading(OracleReading {
            short_twap: short,
            guard_twap: guard,
            newest_ts: ANCHOR,
            feed_decimals: DEC,
        }));
        assert_eq!(
            read(&f),
            GuardOutcome::DeadAtExpiry(VoidReason::InvalidPrice),
            "short {short}, guard {guard}"
        );
    }
}

#[test]
fn the_coarse_bound_rejects_a_hundredfold_move_and_is_skipped_on_round_one() {
    // O-8 asserts the *skip*, which is not a rejection — Phase 2's "every guard has a rejecting
    // test" clause does not reach it, so it is listed on its own merits.
    let f = setup();
    let absurd = OracleReading {
        short_twap: PX_1E7 * 1_000,
        guard_twap: PX_1E7 * 1_000,
        newest_ts: ANCHOR,
        feed_decimals: DEC,
    };
    f.mock.set_mode(&Mode::ForceReading(absurd.clone()));

    // Round 1: last_settled_spot == 0, nothing to compare against, so the bound is skipped and the
    // absurd price is accepted. That is correct and it is why step 3 is unconditional.
    assert_eq!(
        anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC, 0),
        GuardOutcome::Price(PX_1E7 * 1_000, DEC)
    );

    // With a prior settle it rejects — in both directions.
    assert_eq!(
        anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC, PX_1E7),
        GuardOutcome::DeadAtExpiry(VoidReason::InvalidPrice)
    );
    f.mock.set_mode(&Mode::ForceReading(OracleReading {
        short_twap: PX_1E7 / 1_000,
        guard_twap: PX_1E7,
        newest_ts: ANCHOR,
        feed_decimals: DEC,
    }));
    assert_eq!(
        anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC, PX_1E7),
        GuardOutcome::DeadAtExpiry(VoidReason::InvalidPrice)
    );

    // And the boundary is inclusive at exactly 100×, which is what "outside the band" means.
    for boundary in [PX_1E7 * 100, PX_1E7 / 100] {
        f.mock.set_mode(&Mode::ForceReading(OracleReading {
            short_twap: boundary,
            guard_twap: PX_1E7,
            newest_ts: ANCHOR,
            feed_decimals: DEC,
        }));
        assert_eq!(
            anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC, PX_1E7),
            GuardOutcome::Price(boundary, DEC),
            "exactly 100x is inside the band"
        );
    }
}

// =================================================================================================
// Step 1c — the scale the round was opened under
// =================================================================================================

#[test]
fn a_scale_change_since_open_is_transient_and_not_a_void() {
    // O-4c. Asserting "both reads normalize correctly" was D-28's rule and is now wrong: the
    // records inside the window were written under the old scale, so a live re-read *rescales*
    // history rather than reading it.
    //
    // Transient, not `DeadAtExpiry`, because a re-scaled feed is a fact about now — the round
    // retries and settles normally if the feed reverts, and reaches `Unresolved` through
    // `close_round`'s step 2 if it does not.
    let f = setup();
    assert_eq!(read(&f), GuardOutcome::Price(PX_1E7, DEC));

    f.mock.set_decimals(&(DEC + 1));
    let outcome = anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC, 0);
    assert_eq!(outcome, GuardOutcome::Transient);
    assert!(!matches!(outcome, GuardOutcome::DeadAtExpiry(_)));

    f.mock.set_decimals(&DEC);
    assert_eq!(
        read(&f),
        GuardOutcome::Price(PX_1E7, DEC),
        "reverts and settles"
    );
}

#[test]
fn a_small_scale_change_would_otherwise_settle_at_a_price_wrong_by_ten() {
    // The case that makes step 1c load-bearing rather than tidy. A *large* decimals change floors
    // every price to zero and the adapter already routes that to a config fault. A change of one
    // floors nothing: it produces a price wrong by exactly 10×, and step 5's coarse 100× bound
    // admits that range happily. The round would settle at a wrong price, which is worse than any
    // void — and equality against the round's own snapshot is what separates the cases, where no
    // fixed numeric ceiling could (D-68).
    let f = setup();
    let ten_times_wrong = OracleReading {
        short_twap: PX_1E7 * 10,
        guard_twap: PX_1E7 * 10,
        feed_decimals: DEC - 1, // a scale one step from the round's
        newest_ts: ANCHOR,
    };
    f.mock.set_mode(&Mode::ForceReading(ten_times_wrong));

    // The coarse bound would wave it through …
    assert_eq!(
        anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC - 1, PX_1E7),
        GuardOutcome::Price(PX_1E7 * 10, DEC - 1),
        "100x band admits a 10x error; the bound is not what catches this"
    );
    // … and step 1c is what does not.
    assert_eq!(
        anchored_reading(&f.env, &f.oracle, ANCHOR, TW, GW, DEC, PX_1E7),
        GuardOutcome::Transient
    );
}

// =================================================================================================
// What anchored mode deliberately does NOT do
// =================================================================================================

#[test]
fn anchored_mode_applies_no_staleness_bound() {
    // The counterpart to O-2, which is `open_epoch` only. Freshness relative to `now` is
    // meaningless against frozen history: the adapter has already proved enough records exist
    // inside the window. A round left unclosed for hours still settles at the same price.
    let f = setup();
    f.env.ledger().set_timestamp(ANCHOR + 60_000); // far past any max_staleness
    assert_eq!(
        read(&f),
        GuardOutcome::Price(PX_1E7, DEC),
        "still readable, still the same price"
    );
}

#[test]
fn anchored_mode_applies_no_deviation_breaker() {
    // O-3's closing clause. A breaker here could only ever convert a settleable round into a void,
    // because a frozen window cannot recover from a rejection — which is the exact confiscation
    // D-25 exists to prevent, reintroduced through the back door. The artifact resistance now
    // lives in the estimator: a median is unmoved by one outlier in three (D-42).
    let f = setup();
    f.mock.set_mode(&Mode::ForceReading(OracleReading {
        short_twap: PX_1E7,
        guard_twap: PX_1E7 * 3, // a 200 % divergence; open_epoch would revert OracleDeviation
        newest_ts: ANCHOR,
        feed_decimals: DEC,
    }));
    assert_eq!(
        read(&f),
        GuardOutcome::Price(PX_1E7, DEC),
        "the close settles anyway"
    );
}

#[test]
fn every_caller_at_every_moment_computes_the_same_price() {
    // D-40's headline property, which is what makes a permissionless settlement function safe: the
    // party the current price favours cannot call at the moment that suits them, because the
    // moment does not enter the answer. Called from three different times, the anchored read is
    // identical.
    //
    // The precondition I10 names — that the feed does not re-time its own grid mid-round — is
    // exercised separately by O-14 in the adapter's suite; here the resolution is held fixed,
    // which is the case this property is stated for.
    let f = setup();
    let first = read(&f);
    f.env.ledger().set_timestamp(ANCHOR + 3_600);
    let second = read(&f);
    f.env.ledger().set_timestamp(ANCHOR + 40_000);
    let third = read(&f);
    assert_eq!(first, second);
    assert_eq!(second, third);
    assert_eq!(first, GuardOutcome::Price(PX_1E7, DEC));
}

// =================================================================================================
// The two wrappers
// =================================================================================================

#[test]
fn spot_check_answers_none_on_every_failure_and_never_a_price() {
    // Failures here become `OracleUnreachable` at the bid site and **never** `InTheMoney`. The
    // keeper counts those two separately, and only genuine no-bid epochs advance the stop gate, so
    // conflating them would corrupt the one measurement the project's continuation depends on.
    let f = setup();
    assert_eq!(spot_check(&f.env, &f.oracle, 600, DEC), Some(PX_1E7));

    assert_eq!(
        spot_check(&f.env, &f.oracle, 600, DEC + 1),
        None,
        "a mismatched scale (O-4e)"
    );

    f.mock.set_trap(&true);
    assert_eq!(
        spot_check(&f.env, &f.oracle, 600, DEC),
        None,
        "a trapping source"
    );
    f.mock.set_trap(&false);

    f.env.ledger().set_timestamp(ANCHOR + 901);
    assert_eq!(
        spot_check(&f.env, &f.oracle, 600, DEC),
        None,
        "past the caller's budget plus a tick"
    );
}

#[test]
fn spot_check_refuses_a_non_positive_tick_rather_than_returning_it_as_a_spot() {
    // The predicate that separates this wrapper from a plausible-looking one, and it is not
    // hypothetical: DEV3 wrote a second `spot_check` inline in `auction.rs` — their branch never
    // had `oracle.rs` on it — and theirs accepts a non-positive price **as a spot**. A zero or
    // negative tick then compares as `spot < strike` and walks straight through the in-the-money
    // guard, which is the one thing that guard exists to stop.
    //
    // They are deleting theirs and calling this. Pinning the predicate here first, so that if their
    // three refusal cases ever fail against this function the failure is a finding in my seam
    // rather than in their fix.
    let f = setup();
    assert_eq!(
        spot_check(&f.env, &f.oracle, 600, DEC),
        Some(PX_1E7),
        "the baseline answers"
    );

    for bad in [0i128, -1] {
        f.mock.set_price(&ANCHOR, &bad);
        assert_eq!(
            spot_check(&f.env, &f.oracle, 600, DEC),
            None,
            "a tick of {bad} is not a price, and must never reach the ITM comparison"
        );
    }
}

#[test]
fn supports_round_surfaces_a_trapping_source_as_false_and_never_as_a_host_trap() {
    // O-13e. This is called from the vault's constructor: a trap escaping here arrives as a host
    // trap rather than `InvalidParams`, and the vault cannot be registered at all. The source is
    // also written not to trap; this wrapper does not depend on that, which is the point of it.
    let f = setup();
    assert!(supports_round(
        &f.env, &f.oracle, TW, GW, 43_200, 7_200, 75_600, 0
    ));

    f.mock.set_trap(&true);
    assert!(!supports_round(
        &f.env, &f.oracle, TW, GW, 43_200, 7_200, 75_600, 0
    ));

    f.mock.set_trap(&false);
    // And a genuine rejection is still a rejection: one second below condition 3's strict floor.
    let reach_limit = 255 * u64::from(RES) - GW;
    assert!(!supports_round(
        &f.env,
        &f.oracle,
        TW,
        GW,
        43_200,
        7_200,
        reach_limit,
        0
    ));
    assert!(supports_round(
        &f.env,
        &f.oracle,
        TW,
        GW,
        43_200,
        7_200,
        reach_limit + 1,
        0
    ));
}

// =================================================================================================
// What `cargo-mutants` proved was untested
// =================================================================================================

#[test]
fn the_vault_filters_a_non_positive_spot_even_when_the_source_returns_one() {
    // **The mutation layer earned its keep here.** `spot_check`'s `> 0` filter survived every
    // mutation, and the test written one block earlier *for that exact predicate* did not reach it:
    // the mock refuses a non-positive record before returning, so the vault-side filter — the one
    // that exists for a source that misbehaves — could only be exercised by a source that
    // misbehaves. The mock can now lie, and this is the assertion that was missing.
    //
    // It is not hypothetical: DEV3's inline copy accepted a non-positive tick as a spot, where it
    // compares as `spot < strike` and walks through the in-the-money guard.
    let f = setup();
    assert_eq!(spot_check(&f.env, &f.oracle, 600, DEC), Some(PX_1E7));

    for lie in [0i128, -1, i128::MIN] {
        f.mock.set_spot_override(&Some(lie));
        assert_eq!(
            spot_check(&f.env, &f.oracle, 600, DEC),
            None,
            "a source answering {lie} must not produce a spot"
        );
    }

    // And a positive lie is passed through — the filter rejects the sign, not the source.
    f.mock.set_spot_override(&Some(42));
    assert_eq!(spot_check(&f.env, &f.oracle, 600, DEC), Some(42));
}

#[test]
fn the_live_coarse_bound_rejects_in_both_directions_and_is_inclusive_at_the_band() {
    // Six mutants survived on this one line, because **every `open_epoch` test runs on round 1**,
    // where `last_settled_spot == 0` and the whole branch is skipped. Its anchored twin was tested;
    // this one was not — a guard whose duplicate is covered is the easiest kind to believe covered.
    let f = setup();
    let base = PX_1E7;

    // Inside the band, both directions, and inclusive at exactly 100x — which is what "outside the
    // band" means and what the `<`/`>` pair encodes.
    for inside in [base, base * 100, base / 100] {
        f.mock.set_mode(&Mode::ForceReading(OracleReading {
            short_twap: inside,
            guard_twap: inside,
            newest_ts: ANCHOR,
            feed_decimals: DEC,
        }));
        assert_eq!(
            live_reading(&f.env, &f.oracle, &params(), base),
            Ok((inside, DEC)),
            "{inside} is inside the band"
        );
    }

    // Outside it, both directions.
    for outside in [base * 100 + 1, base / 100 - 1] {
        f.mock.set_mode(&Mode::ForceReading(OracleReading {
            short_twap: outside,
            guard_twap: outside,
            newest_ts: ANCHOR,
            feed_decimals: DEC,
        }));
        assert_eq!(
            live_reading(&f.env, &f.oracle, &params(), base),
            Err(Error::OracleInvalidPrice),
            "{outside} is outside it"
        );
    }

    // And with no prior settle the whole branch is skipped, however absurd the price (O-8).
    f.mock.set_mode(&Mode::ForceReading(OracleReading {
        short_twap: base * 1_000_000,
        guard_twap: base * 1_000_000,
        newest_ts: ANCHOR,
        feed_decimals: DEC,
    }));
    assert!(live_reading(&f.env, &f.oracle, &params(), 0).is_ok());
}

/// The fast-test profile, as `live_reading` needs it: the windows the mock's `resolution() = 1`
/// admits, and a staleness budget wide enough that the guard under test is the one that fires.
fn params() -> EpochParams {
    let mut p = crate::test_common::valid_params();
    p.twap_window = TW;
    p.guard_window = GW;
    p.max_staleness = 100_000;
    p.max_deviation_bps = 10_000;
    p
}
