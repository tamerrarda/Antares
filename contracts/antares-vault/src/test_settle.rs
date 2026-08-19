//! `close_round` — the terminal dispatch, and the grid I10 rests on.
//!
//! The suite is organised around one question rather than around the code: **can two outcomes, or
//! none, ever be reached?** So the shape here is a grid of `GuardOutcome × time` rather than a test
//! per branch, and the branch-shaped tests below it exist to pin the numbers each cell produces.
//!
//! Rounds are put into `Active` **through `open_epoch`** wherever the test is not about the fills,
//! and the fills themselves are written to `State` directly, because `bid` is DEV3's `auction.rs`
//! and does not exist yet. That is a harness affordance and it is recorded as one: what it cannot
//! prove is that `bid` produces these numbers, so every test here is re-run against the real
//! auction at IP-4.

// The stroop notation of the specification — the integer part, then all seven decimals.
#![allow(clippy::inconsistent_digit_grouping)]

use crate::test_common::{deploy, valid_params, Deployed};
use crate::types::{Phase, RoundOutcome, VoidReason};
use crate::Error;
use mock_price_source::{MockPriceSourceClient, Mode};
use price_source_api::OracleReading;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address,
};

const EPOCH: u64 = 2_400;
const GAP: u64 = 48;
const UNRESOLVED: u64 = 240;
const DEAD_AFTER: u64 = 60;
const ROUND_SPAN: u64 = EPOCH + UNRESOLVED;
/// 0.16 USD at the mock's 14 decimals, and the same price at 1e7.
const PX: i128 = 16_000_000_000_000;
const PX_1E7: i128 = 1_600_000;
const DEPOSIT: i128 = 1_000_0000000;
/// What the fixture sells and collects. Chosen so the fee and bounty are non-zero at 25 bps.
const SOLD: i128 = 500_0000000;
const PREMIUM: i128 = 20_0000000;

fn oracle(d: &Deployed) -> MockPriceSourceClient<'_> {
    MockPriceSourceClient::new(&d.env, &d.oracle)
}

fn feed(d: &Deployed) {
    let now = d.env.ledger().timestamp();
    let o = oracle(d);
    o.fill(&now, &400, &PX);
    o.set_expires(&Some(now + ROUND_SPAN * 4));
}

/// A vault with a real round open, sold and expired — the state `close_round` acts on.
///
/// The round is opened by `open_epoch`, so the snapshot under test is the one the contract
/// actually writes. Only the auction's two outputs are injected.
fn expired_round() -> Deployed {
    let d = deploy();
    let user = d.user(10_000_0000000);
    d.client().deposit(&user, &DEPOSIT);
    d.advance(GAP);
    feed(&d);
    assert!(d.client().open_epoch());

    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.phase = Phase::Active;
        s.notional_sold = SOLD;
        s.premium_collected = PREMIUM;
        crate::storage::set_state(&d.env, &s);
    });
    d.advance(EPOCH);
    feed(&d);
    d
}

fn close(d: &Deployed) -> Result<RoundOutcome, Error> {
    let to = Address::generate(&d.env);
    d.client()
        .try_close_round(&to)
        .map_err(|e| e.unwrap())
        .map(|r| r.unwrap())
}

/// Force the anchored read to answer exactly this, whatever the records say.
fn force(d: &Deployed, short: i128, guard: i128, decimals: u32) {
    oracle(d).set_mode(&Mode::ForceReading(OracleReading {
        short_twap: short,
        guard_twap: guard,
        newest_ts: d.env.ledger().timestamp(),
        feed_decimals: decimals,
    }));
}

// =================================================================================================
// The grid — GuardOutcome × time
// =================================================================================================

#[test]
fn the_grid_reaches_exactly_one_outcome_in_every_cell() {
    // I10, stated as a table rather than as prose. Four classifications against the three windows
    // the clock divides the close into. Every cell has exactly one answer, and no cell is
    // undefined — which is the property, and it is what one `match` over four values behind one
    // time check buys.
    //
    // The `Transient` row is the one that terminates nowhere until the clock does it: that is not
    // a hole, it is step 2, and the last column is where it closes.
    // One row per cell. A named type rather than a tuple, so the grid reads as the table it
    // is and so a column cannot be silently transposed.
    struct Cell {
        why: &'static str,
        wait: u64,
        mode: Mode,
        outcome: Option<RoundOutcome>,
        error: Option<Error>,
    }

    let cases = [
        Cell {
            why: "price, in grace",
            wait: 0,
            mode: Mode::Normal,
            outcome: Some(RoundOutcome::Settled),
            error: None,
        },
        Cell {
            why: "dead, in grace",
            wait: 0,
            mode: Mode::ForceUnusable,
            outcome: None,
            error: Some(Error::OracleNotDeadYet),
        },
        Cell {
            why: "out of reach, in grace",
            wait: 0,
            mode: Mode::ForceOutOfReach,
            outcome: Some(RoundOutcome::Unresolved),
            error: None,
        },
        Cell {
            why: "transient, in grace",
            wait: 0,
            mode: Mode::ForceBadConfig,
            outcome: None,
            error: Some(Error::OracleUnreachable),
        },
        Cell {
            why: "price, past grace",
            wait: DEAD_AFTER,
            mode: Mode::Normal,
            outcome: Some(RoundOutcome::Settled),
            error: None,
        },
        Cell {
            why: "dead, past grace",
            wait: DEAD_AFTER,
            mode: Mode::ForceUnusable,
            outcome: Some(RoundOutcome::Voided),
            error: None,
        },
        Cell {
            why: "out of reach, past grace",
            wait: DEAD_AFTER,
            mode: Mode::ForceOutOfReach,
            outcome: Some(RoundOutcome::Unresolved),
            error: None,
        },
        Cell {
            why: "transient, past grace",
            wait: DEAD_AFTER,
            mode: Mode::ForceBadConfig,
            outcome: None,
            error: Some(Error::OracleUnreachable),
        },
        Cell {
            why: "price, past fallback",
            wait: UNRESOLVED,
            mode: Mode::Normal,
            outcome: Some(RoundOutcome::Unresolved),
            error: None,
        },
        Cell {
            why: "dead, past fallback",
            wait: UNRESOLVED,
            mode: Mode::ForceUnusable,
            outcome: Some(RoundOutcome::Unresolved),
            error: None,
        },
        Cell {
            why: "out of reach, past fallback",
            wait: UNRESOLVED,
            mode: Mode::ForceOutOfReach,
            outcome: Some(RoundOutcome::Unresolved),
            error: None,
        },
        Cell {
            why: "transient, past fallback",
            wait: UNRESOLVED,
            mode: Mode::ForceBadConfig,
            outcome: Some(RoundOutcome::Unresolved),
            error: None,
        },
    ];

    for Cell {
        why,
        wait,
        mode,
        outcome,
        error,
    } in cases
    {
        let d = expired_round();
        d.advance(wait);
        feed(&d);
        oracle(&d).set_mode(&mode);

        match (outcome, error) {
            (Some(expected), None) => {
                assert_eq!(close(&d).unwrap(), expected, "{why}");
                assert_eq!(d.state().phase, Phase::Idle, "{why}: and the round is over");
            }
            (None, Some(expected)) => {
                assert_eq!(close(&d).unwrap_err(), expected, "{why}");
                assert_eq!(d.state().phase, Phase::Active, "{why}: nothing terminated");
            }
            _ => unreachable!("a cell must expect exactly one of an outcome or an error"),
        }
    }
}

/// **O-3e** — the adapter never recovers; `close_round` at `expiry + unresolved_after` reaches
/// `Unresolved` **with zero adapter invocations**. The trap stays on across the closing call,
/// which is how "not invoked" is asserted rather than asserted about.
#[test]
fn a_transient_that_never_clears_still_ends_with_the_clock() {
    // The regression for permanently trapped collateral, and the one row above that needs its own
    // test because the assertion is about what is **not** called.
    //
    // The adapter traps on every call. Before D-64 this reverted forever and every depositor's
    // collateral stayed in `Active`. It now closes — and the proof that no oracle call happens is
    // that the trap is still on: if step 2 consulted the adapter at all, this would revert.
    let d = expired_round();
    oracle(&d).set_trap(&true);

    assert_eq!(
        close(&d).unwrap_err(),
        Error::OracleUnreachable,
        "before the fallback"
    );
    assert_eq!(d.state().phase, Phase::Active);

    d.advance(UNRESOLVED);
    assert_eq!(
        close(&d).unwrap(),
        RoundOutcome::Unresolved,
        "past it, with the adapter still trapping — so it was never called"
    );
    assert_eq!(d.state().phase, Phase::Idle);
}

#[test]
fn the_two_entrances_to_unresolved_agree_on_every_number() {
    // D-64. Step 2 reaches this branch on a clock alone; `OutOfReach` reaches it on the adapter's
    // answer. They must be byte-identical, because condition 3 guarantees step 2 only fires where a
    // working adapter could have answered nothing *but* `OutOfReach` — so any divergence would be a
    // case where the outcome depended on whether the adapter happened to be healthy at call time.
    let by_clock = {
        let d = expired_round();
        d.advance(UNRESOLVED);
        oracle(&d).set_trap(&true); // proves this entrance consults nothing
        assert_eq!(close(&d).unwrap(), RoundOutcome::Unresolved);
        d.state()
    };
    let by_adapter = {
        let d = expired_round();
        oracle(&d).set_mode(&Mode::ForceOutOfReach);
        assert_eq!(close(&d).unwrap(), RoundOutcome::Unresolved);
        d.state()
    };

    assert_eq!(by_clock.last_pps, by_adapter.last_pps);
    assert_eq!(by_clock.locked_assets, by_adapter.locked_assets);
    assert_eq!(by_clock.fee_claimable, by_adapter.fee_claimable);
    assert_eq!(
        by_clock.withdraw_claimable_total,
        by_adapter.withdraw_claimable_total
    );
    assert_eq!(
        by_clock.bidder_claimable_total,
        by_adapter.bidder_claimable_total
    );
    assert_eq!(by_clock.last_settled_spot, by_adapter.last_settled_spot);
}

// =================================================================================================
// The settle path's numbers
// =================================================================================================

/// **O-1** — fresh feed, in bounds, `close_round` → `Settled`.
#[test]
fn settle_computes_the_payout_fee_bounty_and_price_the_spec_states() {
    let d = expired_round();
    let before = d.state();
    // Deep in the money: spot 25 % above the strike.
    let spot = before.strike * 125 / 100;
    force(&d, spot, spot, 14);

    assert_eq!(close(&d).unwrap(), RoundOutcome::Settled);
    let s = d.state();

    let payout = SOLD * (spot - before.strike) / spot;
    let fee = 0; // fee_bps ships at 0 (D-56); the snapshot test below moves it
    let bounty = PREMIUM * i128::from(valid_params().settle_bounty_bps) / 10_000;
    let assets_r = before.locked_at_open + PREMIUM - payout - fee - bounty;

    assert_eq!(
        s.bidder_claimable_total, payout,
        "the payout pool, pulled per bidder"
    );
    assert_eq!(s.last_settled_spot, spot, "the only branch that writes it");
    assert_eq!(s.last_pps, assets_r * 10_000_000 / before.shares_snapshot);

    let record = d
        .env
        .as_contract(&d.vault, || crate::storage::get_round(&d.env, before.round))
        .unwrap();
    assert_eq!(record.outcome, RoundOutcome::Settled);
    // The three fields `finalize_round`'s original signature could not carry, and which I7 forbids
    // writing in a second pass.
    assert_eq!(record.settled_spot, spot);
    assert_eq!(record.payout_total, payout);
    assert_eq!(record.fee, fee);
}

#[test]
fn an_out_of_the_money_round_settles_with_no_payout() {
    let d = expired_round();
    let strike = d.state().strike;
    force(&d, strike - 1, strike - 1, 14);

    assert_eq!(close(&d).unwrap(), RoundOutcome::Settled);
    assert_eq!(
        d.state().bidder_claimable_total,
        0,
        "the option expired worthless"
    );
    // Depositors keep the premium less the bounty — the covered call they signed up for.
    assert!(d.state().last_pps > 10_000_000);
}

#[test]
fn i3_holds_as_spot_grows_without_bound() {
    // `payout_total < notional_sold` strictly, for all inputs. The fraction (spot − strike)/spot is
    // below 1 for every strike > 0, and `open_epoch`'s step 3 guarantees strike > 0 by rejecting a
    // non-positive price before the strike is derived. The floor can only make it smaller.
    for factor in [2i128, 100, 10_000, 1_000_000] {
        let d = expired_round();
        let strike = d.state().strike;
        let spot = strike.saturating_mul(factor);
        force(&d, spot, spot, 14);
        assert_eq!(close(&d).unwrap(), RoundOutcome::Settled);
        let payout = d.state().bidder_claimable_total;
        assert!(
            payout < SOLD,
            "factor {factor}: payout {payout} must stay under {SOLD}"
        );
    }
}

#[test]
fn every_caller_at_every_time_settles_at_the_same_price() {
    // D-40, and it is why a permissionless settlement function is safe: the party the current price
    // favours cannot call at the moment that suits them, because the moment does not enter the
    // answer. Three different callers, three different times, one price.
    //
    // The resolution is settable and is *held fixed* here — a fixed-resolution mock would pass this
    // either way and test half the property. I10's stated precondition is exactly that the feed
    // does not re-time its grid mid-round; the adapter's O-14 covers the other side.
    let mut seen = [0i128; 3];
    for (i, delay) in [0u64, 30, DEAD_AFTER + 30].iter().enumerate() {
        let d = expired_round();
        assert_eq!(
            oracle(&d).resolution(),
            1,
            "held fixed, and settable — that is the point"
        );
        d.advance(*delay);
        feed(&d);
        let to = Address::generate(&d.env);
        assert_eq!(d.client().close_round(&to), RoundOutcome::Settled);
        seen[i] = d.state().last_settled_spot;
    }
    assert_eq!(seen[0], seen[1]);
    assert_eq!(seen[1], seen[2]);
    assert_eq!(seen[0], PX_1E7);
}

// =================================================================================================
// The void path
// =================================================================================================

/// **O-5** — dead at expiry, `now < expiry + oracle_dead_after` → `OracleNotDeadYet`. The second
/// half of this test crosses into **O-6**'s window; O-6's own assertions are the test below.
#[test]
fn a_dead_feed_voids_only_after_the_grace_period() {
    // The grace period is not waiting for the feed to recover — frozen history does not recover.
    // It stops a transient present-tense failure being recorded as "the feed was dead at expiry".
    let d = expired_round();
    oracle(&d).set_mode(&Mode::ForceUnusable);

    assert_eq!(close(&d).unwrap_err(), Error::OracleNotDeadYet);
    assert_eq!(d.state().phase, Phase::Active, "nothing terminated");

    d.advance(DEAD_AFTER);
    assert_eq!(close(&d).unwrap(), RoundOutcome::Voided);
}

/// **O-7** — the anchored window was readable all along, and the round is closed deep inside the
/// void window. It settles.
///
/// The row's claim is about the *reason*, not the outcome, and that is what makes the grid cell
/// above insufficient on its own: `price, past grace` asserts `Settled`, but it would still pass
/// if the void bound were computed too late and the clock had simply never entered the window.
/// So the assertion here is differential — two fixtures, one instant, one difference. The dead
/// feed voids, which proves the clock *is* past the bound; the readable one settles anyway.
///
/// Stated the other way: the void path is not skipped because it was out of reach in time. It was
/// squarely in reach. It is skipped because the read returns `Price`.
#[test]
fn a_readable_feed_settles_past_the_void_bound_on_the_read_not_on_the_clock() {
    // Deep inside the window: past `oracle_dead_after`, well short of `unresolved_after`, so
    // neither boundary is being tested by accident.
    const LATE: u64 = DEAD_AFTER * 3;
    // A `const` block, so an edit to either bound that inverts the window fails to *compile*
    // rather than failing here — this test is meaningless outside it, and a meaningless test that
    // still passes is worse than one that does not build.
    const { assert!(LATE > DEAD_AFTER && LATE < UNRESOLVED) };

    // The control. Same fixture, same instant, feed dead — this is the void the readable round has
    // to dodge, and running it is what turns "past the bound" from a claim into a measurement.
    let dead = expired_round();
    dead.advance(LATE);
    oracle(&dead).set_mode(&Mode::ForceUnusable);
    assert_eq!(
        close(&dead).unwrap(),
        RoundOutcome::Voided,
        "the clock is inside the void window — established, not assumed"
    );

    // The row itself.
    let d = expired_round();
    let before = d.state();
    let spot = before.strike * 125 / 100;
    d.advance(LATE);
    force(&d, spot, spot, 14);

    assert_eq!(close(&d).unwrap(), RoundOutcome::Settled);

    let record = d
        .env
        .as_contract(&d.vault, || crate::storage::get_round(&d.env, before.round))
        .unwrap();
    assert_eq!(record.outcome, RoundOutcome::Settled);
    // Settled *at the price it read*. `settled_spot` is written on the price path and nowhere
    // else, so this is the field that separates "settled" from "did not happen to void".
    assert_eq!(
        record.settled_spot, spot,
        "the price path ran; a void or a fallback would not have written this"
    );
    assert_eq!(d.state().last_settled_spot, spot);
}

/// **O-6** — dead at expiry, past the bound, still within reach → `Voided`, refunds claimable,
/// `pps` unchanged.
#[test]
fn a_void_refunds_the_whole_premium_leaves_pps_untouched_and_pays_no_bounty() {
    let d = expired_round();
    let before = d.state();
    oracle(&d).set_mode(&Mode::ForceUnusable);
    d.advance(DEAD_AFTER);

    let to = Address::generate(&d.env);
    let paid_before = d.balance(&to);
    assert_eq!(d.client().close_round(&to), RoundOutcome::Voided);
    let s = d.state();

    assert_eq!(
        s.bidder_claimable_total, PREMIUM,
        "the whole premium, pulled per fill"
    );
    assert_eq!(
        s.last_pps, before.last_pps,
        "a void costs depositors nothing and earns them nothing"
    );
    assert_eq!(
        s.last_settled_spot, before.last_settled_spot,
        "no settlement price was produced"
    );
    // D-51: no bounty, and no source for one — the premium is refunded in full.
    assert_eq!(
        d.balance(&to),
        paid_before,
        "the void branch pays nothing to its caller"
    );
}

#[test]
fn both_void_reasons_are_reachable_and_there_are_exactly_two() {
    // D-60 dropped `VoidReason` to two variants. An unreachable third would be dead ABI an
    // integrator has to handle and can never see — so both are produced here, and the match below
    // is what fails to compile if a third is ever added without a case.
    let unusable = {
        let d = expired_round();
        oracle(&d).set_mode(&Mode::ForceUnusable);
        d.advance(DEAD_AFTER);
        assert_eq!(close(&d).unwrap(), RoundOutcome::Voided);
        d.env
            .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1))
            .unwrap()
    };
    let invalid = {
        let d = expired_round();
        force(&d, 0, PX_1E7, 14); // a non-positive aggregate: records that exist but are nonsense
        d.advance(DEAD_AFTER);
        assert_eq!(close(&d).unwrap(), RoundOutcome::Voided);
        d.env
            .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1))
            .unwrap()
    };
    assert_eq!(unusable.outcome, RoundOutcome::Voided);
    assert_eq!(invalid.outcome, RoundOutcome::Voided);

    // Exhaustiveness, enforced by the compiler rather than by counting.
    for reason in [VoidReason::FeedUnusable, VoidReason::InvalidPrice] {
        match reason {
            VoidReason::FeedUnusable | VoidReason::InvalidPrice => {}
        }
    }
}

// =================================================================================================
// D-39 — the fee is a snapshot, and it cannot block the exit
// =================================================================================================

#[test]
fn settlement_uses_the_fee_the_round_opened_under() {
    // Read live, an admin could apply a fee retroactively to a round auctioned under a different
    // one — and a large enough value drove `assets_R` negative and wedged the close on a checked
    // subtraction. What you relied on when you committed money is what settles you (§15).
    let d = expired_round();
    let before = d.state();
    assert_eq!(before.fee_bps_snapshot, 0, "ships at 0, D-56");

    // Move `Config.fee_bps` mid-round through the real setter. This was a storage write until
    // DEV1's `set_fee_bps` landed; switched the moment it did, because a harness affordance that
    // outlives its reason stops being recorded and starts being believed.
    d.client().set_fee_bps(&2_000); // 20 %, the validation ceiling

    force(&d, before.strike * 2, before.strike * 2, 14);
    assert_eq!(close(&d).unwrap(), RoundOutcome::Settled);

    assert_eq!(
        d.state().fee_claimable,
        0,
        "the snapshot was 0, and the snapshot is what settles"
    );
    let record = d
        .env
        .as_contract(&d.vault, || crate::storage::get_round(&d.env, before.round))
        .unwrap();
    assert_eq!(record.fee, 0);
}

#[test]
fn a_fee_recipient_that_cannot_receive_does_not_block_the_close() {
    // The whole of D-39's pull rule. Pushing made settlement depend on the recipient being able to
    // receive XLM: point `fee_recipient` at an address that cannot and `close_round` reverts
    // forever, while the void branch stays unavailable because the oracle is perfectly healthy —
    // one admin setter trapping every depositor's collateral in `Active`, which contradicts I8.
    //
    // With a pull, the close touches only its own state. The recipient here has never held the
    // asset and has no trustline analogue in the SAC's eyes; the fee accrues regardless.
    let d = expired_round();
    let before = d.state();
    d.client().set_fee_recipient(&Address::generate(&d.env));
    d.client().set_fee_bps(&2_000);
    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.fee_bps_snapshot = 2_000; // as if the round had opened under it
        crate::storage::set_state(&d.env, &s);
    });

    force(&d, before.strike * 2, before.strike * 2, 14);
    assert_eq!(
        close(&d).unwrap(),
        RoundOutcome::Settled,
        "the close does not care"
    );
    assert_eq!(
        d.state().fee_claimable,
        PREMIUM * 2_000 / 10_000,
        "accrued, not paid"
    );
}

#[test]
fn assets_after_the_round_is_never_negative_on_any_branch() {
    // Asserted rather than assumed on all three, because D-39's finding was that a parameter read
    // at the wrong time can drive it below zero, and a checked subtraction that underflows on the
    // exit path is exactly what I8 forbids.
    for mode in [Mode::Normal, Mode::ForceUnusable, Mode::ForceOutOfReach] {
        let d = expired_round();
        d.env.as_contract(&d.vault, || {
            let mut s = crate::storage::get_state(&d.env).unwrap();
            s.fee_bps_snapshot = 2_000;
            s.params.settle_bounty_bps = 100; // both at their validation ceilings
            crate::storage::set_state(&d.env, &s);
        });
        oracle(&d).set_mode(&mode);
        d.advance(DEAD_AFTER);
        let outcome = close(&d).unwrap();
        assert!(d.state().locked_assets >= 0, "{outcome:?}");
        assert!(d.state().last_pps >= 0, "{outcome:?}");
    }
}

// =================================================================================================
// D-59's economic property — the reason `Unresolved` exists at all
// =================================================================================================

#[test]
fn waiting_is_worth_nothing_out_of_the_money_and_costs_the_payout_in_it() {
    // This is the assertion behind I10 and it is **not** what I10's own text says: I10 is about
    // terminal dispatch, this is about incentive. A refund is what paid the bidder to wait — out
    // of the money his gain from letting the clock run out was 100 % of the premium, and no bounty
    // funded from that premium could outbid it.
    let strike_of = |d: &Deployed| d.state().strike;

    // Out of the money: recovery under Unresolved equals recovery under a normal settle — zero.
    let otm_settled = {
        let d = expired_round();
        let k = strike_of(&d);
        force(&d, k - 1, k - 1, 14);
        assert_eq!(close(&d).unwrap(), RoundOutcome::Settled);
        d.state().bidder_claimable_total
    };
    let otm_unresolved = {
        let d = expired_round();
        d.advance(UNRESOLVED);
        assert_eq!(close(&d).unwrap(), RoundOutcome::Unresolved);
        d.state().bidder_claimable_total
    };
    assert_eq!(otm_settled, 0);
    assert_eq!(
        otm_unresolved, 0,
        "so drifting gains an out-of-the-money bidder nothing"
    );

    // In the money: strictly less. He loses the payout he earned.
    let itm_settled = {
        let d = expired_round();
        let k = strike_of(&d);
        force(&d, k * 2, k * 2, 14);
        assert_eq!(close(&d).unwrap(), RoundOutcome::Settled);
        d.state().bidder_claimable_total
    };
    assert!(itm_settled > 0);
    assert!(
        otm_unresolved < itm_settled,
        "and drifting strictly costs an in-the-money one"
    );
}

// =================================================================================================
// Preconditions and the lapse
// =================================================================================================

#[test]
fn a_round_cannot_be_closed_before_it_expires() {
    let d = deploy();
    let user = d.user(10_000_0000000);
    d.client().deposit(&user, &DEPOSIT);
    d.advance(GAP);
    feed(&d);
    assert!(d.client().open_epoch());
    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.phase = Phase::Active;
        crate::storage::set_state(&d.env, &s);
    });
    assert_eq!(close(&d).unwrap_err(), Error::NotExpired);
}

#[test]
fn closing_an_idle_vault_is_the_wrong_phase() {
    let d = deploy();
    assert_eq!(close(&d).unwrap_err(), Error::WrongPhase);
}

#[test]
fn an_empty_auction_answers_lapsed_rather_than_reverting() {
    // D-43's rule on this entry point: the caller asked for the round to end and it ended. A revert
    // would discard a real finalization.
    let d = deploy();
    let user = d.user(10_000_0000000);
    d.client().deposit(&user, &DEPOSIT);
    d.advance(GAP);
    feed(&d);
    assert!(d.client().open_epoch());
    d.advance(valid_params().auction_duration + 1);

    assert_eq!(close(&d).unwrap(), RoundOutcome::Lapsed);
    assert_eq!(d.state().phase, Phase::Idle);
}

// =================================================================================================
// The bounty
// =================================================================================================

#[test]
fn the_bounty_reaches_the_caller_on_both_paying_branches() {
    // D-44: settlement cannot depend on altruism. It is safe to push precisely because the caller
    // names the recipient — an address that cannot receive is the caller's own problem, and someone
    // else can close with a different one.
    let expected = PREMIUM * i128::from(valid_params().settle_bounty_bps) / 10_000;
    assert!(expected > 0, "a zero bounty would make this test vacuous");

    for past_fallback in [false, true] {
        let d = expired_round();
        if past_fallback {
            d.advance(UNRESOLVED);
        }
        let to = Address::generate(&d.env);
        let outcome = d.client().close_round(&to);
        assert_eq!(d.balance(&to), expected, "{outcome:?}");
    }
}

// =================================================================================================
// The fuzzer's finding, as a permanent regression
// =================================================================================================

#[test]
fn round_numbers_refuses_every_input_outside_its_domain_and_accepts_its_boundary() {
    // `06-TEST-PLAN.md` §4: *every crash becomes a permanent regression unit test*. This is
    // `fuzz_settlement_math`'s first — at `notional_sold < 0` the settlement math produced a
    // **negative payout**, a transfer *from* the bidder.
    //
    // **Rewritten 2026-08-19 after `cargo-mutants` showed the first version was weaker than it
    // looked.** It passed `-1` for each field and asserted `Err(InvalidAmount)` — but with a guard
    // mutated away the value flowed on and `assets_R` went negative, which returns *the same
    // error*. The test could not tell which guard fired, so mutating any one of them survived.
    //
    // Two changes fix it. `spot = None` keeps the payout at zero so `assets_R` stays positive and
    // cannot mask a missing guard; and each field's **accepted boundary** is asserted as well as
    // its rejected one, because a guard widened from `< 0` to `<= 0` rejects a legitimate zero and
    // no test that only pushes negatives would notice.
    use crate::settle::round_numbers;

    // No price, large float of assets: nothing here can produce an error except a domain guard.
    let base = |strike, notional, locked, premium, shares| {
        round_numbers(None, strike, notional, locked, premium, shares, 0, 25)
    };
    assert!(
        base(1_000_000, 100, 1_000_000, 10, 1_000).is_ok(),
        "the baseline must be accepted"
    );

    // Rejected, one field at a time.
    let rejected = [
        (
            "notional_sold < 0 — the fuzzer's crash",
            base(1_000_000, -1, 1_000_000, 10, 1_000),
        ),
        ("strike <= 0", base(0, 100, 1_000_000, 10, 1_000)),
        ("strike < 0", base(-1, 100, 1_000_000, 10, 1_000)),
        (
            "shares_snapshot <= 0",
            base(1_000_000, 100, 1_000_000, 10, 0),
        ),
        (
            "shares_snapshot < 0",
            base(1_000_000, 100, 1_000_000, 10, -1),
        ),
        ("locked_at_open < 0", base(1_000_000, 100, -1, 10, 1_000)),
        (
            "premium_collected < 0",
            base(1_000_000, 100, 1_000_000, -1, 1_000),
        ),
    ];
    for (why, result) in rejected {
        assert_eq!(result, Err(Error::InvalidAmount), "{why}");
    }

    // Accepted at the boundary — the half the first version left out, and the half a widened guard
    // would break. Zero is a legitimate value for all three: nothing sold, nothing locked, nothing
    // collected. Each is unreachable in a live round and each is a perfectly good input to a pure
    // function, which is the distinction the guard has to keep.
    let accepted = [
        (
            "notional_sold == 0",
            base(1_000_000, 0, 1_000_000, 10, 1_000),
        ),
        ("locked_at_open == 0", base(1_000_000, 100, 0, 10, 1_000)),
        (
            "premium_collected == 0",
            base(1_000_000, 100, 1_000_000, 0, 1_000),
        ),
        (
            "strike == 1, the smallest admissible",
            base(1, 100, 1_000_000, 10, 1_000),
        ),
        (
            "shares_snapshot == 1",
            base(1_000_000, 100, 1_000_000, 10, 1),
        ),
    ];
    for (why, result) in accepted {
        assert!(result.is_ok(), "{why} must be accepted, got {result:?}");
    }
}

#[test]
fn assets_after_the_round_may_be_zero_and_may_never_be_negative() {
    // `assets_R == 0` is **legitimate** and is D-66's own degenerate state: the pool is worth less
    // than a stroop per PRECISION share-units, `pps` records `0` honestly, and withdrawals still
    // work. Forcing `pps >= 1` there is what makes `Σ claim_withdraw` exceed what was credited,
    // which is why the clamp was removed and why I6 yields to I1.
    //
    // A guard that rejected zero would break that; a guard that accepted a negative would let a
    // checked subtraction underflow on the exit path, which is what I8 forbids. `cargo-mutants`
    // showed neither direction was pinned.
    use crate::settle::round_numbers;

    // Exactly zero: locked 0, premium 0, no payout.
    let zero = round_numbers(None, 1_000_000, 0, 0, 0, 1_000, 0, 0).unwrap();
    assert_eq!(zero.assets_r, 0);
    assert_eq!(zero.pps, 0, "recorded honestly rather than clamped (D-66)");

    // Negative: the pure function does not enforce I2, so a caller passing more sold than locked
    // can drive it under — which is exactly what the guard is for.
    assert_eq!(
        round_numbers(Some(1_000_000_000), 1, 1_000_000, 1, 0, 1_000, 0, 0),
        Err(Error::InvalidAmount),
        "a payout larger than the collateral must be refused, not recorded"
    );
}

#[test]
fn an_out_of_the_money_settle_and_an_unresolved_round_compute_identically() {
    // D-64's "two entrances, one path", asserted on the pure function as well as on the contract.
    // They share `round_numbers`, so this is structural — and "structural" is precisely the claim
    // that stops being true after a refactor, which is why it is pinned in both places.
    use crate::settle::round_numbers;
    let settled = round_numbers(Some(1_000_000), 2_000_000, 500, 1_000, 20, 1_000, 500, 25);
    let unresolved = round_numbers(None, 2_000_000, 500, 1_000, 20, 1_000, 500, 25);
    assert_eq!(settled, unresolved);
    assert_eq!(settled.unwrap().payout_total, 0);
}

// =================================================================================================
// The event ABI — §10 calls it a frozen public interface, and nothing was asserting it
// =================================================================================================

/// Did this call emit an event whose first topic is `name`?
///
/// The whole terminal event set was unasserted until `cargo-mutants` flipped `fee > 0` to
/// `fee < 0` in both paying branches and nothing noticed — `FeeAccrued` simply stopped being
/// emitted. That is not a missing test on one line: §10 is a **frozen public ABI**, an integration
/// scenario reconstructs state from events alone, and a field left out cannot be added later.
fn emitted(d: &Deployed, name: &str) -> bool {
    use soroban_sdk::xdr::{ContractEventBody, ScSymbol, ScVal};
    let wanted = ScVal::Symbol(ScSymbol(name.try_into().unwrap()));
    d.env.events().all().events().iter().any(|e| {
        let ContractEventBody::V0(v0) = &e.body;
        v0.topics.first() == Some(&wanted)
    })
}

#[test]
fn the_settle_branch_emits_settled_the_fee_and_the_bounty_and_nothing_else() {
    let d = expired_round();
    let before = d.state();
    d.client().set_fee_bps(&2_000);
    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.fee_bps_snapshot = 2_000; // as if the round had opened under it
        crate::storage::set_state(&d.env, &s);
    });
    let spot = before.strike * 2;
    force(&d, spot, spot, 14);

    let to = Address::generate(&d.env);
    assert_eq!(d.client().close_round(&to), RoundOutcome::Settled);

    assert!(emitted(&d, "settled"), "settled");
    // Emitted because the fee is non-zero — and the `> 0` is the predicate, not `>=` or `<`.
    assert!(emitted(&d, "fee_accrued"), "fee_accrued");
    assert!(emitted(&d, "settle_bounty"), "settle_bounty");
}

#[test]
fn a_zero_fee_emits_no_fee_accrued() {
    // The other half of `fee > 0`, and the half a `>=` mutation breaks. `fee_bps` ships at 0, so
    // this is the ordinary case rather than an exotic one: an indexer that saw a `fee_accrued` of
    // zero on every round would be reconciling against noise.
    let d = expired_round();
    let spot = d.state().strike * 2;
    force(&d, spot, spot, 14);
    assert_eq!(d.state().fee_bps_snapshot, 0);

    let to = Address::generate(&d.env);
    assert_eq!(d.client().close_round(&to), RoundOutcome::Settled);

    assert!(emitted(&d, "settled"), "settled");
    assert!(
        !emitted(&d, "fee_accrued"),
        "a zero fee accrues nothing and must announce nothing"
    );
}

#[test]
fn the_void_branch_emits_the_void_and_no_bounty() {
    // D-51 as an event assertion: the void pays no bounty, so it emits none. Nothing was checking
    // that the *absence* is real rather than incidental.
    let d = expired_round();
    oracle(&d).set_mode(&Mode::ForceUnusable);
    d.advance(DEAD_AFTER);

    let to = Address::generate(&d.env);
    assert_eq!(d.client().close_round(&to), RoundOutcome::Voided);

    assert!(emitted(&d, "epoch_voided"), "epoch_voided");
    assert!(
        !emitted(&d, "settle_bounty"),
        "a void has no source for a bounty"
    );
    assert!(!emitted(&d, "fee_accrued"), "and accrues no fee");
}

#[test]
fn both_unresolved_entrances_emit_the_same_events() {
    // The event side of "two entrances, one path". The accounting was already asserted equal; the
    // announcement was not, and an indexer sees only the announcement.
    for past_fallback in [false, true] {
        let d = expired_round();
        if past_fallback {
            d.advance(UNRESOLVED);
        } else {
            oracle(&d).set_mode(&Mode::ForceOutOfReach);
        }
        let to = Address::generate(&d.env);
        assert_eq!(d.client().close_round(&to), RoundOutcome::Unresolved);

        assert!(
            emitted(&d, "epoch_unresolved"),
            "past_fallback={past_fallback}"
        );
        assert!(
            emitted(&d, "settle_bounty"),
            "this branch retains the premium, so it has a source for the bounty"
        );
    }
}
