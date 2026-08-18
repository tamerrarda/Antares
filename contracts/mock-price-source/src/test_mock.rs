//! `MockPriceSource` at the contract level.
//!
//! The unit-level arithmetic is tested once, in `price-source-api`, because both sources call it.
//! What is tested **here** is everything that only exists once the thing is a deployed contract:
//! that the vault can reach it through the generated `PriceSourceClient`, that the eight conditions
//! answer from settable primitives rather than from a flag, and that the trap switch produces a
//! recoverable error instead of a propagated host trap.

use crate::{MockPriceSource, MockPriceSourceClient, Mode};
use price_source_api::{PriceSourceClient, ReadResult};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

const DECIMALS: u32 = 14;
/// Deliberately a multiple of 300, the shipped tick. An unaligned anchor is snapped down by the
/// grid (04-ORACLE §2 rule 0), which is correct but makes every expected timestamp in this file
/// arrive with an offset — so the constant carries the alignment instead of each assertion.
const NOW: u64 = 1_786_999_800;
/// 0.16 USD at `decimals = 14`.
const PX: i128 = 16_000_000_000_000;

struct Fixture<'a> {
    env: Env,
    mock: MockPriceSourceClient<'a>,
    id: Address,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let admin = Address::generate(&env);
    let id = env.register(MockPriceSource, (admin, DECIMALS));
    let mock = MockPriceSourceClient::new(&env, &id);
    Fixture { env, mock, id }
}

// -------------------------------------------------------------------------------------------------
// The seam the vault actually uses
// -------------------------------------------------------------------------------------------------

#[test]
fn the_vault_reaches_it_through_the_trait_client_and_never_by_symbol_name() {
    // This is the shape `oracle.rs` uses: a `PriceSourceClient` built from `config.oracle`. The
    // client comes from the trait in `price-source-api`, so a signature drift between the vault and
    // either implementation is a compile error rather than a runtime conversion failure — which
    // would otherwise classify as `Transient` and look exactly like a sick feed.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &20, &PX);

    let oracle = PriceSourceClient::new(&f.env, &f.id);
    let r = oracle.reading(&NOW, &900, &3_600);
    let ReadResult::Reading(reading) = r else {
        panic!("expected a settlement-grade reading")
    };
    assert_eq!(
        reading.short_twap, 1_600_000,
        "normalized down from 14 decimals to 1e7"
    );
    assert_eq!(reading.guard_twap, 1_600_000);
    assert_eq!(
        reading.feed_decimals, DECIMALS,
        "the scale travels with the price (D-68)"
    );
}

#[test]
fn a_gap_anywhere_in_the_short_window_yields_unusable() {
    // D-65's cost, made concrete: all three short samples are required, so one missing tick inside
    // the frozen window is a void where it used to settle. This is the assertion that the trade is
    // real rather than notional — and `verify-environment.ts` measured 100 % completeness on the
    // live feed, which is what makes it an acceptable one.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &20, &PX);
    f.mock.clear_price(&(NOW - 300));

    let oracle = PriceSourceClient::new(&f.env, &f.id);
    assert_eq!(oracle.reading(&NOW, &900, &3_600), ReadResult::Unusable);
}

// -------------------------------------------------------------------------------------------------
// The forced outcomes — "drive every outcome from MockPriceSource"
// -------------------------------------------------------------------------------------------------

#[test]
fn every_read_outcome_can_be_forced_directly() {
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &20, &PX);
    let oracle = PriceSourceClient::new(&f.env, &f.id);

    f.mock.set_mode(&Mode::ForceUnusable);
    assert_eq!(oracle.reading(&NOW, &900, &3_600), ReadResult::Unusable);

    f.mock.set_mode(&Mode::ForceOutOfReach);
    assert_eq!(oracle.reading(&NOW, &900, &3_600), ReadResult::OutOfReach);

    // `BadConfig` is the one that must arrive on the ERROR channel, not as a value. That split is
    // the routing rule: `Ok` is a statement about the window, `Err` is a statement about now.
    f.mock.set_mode(&Mode::ForceBadConfig);
    assert!(oracle.try_reading(&NOW, &900, &3_600).is_err());

    f.mock.set_mode(&Mode::Normal);
    assert!(matches!(
        oracle.reading(&NOW, &900, &3_600),
        ReadResult::Reading(_)
    ));
}

#[test]
fn an_aged_out_anchor_is_out_of_reach_and_not_unusable() {
    // O-12, and the regression test for the eighteen-hour free option. The records are still there
    // here; what has aged out is our ability to reach them. A naive implementation that sampled
    // first would find nothing and answer `Unusable` — the void branch, refunding an
    // out-of-the-money bidder in full for having simply waited. Rule 3 runs before any sampling,
    // which is what makes the answer `OutOfReach` instead.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &20, &PX);
    let oracle = PriceSourceClient::new(&f.env, &f.id);

    // reach_limit = 255*300 − 3600 = 72 900 (D-69). One second past it.
    f.env.ledger().set_timestamp(NOW + 72_901);
    assert_eq!(oracle.reading(&NOW, &900, &3_600), ReadResult::OutOfReach);

    // At the limit it is still readable — the boundary condition 3's strictness rests on.
    f.env.ledger().set_timestamp(NOW + 72_900);
    assert!(matches!(
        oracle.reading(&NOW, &900, &3_600),
        ReadResult::Reading(_)
    ));
}

// -------------------------------------------------------------------------------------------------
// The trap switch — O-13e
// -------------------------------------------------------------------------------------------------

#[test]
fn the_trap_switch_surfaces_as_a_recoverable_error_on_every_call_site() {
    // The vault calls all three through the recoverable form so an adapter fault can never escape
    // as a host trap — out of `close_round`, where it would trap collateral forever, or out of the
    // constructor, where it must arrive as `InvalidParams`. Without this switch that rule has no
    // regression test at all.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &20, &PX);
    f.mock.set_trap(&true);

    let oracle = PriceSourceClient::new(&f.env, &f.id);
    assert!(oracle.try_reading(&NOW, &900, &3_600).is_err());
    assert!(oracle.try_spot_check(&600, &DECIMALS).is_err());
    assert!(oracle
        .try_supports_round(&900, &3_600, &43_200, &7_200, &75_600, &0)
        .is_err());

    // And it is a switch, not a state: turning it off restores every answer.
    f.mock.set_trap(&false);
    assert!(oracle.try_reading(&NOW, &900, &3_600).is_ok());
    assert!(oracle.supports_round(&900, &3_600, &43_200, &7_200, &75_600, &0));
}

// -------------------------------------------------------------------------------------------------
// supports_round — the claim that there is no reject switch
// -------------------------------------------------------------------------------------------------

#[test]
fn supports_round_answers_from_the_settable_resolution_and_not_from_a_flag() {
    // The whole argument for a settable `resolution()`. Nothing about the parameters changes
    // between these calls — only the feed's tick — and the answer flips, because R, reach_limit and
    // the realized spans are all derived from it. A boolean reject switch would pass every other
    // test in this file and fail this one.
    let f = setup();
    let oracle = PriceSourceClient::new(&f.env, &f.id);
    let ask = |res: u32| {
        f.mock.set_resolution(&res);
        oracle.supports_round(&900, &3_600, &43_200, &7_200, &75_600, &0)
    };
    assert!(!ask(282), "below the band: condition 6's ceiling bites");
    assert!(ask(283), "the floor of the admissible band");
    assert!(ask(300), "the shipped tick");
    assert!(ask(310), "the ceiling of the admissible band");
    assert!(!ask(311), "above the band: condition 3 bites");
}

#[test]
fn condition_7_is_answered_from_the_settable_expiry_and_only_when_a_span_is_given() {
    // O-13f. `validate_params` passes `round_span = 0` and skips the condition entirely, so a
    // sponsorship shortfall can never block the `set_epoch_params` call that repairs it;
    // `open_epoch` passes `epoch_duration + unresolved_after` and enforces it, and is the only
    // caller that can reach this condition at all.
    let f = setup();
    f.mock.set_resolution(&300);
    let oracle = PriceSourceClient::new(&f.env, &f.id);
    let span: u64 = 604_800 + 75_600;
    let ask = |round_span: u64| {
        oracle.supports_round(&900, &3_600, &43_200, &7_200, &75_600, &round_span)
    };

    assert!(
        ask(0),
        "round_span == 0 skips condition 7 even with no expiry at all"
    );
    assert!(!ask(span), "a None expiry is an unfunded feed");

    f.mock.set_expires(&Some(NOW + span));
    assert!(
        !ask(span),
        "an expiry exactly at the deadline is not strictly beyond it"
    );

    f.mock.set_expires(&Some(NOW + span + 1));
    assert!(
        ask(span),
        "a feed funded past the round is what lets it open"
    );

    // A feed funded past the dead window but not past the round is refused — the older
    // `+ oracle_dead_after` threshold was weaker than the gate, so a deploy passed and the first
    // `open_epoch` refused (04-ORACLE §5).
    f.mock.set_expires(&Some(NOW + 43_200 + 1));
    assert!(!ask(span));
}

// -------------------------------------------------------------------------------------------------
// spot_check — the bid guard's side of the seam
// -------------------------------------------------------------------------------------------------

#[test]
fn spot_check_refuses_a_scale_that_does_not_match_the_round() {
    // O-4e, the sibling path. An earlier draft fixed the settlement side of a decimals change and
    // left this one: a rescaled tick compared against the round's strike is a bid accepted or
    // rejected on a price wrong by a factor of ten.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &5, &PX);
    let oracle = PriceSourceClient::new(&f.env, &f.id);

    assert_eq!(oracle.spot_check(&600, &DECIMALS), Some(1_600_000));
    assert_eq!(
        oracle.spot_check(&600, &(DECIMALS + 1)),
        None,
        "a mismatched scale is not comparable"
    );

    f.mock.set_decimals(&(DECIMALS + 1));
    assert_eq!(
        oracle.spot_check(&600, &DECIMALS),
        None,
        "and it is detected from either side"
    );
}

#[test]
fn spot_check_tolerates_exactly_one_missed_tick_on_top_of_the_callers_budget() {
    // The source adds its own `resolution()`, because resolution is a property of the feed and the
    // vault has no `resolution` field and must never grow one (D-58). So 600 seconds buys 600 + 300.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &5, &PX);
    let oracle = PriceSourceClient::new(&f.env, &f.id);

    f.env.ledger().set_timestamp(NOW + 900);
    assert_eq!(
        oracle.spot_check(&600, &DECIMALS),
        Some(1_600_000),
        "600 + one tick"
    );

    f.env.ledger().set_timestamp(NOW + 901);
    assert_eq!(oracle.spot_check(&600, &DECIMALS), None);
}

#[test]
fn spot_check_refuses_an_empty_or_non_positive_feed() {
    let f = setup();
    f.mock.set_resolution(&300);
    let oracle = PriceSourceClient::new(&f.env, &f.id);
    assert_eq!(
        oracle.spot_check(&600, &DECIMALS),
        None,
        "no records at all"
    );

    f.mock.set_price(&NOW, &0);
    assert_eq!(
        oracle.spot_check(&600, &DECIMALS),
        None,
        "a non-positive record is not a price"
    );
}

// -------------------------------------------------------------------------------------------------
// The settable primitives that exist for one test each
// -------------------------------------------------------------------------------------------------

#[test]
fn a_stamped_record_makes_the_out_of_window_case_constructible() {
    // The reason `set_price_stamped` exists. Without it there is no way to build a feed that answers
    // with evidence about a different moment than the one asked for, and rule 2's window filter —
    // the thing that stops such an answer being treated as settlement-grade — is untested.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &20, &PX);
    let oracle = PriceSourceClient::new(&f.env, &f.id);
    assert!(matches!(
        oracle.reading(&NOW, &900, &3_600),
        ReadResult::Reading(_)
    ));

    // Same slot, same price, a timestamp claiming to be from after the anchor.
    f.mock.set_price_stamped(&(NOW - 300), &PX, &(NOW + 300));
    assert_eq!(oracle.reading(&NOW, &900, &3_600), ReadResult::Unusable);
}

#[test]
fn the_default_resolution_is_one_second() {
    // Normative, not incidental: 02-CONTRACT-SPEC §1's fast-test definition rests on it, and
    // changing it changes which fast-test profiles are admissible at all.
    let f = setup();
    assert_eq!(f.mock.resolution(), 1);
}

#[test]
fn the_batch_call_stops_answering_at_its_settable_collapse_point() {
    // Recorded as having no consumer — nothing in this project reads `prices()` (D-48). The test
    // exists so the primitive is known to work if a future adapter ever wants it, not because
    // anything depends on it.
    let f = setup();
    f.mock.set_resolution(&300);
    f.mock.fill(&NOW, &30, &PX);
    f.mock.set_prices_collapse(&20);
    assert_eq!(f.mock.prices(&20).map(|v| v.len()), Some(20));
    assert_eq!(f.mock.prices(&21), None);
}
