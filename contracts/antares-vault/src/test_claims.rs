//! §2.8's unit inventory — the three claims, and the last place money leaves.
//!
//! `06-TEST-PLAN.md` §2's claims entry is the list; `DEV-PROTOCOL.md` §6 is the bar — **every guard
//! has a test that drives it to reject.**
//!
//! Two properties here are not about a single guard and are the reason this file is longer than the
//! module: **I8** (all three work in any phase and while paused) and **the void branch draining
//! `bidder_claimable_total` to exactly zero**, which is stronger than §6's aggregate-dust rule and
//! is the ruling DEV2 was waiting on.

extern crate std;

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{xdr, Address};

use crate::errors::Error;
use crate::test_common::{deploy_at, Deployed};
use crate::types::{Fill, Phase, Round, RoundOutcome};

const XLM: i128 = 10_000_000;
const NOW: u64 = 1_800_000_000;

/// A finalized round with fills already recorded, written straight to storage.
///
/// `close_round` is DEV2's and `bid` needs a live auction with an oracle; neither is the subject
/// here, and driving both would make every claim test depend on two modules it is not testing.
/// The same caveat DEV1 attached to `open_round_manually` applies and is why it is written down:
/// this cannot prove `close_round` produces *this* record, so every test built on it is re-run
/// against the real settlement at IP-4.
struct Closed {
    f: Deployed,
    bidders: std::vec::Vec<Address>,
}

fn closed_round(
    outcome: RoundOutcome,
    settled_spot: i128,
    strike: i128,
    fills: &[(i128, i128)],
) -> Closed {
    let f = deploy_at(NOW, 0);
    let mut bidders = std::vec::Vec::new();

    // **From the total notional, the way `close_round` computes it** — not the sum of the
    // per-fill payouts. The first version of this fixture summed the per-bidder amounts, which
    // makes `payout_total` equal to `Σ per-bidder` by construction and so hides the floor dust
    // entirely: the residue exists precisely because `Σ⌊xᵢ⌋ ≤ ⌊Σxᵢ⌋`, and a fixture that computes
    // the left-hand side and calls it the right-hand side can never show it.
    let notional_sold: i128 = fills.iter().map(|(n, _)| n).sum();
    let payout_total: i128 = if outcome == RoundOutcome::Settled && settled_spot > strike {
        notional_sold * (settled_spot - strike) / settled_spot
    } else {
        0
    };
    let premium_collected: i128 = fills.iter().map(|(_, premium)| premium).sum();
    // The void branch refunds premium; the settle branch owes payouts. Whichever the round is, the
    // pool holds exactly what the claims will draw down.
    let pool = if outcome == RoundOutcome::Voided {
        premium_collected
    } else {
        payout_total
    };

    for (index, (notional, premium)) in fills.iter().enumerate() {
        let bidder = Address::generate(&f.env);
        f.env.as_contract(&f.vault, || {
            let config = crate::storage::get_config(&f.env).unwrap();
            let rent = crate::storage::Rent::effective(&f.env, &config);
            crate::storage::set_fill(
                &f.env,
                rent,
                1,
                &bidder,
                &Fill {
                    notional: *notional,
                    premium_paid: *premium,
                    claimed: false,
                },
            );
            let _ = index;
        });
        bidders.push(bidder);
    }

    f.env.as_contract(&f.vault, || {
        let config = crate::storage::get_config(&f.env).unwrap();
        let rent = crate::storage::Rent::effective(&f.env, &config);
        crate::storage::set_round(
            &f.env,
            rent,
            1,
            &Round {
                outcome,
                pps: 10_000_000,
                strike,
                expiry: NOW + 1_000,
                notional_sold,
                premium: premium_collected,
                fee: 0,
                settled_spot: if outcome == RoundOutcome::Settled {
                    settled_spot
                } else {
                    0
                },
                payout_total,
            },
        );
        let mut st = crate::storage::get_state(&f.env).unwrap();
        st.round = 1;
        st.phase = Phase::Idle;
        st.bidder_claimable_total = pool;
        st.last_pps = 10_000_000;
        crate::storage::set_state(&f.env, &st);
    });

    // The vault must actually hold the XLM it is about to pay out, or the transfers fail for a
    // reason that has nothing to do with the code under test.
    f.fund(&f.vault, pool + 1_000 * XLM);

    Closed { f, bidders }
}

impl Closed {
    fn state(&self) -> crate::types::State {
        self.f.state()
    }
    fn claimable_total(&self) -> i128 {
        self.state().bidder_claimable_total
    }
    fn payout(&self, who: &Address) -> Result<i128, Error> {
        self.f
            .client()
            .try_claim_payout(&1, who)
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    }
    fn refund(&self, who: &Address) -> Result<i128, Error> {
        self.f
            .client()
            .try_claim_refund(&1, who)
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    }
    fn fill(&self, who: &Address) -> Option<Fill> {
        self.f.env.as_contract(&self.f.vault, || {
            crate::storage::get_fill(&self.f.env, 1, who)
        })
    }
}

// A settled round, 0.50 spot against a 0.44 strike — 05 §4's numbers.
fn settled() -> Closed {
    closed_round(
        RoundOutcome::Settled,
        5_000_000,
        4_400_000,
        &[(6_000 * XLM, 72 * XLM), (4_000 * XLM, 16 * XLM)],
    )
}

fn voided() -> Closed {
    closed_round(
        RoundOutcome::Voided,
        0,
        4_400_000,
        &[(6_000 * XLM, 72 * XLM), (4_000 * XLM, 16 * XLM)],
    )
}

// =================================================================================================
// claim_payout
// =================================================================================================

#[test]
fn a_payout_is_recomputed_from_the_round_record_and_matches_the_worked_example() {
    let c = settled();
    let (a, b) = (c.bidders[0].clone(), c.bidders[1].clone());

    // 05 §4 step 5: A claims ⌊6 000 × 0.06/0.5⌋ = 720, B claims 480, Σ = 1 200 = payout_total.
    assert_eq!(c.payout(&a).unwrap(), 720 * XLM);
    assert_eq!(c.payout(&b).unwrap(), 480 * XLM);
    assert_eq!(
        720 * XLM + 480 * XLM,
        c.state().bidder_claimable_total + 1_200 * XLM
    );
}

#[test]
fn the_sum_of_payouts_never_exceeds_the_pool_and_the_floor_dust_stays_in_it() {
    // §6/D-20: `Σ⌊xᵢ⌋ ≤ ⌊Σxᵢ⌋`, so per-bidder flooring leaves a residue in the vault's favour.
    // Constructed with notionals that do not divide evenly, which is the only way to see it.
    let c = closed_round(
        RoundOutcome::Settled,
        3,
        1,
        &[(1_000, 1), (1_000, 1), (1_000, 1)],
    );
    let pool_before = c.claimable_total();
    let mut paid = 0;
    for bidder in c.bidders.clone() {
        paid += c.payout(&bidder).unwrap();
    }
    assert!(
        paid <= pool_before,
        "Σ per-bidder must not exceed payout_total"
    );
    assert!(
        c.claimable_total() >= 0,
        "the residue stays in the pool, never negative"
    );
    assert_eq!(c.claimable_total(), pool_before - paid);
}

#[test]
fn a_payout_marks_the_fill_and_pays_the_bidder() {
    let c = settled();
    let a = c.bidders[0].clone();
    let before = c.f.balance(&a);

    let amount = c.payout(&a).unwrap();
    assert_eq!(c.f.balance(&a), before + amount);

    // §16: kept with `claimed = true`, never deleted — the record is the bidder's own receipt.
    let fill = c.fill(&a).expect("the Fill must survive the claim");
    assert!(fill.claimed);
    assert_eq!(fill.notional, 6_000 * XLM, "the fill itself is unchanged");
    assert_eq!(fill.premium_paid, 72 * XLM);
}

#[test]
fn refuses_a_second_claim_with_already_claimed_and_never_no_fill() {
    // The reason §16 forbids deleting the record: `AlreadyClaimed` says "you already have it",
    // `NoFill` says "you never had it", and a bidder chasing a missing payment needs the first.
    let c = settled();
    let a = c.bidders[0].clone();
    c.payout(&a).unwrap();
    assert_eq!(c.payout(&a), Err(Error::AlreadyClaimed));
}

#[test]
fn refuses_a_zero_payout_round_with_nothing_to_claim_and_leaves_the_fill_unclaimed() {
    // §16: spot at or below the strike pays nothing; the Fill stays unclaimed forever, which costs
    // the vault nothing. Asserted rather than assumed, because marking it would silently consume a
    // record the bidder may still need.
    let c = closed_round(
        RoundOutcome::Settled,
        4_200_000,
        4_400_000,
        &[(6_000 * XLM, 72 * XLM)],
    );
    let a = c.bidders[0].clone();
    assert_eq!(c.payout(&a), Err(Error::NothingToClaim));
    assert!(
        !c.fill(&a).unwrap().claimed,
        "a refused claim marks nothing"
    );
}

#[test]
fn refuses_the_wrong_outcome_a_missing_fill_and_a_round_that_never_existed() {
    let c = settled();
    let a = c.bidders[0].clone();

    // A settled round has no refund to give.
    assert_eq!(c.refund(&a), Err(Error::WrongOutcome));

    // An address that never filled — distinct from an address with a claimed fill.
    let stranger = Address::generate(&c.f.env);
    assert_eq!(c.payout(&stranger), Err(Error::NoFill));

    // And a round that was never opened. §12 makes this distinct from *archived*, which the caller
    // meets at simulation as a third case.
    let r =
        c.f.client()
            .try_claim_payout(&99, &a)
            .map_err(|e| e.unwrap())
            .map(|x| x.unwrap());
    assert_eq!(r, Err(Error::RoundNotFound));
}

// =================================================================================================
// claim_refund — and the drain-to-zero that is stronger than §6's dust rule
// =================================================================================================

#[test]
fn a_refund_is_each_fills_own_premium_exactly() {
    // 05 §2: "Refunds after a void are exact — no dust at all." Two bidders on a descending curve
    // paid different rates, so any pro-rata arithmetic would redistribute between them.
    let c = voided();
    let (a, b) = (c.bidders[0].clone(), c.bidders[1].clone());
    assert_eq!(c.refund(&a).unwrap(), 72 * XLM);
    assert_eq!(c.refund(&b).unwrap(), 16 * XLM);
}

#[test]
fn the_void_branch_drains_bidder_claimable_total_to_exactly_zero() {
    // **The ruling DEV2 was waiting on, asserted rather than stated.**
    //
    // §6 warns that `bidder_claimable_total` "may retain a permanent, unclaimable residue of a few
    // stroops per round". That is true of **payouts**, where `Σ⌊xᵢ⌋ ≤ ⌊Σxᵢ⌋` leaves floor dust. It
    // is **not** true of refunds: each `premium_paid` is a recorded integer that the same bid added
    // to the pool, so `Σ refunds == premium_collected` with nothing left over.
    //
    // So the void branch is the one place in the contract where that counter provably returns to
    // zero — equality, not `≥` — and the asymmetry with the settle branch is the point.
    let c = voided();
    assert_eq!(c.claimable_total(), 88 * XLM, "the whole premium is owed");
    for bidder in c.bidders.clone() {
        c.refund(&bidder).unwrap();
    }
    assert_eq!(
        c.claimable_total(),
        0,
        "a voided round leaves no residue, unlike a settled one"
    );
}

#[test]
fn a_settled_round_by_contrast_may_leave_a_residue() {
    // The other half of the asymmetry, so the claim above is a comparison rather than an assertion
    // about one branch. Same fills, uneven division: the pool does not reach zero.
    let c = closed_round(
        RoundOutcome::Settled,
        3,
        1,
        &[(1_000, 1), (1_000, 1), (1_000, 1)],
    );
    for bidder in c.bidders.clone() {
        c.payout(&bidder).unwrap();
    }
    assert!(
        c.claimable_total() > 0,
        "floor dust stays in the pool, in the vault's favour"
    );
}

#[test]
fn refuses_a_refund_twice_and_on_the_wrong_outcome() {
    let c = voided();
    let a = c.bidders[0].clone();
    c.refund(&a).unwrap();
    assert_eq!(c.refund(&a), Err(Error::AlreadyClaimed));
    // A voided round has no payout to give.
    let b = c.bidders[1].clone();
    assert_eq!(c.payout(&b), Err(Error::WrongOutcome));
}

// =================================================================================================
// claim_fee
// =================================================================================================

#[test]
fn only_the_fee_recipient_may_claim_the_fee_and_it_zeroes_the_accrual() {
    let c = settled();
    c.f.env.as_contract(&c.f.vault, || {
        let mut st = crate::storage::get_state(&c.f.env).unwrap();
        st.fee_claimable = 5 * XLM;
        crate::storage::set_state(&c.f.env, &st);
    });
    c.f.fund(&c.f.vault, 5 * XLM);

    let before = c.f.balance(&c.f.fee_recipient);
    assert_eq!(c.f.client().claim_fee(), 5 * XLM);
    assert_eq!(c.f.balance(&c.f.fee_recipient), before + 5 * XLM);
    assert_eq!(c.state().fee_claimable, 0);
}

#[test]
fn refuses_a_fee_claim_when_nothing_has_accrued() {
    // It ships at zero (D-56) and stays there until a visible admin transaction moves it, so this
    // is the ordinary state rather than an edge case.
    let c = settled();
    assert_eq!(c.state().fee_claimable, 0);
    let r =
        c.f.client()
            .try_claim_fee()
            .map_err(|e| e.unwrap())
            .map(|x| x.unwrap());
    assert_eq!(r, Err(Error::NothingToClaim));
}

// =================================================================================================
// I8 — all three work in any phase, and while paused
// =================================================================================================

#[test]
fn all_three_claims_work_while_paused_and_during_a_live_round() {
    // **I8, and it is the property the whole pull-based design exists to make true.** Pause is a
    // deposit-side control; it may never stand between someone and money already owed. Driven
    // rather than reasoned about, because "unpausable" is a one-word claim that is easy to write
    // and easy to omit from a guard.
    for outcome in [RoundOutcome::Settled, RoundOutcome::Voided] {
        let c = closed_round(outcome, 5_000_000, 4_400_000, &[(6_000 * XLM, 72 * XLM)]);
        let a = c.bidders[0].clone();

        c.f.client().set_paused(&true);
        // And a live round on top of the pause, since the claims are also phase-free.
        c.f.env.as_contract(&c.f.vault, || {
            let mut st = crate::storage::get_state(&c.f.env).unwrap();
            st.round = 2;
            st.phase = Phase::Active;
            st.auction_end = NOW + 10;
            st.expiry = NOW + 10_000;
            crate::storage::set_state(&c.f.env, &st);
        });
        c.f.env.ledger().set_timestamp(NOW + 50);

        let claimed = if outcome == RoundOutcome::Settled {
            c.payout(&a)
        } else {
            c.refund(&a)
        };
        assert!(
            claimed.is_ok(),
            "{outcome:?} claim must survive pause + a live round"
        );

        c.f.env.as_contract(&c.f.vault, || {
            let mut st = crate::storage::get_state(&c.f.env).unwrap();
            st.fee_claimable = XLM;
            crate::storage::set_state(&c.f.env, &st);
        });
        c.f.fund(&c.f.vault, XLM);
        assert_eq!(c.f.client().claim_fee(), XLM, "claim_fee is unpausable too");
    }
}

// =================================================================================================
// §10's frozen ABI
// =================================================================================================

fn event_parts(e: &xdr::ContractEvent) -> (std::vec::Vec<xdr::ScVal>, xdr::ScVal) {
    match &e.body {
        xdr::ContractEventBody::V0(v0) => (v0.topics.to_vec(), v0.data.clone()),
    }
}

fn symbol_is(v: &xdr::ScVal, want: &str) {
    match v {
        xdr::ScVal::Symbol(s) => {
            assert_eq!(std::str::from_utf8(s.0.as_slice()).unwrap(), want)
        }
        other => panic!("expected a symbol, got {other:?}"),
    }
}

#[test]
fn the_three_claim_events_carry_exactly_what_ss10_fixes() {
    // §10 is frozen: a field renamed or dropped is what an events-only indexer cannot recover
    // from, while a length check passes straight through it.
    let c = voided();
    let a = c.bidders[0].clone();
    c.refund(&a).unwrap();
    let emitted =
        c.f.env
            .events()
            .all()
            .filter_by_contract(&c.f.vault)
            .events()
            .to_vec();
    assert_eq!(
        emitted.len(),
        1,
        "the vault emits one event; the SAC emits its own"
    );
    let (topics, _) = event_parts(emitted.first().unwrap());
    assert_eq!(topics.len(), 3, "refund_claimed is (name, round, bidder)");
    symbol_is(&topics[0], "refund_claimed");

    let s = settled();
    let sa = s.bidders[0].clone();
    s.payout(&sa).unwrap();
    let e2 =
        s.f.env
            .events()
            .all()
            .filter_by_contract(&s.f.vault)
            .events()
            .to_vec();
    let (t2, _) = event_parts(e2.first().unwrap());
    assert_eq!(t2.len(), 3);
    symbol_is(&t2[0], "payout_claimed");

    // **`fee_claimed` carries two topics, not three** — §10: `claim_fee` spans rounds and therefore
    // carries no round. An indexer that invented one would present the fee as a per-round balance.
    s.f.env.as_contract(&s.f.vault, || {
        let mut st = crate::storage::get_state(&s.f.env).unwrap();
        st.fee_claimable = XLM;
        crate::storage::set_state(&s.f.env, &st);
    });
    s.f.fund(&s.f.vault, XLM);
    s.f.client().claim_fee();
    let e3 =
        s.f.env
            .events()
            .all()
            .filter_by_contract(&s.f.vault)
            .events()
            .to_vec();
    let (t3, _) = event_parts(e3.first().unwrap());
    assert_eq!(
        t3.len(),
        2,
        "fee_claimed is (name, recipient) and carries no round"
    );
    symbol_is(&t3[0], "fee_claimed");
}

#[test]
fn a_rejected_claim_emits_nothing() {
    // §10's second binding rule, asserted on the rejecting path rather than only the happy one.
    let c = settled();
    let stranger = Address::generate(&c.f.env);
    assert_eq!(c.payout(&stranger), Err(Error::NoFill));
    assert_eq!(
        c.f.env
            .events()
            .all()
            .filter_by_contract(&c.f.vault)
            .events()
            .len(),
        0
    );
}
