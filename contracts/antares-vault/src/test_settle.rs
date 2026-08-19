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
use soroban_sdk::{testutils::Address as _, Address};

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

    // Move `Config.fee_bps` mid-round. `set_fee_bps` is DEV1's and lands in Phase 4; until it does
    // the field is moved through storage. A harness affordance, recorded as one.
    d.env.as_contract(&d.vault, || {
        let mut c = crate::storage::get_config(&d.env).unwrap();
        c.fee_bps = 2_000; // 20 %, the validation ceiling
        crate::storage::set_config(&d.env, &c);
    });

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
    d.env.as_contract(&d.vault, || {
        let mut c = crate::storage::get_config(&d.env).unwrap();
        c.fee_recipient = Address::generate(&d.env);
        c.fee_bps = 2_000;
        crate::storage::set_config(&d.env, &c);
    });
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
fn round_numbers_refuses_every_input_outside_its_domain() {
    // `06-TEST-PLAN.md` §4: *every crash becomes a permanent regression unit test*. This is
    // `fuzz_settlement_math`'s first, found within seconds of the target existing.
    //
    // At `notional_sold < 0` the settlement math produced a **negative payout** — arithmetically
    // consistent and economically a transfer *from* the bidder. No caller can construct it:
    // `notional_sold` starts at 0 and only `bid` raises it. "No caller can" was the load-bearing
    // word, and it is exactly the kind this layer exists to distrust — the function already
    // refused to *return* a negative `assets_R` while trusting every number it was handed.
    use crate::settle::round_numbers;

    // The legitimate shape, so the rejections below are about one field each.
    let ok = round_numbers(Some(2_000_000), 1_000_000, 100, 1_000, 10, 1_000, 0, 25);
    assert!(
        ok.is_ok(),
        "the baseline must be accepted or this test proves nothing"
    );

    let cases: [(&str, Result<crate::settle::RoundNumbers, Error>); 5] = [
        (
            "notional_sold < 0 — the crash",
            round_numbers(Some(2_000_000), 1_000_000, -1, 1_000, 10, 1_000, 0, 25),
        ),
        (
            "strike <= 0",
            round_numbers(Some(2_000_000), 0, 100, 1_000, 10, 1_000, 0, 25),
        ),
        (
            "shares_snapshot <= 0",
            round_numbers(Some(2_000_000), 1_000_000, 100, 1_000, 10, 0, 0, 25),
        ),
        (
            "locked_at_open < 0",
            round_numbers(Some(2_000_000), 1_000_000, 100, -1, 10, 1_000, 0, 25),
        ),
        (
            "premium_collected < 0",
            round_numbers(Some(2_000_000), 1_000_000, 100, 1_000, -1, 1_000, 0, 25),
        ),
    ];
    for (why, result) in cases {
        assert_eq!(result, Err(Error::InvalidAmount), "{why}");
    }
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
