//! I1 and I5 over arbitrary call sequences — `06-TEST-PLAN.md` §3, Phase 2's half.
//!
//! I1–I10 comes at Phase 4. These two are here because they are the two that can
//! be asserted without a settlement path, and because they are the two whose
//! violation costs someone their principal rather than a wrong number in a record.
//!
//! **Asserted after every call, not at the end.** A sequence that ends solvent
//! having passed through an insolvent state is not solvent — the intermediate
//! state is one a real transaction could have observed, and I1 quantifies over
//! reachable states rather than final ones.
//!
//! # What is exercised, stated rather than implied
//!
//! I1's five terms are all asserted, so the assertion needs no edit when the
//! remaining paths land. But only three of them can currently *move*:
//!
//! | term | moved by | exercised here |
//! |---|---|---|
//! | `locked_assets` | deposit, redeem, instant withdraw, finalization | yes |
//! | `pending_deposits_total` | deposit during a live round, cancel, redeem | yes |
//! | `withdraw_claimable_total` | finalization, claim | yes |
//! | `bidder_claimable_total` | settlement and the bidder claims | **no — `bid` is DEV3's and unwritten** |
//! | `fee_claimable` | settlement | **no — a fee accrues only on a round that sold something** |
//!
//! With no `bid`, no round can fill, so every round lapses and the last two terms
//! stay at zero. **The suite reports that rather than leaving it to be assumed**:
//! `observed_liabilities` records the maximum each term reached, and the test
//! asserts the three that should move did. A five-term assertion over a
//! three-term state is exactly the "green but proves less than it claims" shape
//! this project keeps finding, and naming it is the only defence available until
//! Phase 4.
//!
//! I5 is worth more now than it would have been two blocks ago. Until SEP-41
//! landed, shares moved only through mint and burn — both in one file, both mine.
//! Now `transfer`, `transfer_from`, `burn_from` and `request_withdraw` all write
//! balances, and `request_withdraw` burns immediately while the pending record it
//! creates does not. **Four writers, one sum.**

#![allow(clippy::inconsistent_digit_grouping)]

// The crate is `#![no_std]`; proptest is not. Bound here rather than crate-wide so
// the deployed wasm is untouched — this module only ever compiles under `cfg(test)`.
extern crate std;
use std::{format, vec};

use crate::test_common::{deploy_no_snapshot, Deployed};
use crate::types::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address,
};

const XLM: i128 = 1_0000000;

/// Four actors is enough to reach every shape that matters — a sender, a
/// receiver, a spender and a bystander — and small enough that `Σ balances` is a
/// closed sum rather than a scan.
const ACTORS: usize = 4;

/// 0.16 USD at the mock's 14 decimals.
const PX: i128 = 16_000_000_000_000;

#[derive(Debug, Clone)]
enum Op {
    Deposit {
        who: usize,
        amount: i128,
    },
    Cancel {
        who: usize,
    },
    Redeem {
        who: usize,
    },
    RequestWithdraw {
        who: usize,
        part: u32,
        require_idle: bool,
    },
    ClaimWithdraw {
        who: usize,
    },
    Transfer {
        from: usize,
        to: usize,
        part: u32,
    },
    TransferFrom {
        spender: usize,
        from: usize,
        to: usize,
        part: u32,
    },
    Burn {
        who: usize,
        part: u32,
    },
    BurnFrom {
        spender: usize,
        from: usize,
        part: u32,
    },
    Approve {
        from: usize,
        spender: usize,
        amount: i128,
    },
    Restore {
        who: usize,
    },
    Pause(bool),
    SetFee(u32),
    OpenEpoch,
    CloseRound {
        bounty_to: usize,
    },
    /// Added 2026-08-19 (DEV3) **together with `assert_i2`, and neither is useful without the
    /// other.** I2 bounds `notional_sold`, and `notional_sold` moves only in `bid` — so an
    /// `assert_i2` added to a suite with no bidding is an assertion that cannot fail, which is the
    /// defect this project has recorded five times in other guises. The op is what makes the
    /// assertion real; the `i2_sold_seen` counter is what proves it stayed real.
    Bid {
        who: usize,
        part: u32,
        max_bps: u32,
    },
    Jump(u64),
}

fn actor() -> impl Strategy<Value = usize> {
    0..ACTORS
}

/// Amounts straddle `min_deposit` deliberately: a generator that only produced
/// valid deposits would never exercise the rejection paths, and a rejection that
/// leaves state half-written is exactly what I1 is looking for.
fn amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        Just(0i128),
        Just(1i128),
        Just(9 * XLM),  // just under min_deposit
        Just(10 * XLM), // exactly min_deposit
        11 * XLM..500 * XLM,
    ]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (actor(), amount()).prop_map(|(who, amount)| Op::Deposit { who, amount }),
        2 => actor().prop_map(|who| Op::Cancel { who }),
        2 => actor().prop_map(|who| Op::Redeem { who }),
        6 => (actor(), 0u32..=100, any::<bool>())
            .prop_map(|(who, part, require_idle)| Op::RequestWithdraw { who, part, require_idle }),
        3 => actor().prop_map(|who| Op::ClaimWithdraw { who }),
        4 => (actor(), actor(), 0u32..=100)
            .prop_map(|(from, to, part)| Op::Transfer { from, to, part }),
        2 => (actor(), actor(), actor(), 0u32..=100)
            .prop_map(|(spender, from, to, part)| Op::TransferFrom { spender, from, to, part }),
        3 => (actor(), 0u32..=100).prop_map(|(who, part)| Op::Burn { who, part }),
        2 => (actor(), actor(), 0u32..=100)
            .prop_map(|(spender, from, part)| Op::BurnFrom { spender, from, part }),
        2 => (actor(), actor(), amount())
            .prop_map(|(from, spender, amount)| Op::Approve { from, spender, amount }),
        1 => actor().prop_map(|who| Op::Restore { who }),
        1 => any::<bool>().prop_map(Op::Pause),
        1 => (0u32..=2_000).prop_map(Op::SetFee),
        4 => Just(Op::OpenEpoch),
        3 => actor().prop_map(|bounty_to| Op::CloseRound { bounty_to }),
        // Weighted like `Deposit` and `RequestWithdraw` rather than like `Restore`: I2 is only
        // checkable in states where something sold, and a rare bid makes those states rare.
        // `part` starts at 1: at 0 the fill computes to nothing and the call is `InvalidAmount`
        // before it can reach the curve, so a zero-weighted share of the op would be spent proving
        // the amount guard the unit tests already drive.
        //
        // `max_bps` is weighted 6:1 toward "no limit". `valid_params`' curve starts at 450 bps, so
        // an unweighted choice among {10 000, 300, 100, 20} rejects three bids in four with
        // `PremiumAboveMax` — which is a real guard and worth hitting, but not worth spending most
        // of the op on. Measured before the weighting: 8 bids in a sequence, 0 fills.
        6 => (
            actor(),
            1u32..=400,
            prop_oneof![6 => Just(10_000u32), 1 => Just(460), 1 => Just(300), 1 => Just(20)],
        )
            .prop_map(|(who, part, max_bps)| Op::Bid { who, part, max_bps }),
        5 => prop_oneof![Just(1u64), Just(60), Just(120), Just(1_200), Just(4_000)]
            .prop_map(Op::Jump),
    ]
}

/// What each of I1's five terms reached across a run.
#[derive(Default, Debug)]
struct Observed {
    /// How many times I2 was checked **with something actually sold** — the count that stops
    /// `assert_i2` from being vacuous. `notional_sold` is 0 in every state no bid has reached, and
    /// `0 <= offered` is true of a vault nobody has bid into, so without this the assertion could
    /// pass forever on a suite that never fills anything.
    i2_sold: u32,
    /// Highest round number reached. Zero means no epoch ever opened, which would
    /// make every `OpenEpoch` and `CloseRound` in the sequence a silent no-op.
    round: u32,
    locked: i128,
    pending: i128,
    withdraw_claimable: i128,
    bidder_claimable: i128,
    fee_claimable: i128,
    /// How many times I9 was checked **with a real shareholder present** — Idle,
    /// and supply above `DEAD_SHARES`. An assertion behind a phase guard is
    /// vacuous whenever the guard never opens, so the count is asserted rather
    /// than assumed. Measured once at 418 of 1 029 Idle checks across the suite;
    /// what matters per case is that it is not zero.
    i9_backed: usize,
}

struct World {
    d: Deployed,
    actors: [Address; ACTORS],
    observed: Observed,
}

impl World {
    fn new() -> World {
        // `deploy_no_snapshot`, not `deploy`: see its doc comment. Every test in this module is
        // generated, so every snapshot it would write is a record of one arbitrary sequence.
        let d = deploy_no_snapshot();
        let actors = core::array::from_fn(|_| {
            let a = Address::generate(&d.env);
            d.fund(&a, 10_000 * XLM);
            a
        });
        let w = World {
            d,
            actors,
            observed: Observed::default(),
        };
        w.prime_feed();
        w
    }

    /// Keep the mock healthy at the current instant.
    ///
    /// Called at setup and **after every time jump**, and the second half is the
    /// load-bearing one. `max_staleness` is 30 s in this profile while the jumps
    /// are up to 4 000, so a feed primed once goes stale inside the first jump and
    /// every `open_epoch` afterwards would refuse — for a fixture reason rather
    /// than a protocol one. A generator whose most interesting operation silently
    /// never fires is the same "green but proves less" shape this suite's header
    /// warns about, so the feed is refreshed rather than assumed.
    fn prime_feed(&self) {
        let now = self.d.env.ledger().timestamp();
        let o = mock_price_source::MockPriceSourceClient::new(&self.d.env, &self.d.oracle);
        o.fill(&now, &40, &PX);
        o.set_expires(&Some(now + 1_000_000));
    }

    fn shares(&self, who: &Address) -> i128 {
        self.d.env.as_contract(&self.d.vault, || {
            crate::storage::get_shares(&self.d.env, who)
        })
    }

    /// A fraction of a holding, so the generator does not have to guess balances
    /// it cannot see. `part == 0` is kept: a zero-share request is a rejection
    /// path, and rejections are where half-written state would show.
    fn part_of(&self, who: &Address, part: u32) -> i128 {
        let held = self.shares(who);
        held.saturating_mul(i128::from(part)) / 100
    }

    /// **I1, extended, all five terms** (02-CONTRACT-SPEC §9). Every one is a
    /// promise somebody can come and collect; the inequality is `≥` because
    /// floored dust and raw donations are expected slack.
    fn assert_i1(&mut self, after: &str) {
        let st = self.d.state();
        let liabilities = st
            .locked_assets
            .checked_add(st.pending_deposits_total)
            .and_then(|t| t.checked_add(st.withdraw_claimable_total))
            .and_then(|t| t.checked_add(st.bidder_claimable_total))
            .and_then(|t| t.checked_add(st.fee_claimable))
            .expect("I1's five terms overflowed i128, which §8's bounds forbid");

        let held = self.d.balance(&self.d.vault);
        assert!(
            held >= liabilities,
            "I1 violated after {after}: the vault holds {held} and owes {liabilities} \
             (locked {} + pending {} + withdraw {} + bidder {} + fee {})",
            st.locked_assets,
            st.pending_deposits_total,
            st.withdraw_claimable_total,
            st.bidder_claimable_total,
            st.fee_claimable,
        );

        self.observed.round = self.observed.round.max(st.round);
        self.observed.locked = self.observed.locked.max(st.locked_assets);
        self.observed.pending = self.observed.pending.max(st.pending_deposits_total);
        self.observed.withdraw_claimable = self
            .observed
            .withdraw_claimable
            .max(st.withdraw_claimable_total);
        self.observed.bidder_claimable = self
            .observed
            .bidder_claimable
            .max(st.bidder_claimable_total);
        self.observed.fee_claimable = self.observed.fee_claimable.max(st.fee_claimable);
    }

    /// **I9**: while Idle, `locked_assets × PRECISION ≥ shares_outstanding × last_pps`.
    ///
    /// Named in 06-TEST-PLAN, relied on by a subtraction two modules away, and
    /// until now asserted nowhere — the review that found it was looking at
    /// `open_epoch`'s snapshot as the input to every later `pps`, which is where
    /// the dependency actually lives.
    ///
    /// What rests on it: `void` finalizes with `assets_after = locked_at_open`
    /// and `pps = last_pps`, so `locked_assets = locked_at_open − burned × pps`.
    /// That subtraction is checked, so if I9 were ever false the round would not
    /// corrupt — it would become **unfinalizable**, taking I8's unpausable exit
    /// and I10's always-reachable terminal outcome with it. A liveness cliff is
    /// the one failure a solvency assertion cannot see, which is why I1 running
    /// green next to it proved nothing about this.
    ///
    /// Idle-only by construction: mid-round `locked_assets` is frozen at
    /// `locked_at_open` while `last_pps` still describes the previous round, so
    /// the comparison is not meaningful until the round closes.
    fn assert_i9(&mut self, after: &str) {
        let st = self.d.state();
        if st.phase != Phase::Idle {
            return;
        }
        if st.shares_outstanding > DEAD_SHARES {
            self.i9_backed_seen();
        }
        let backing = st
            .locked_assets
            .checked_mul(PRECISION)
            .expect("I9's left side overflowed i128, which §8's bounds forbid");
        let owed = st
            .shares_outstanding
            .checked_mul(st.last_pps)
            .expect("I9's right side overflowed i128, which §8's bounds forbid");
        assert!(
            backing >= owed,
            "I9 violated after {after}: locked {} × PRECISION = {backing} does not cover              {} shares at last_pps {} = {owed}. Every instant withdrawal in this state is              now underfunded, and `void` can no longer finalize.",
            st.locked_assets,
            st.shares_outstanding,
            st.last_pps,
        );
    }

    fn i9_backed_seen(&mut self) {
        self.observed.i9_backed += 1;
    }

    /// **I5**: `Σ balance(user) == shares_outstanding`, over the closed set of
    /// holders — the four actors plus the vault itself, which holds `DEAD_SHARES`
    /// and is the holder a naive sum forgets.
    /// **I2**: `notional_sold <= notional_offered <= locked_at_open`, at every point in every call
    /// ordering (§9).
    ///
    /// Two inequalities and they fail differently, so they are asserted separately. The left one is
    /// `bid`'s to preserve — it is the only code that raises `notional_sold`, and breaking it means
    /// the vault sold more calls than it has collateral behind. The right one is `open_epoch`'s: it
    /// snapshots both from `locked_assets`, so they are equal at open and the inequality only
    /// becomes interesting if anything ever moves one without the other.
    ///
    /// Checked in **every** phase rather than only while a round is live. In `Idle` the three fields
    /// still hold the last round's values, and a finalization that corrupted one of them would show
    /// here and nowhere else.
    fn assert_i2(&mut self, after: &str) {
        let st = self.d.state();
        if st.notional_sold > 0 {
            self.observed.i2_sold += 1;
        }
        assert!(
            st.notional_sold >= 0 && st.notional_offered >= 0 && st.locked_at_open >= 0,
            "I2 violated after {after}: a negative quantity — sold {}, offered {}, locked_at_open {}",
            st.notional_sold,
            st.notional_offered,
            st.locked_at_open,
        );
        assert!(
            st.notional_sold <= st.notional_offered,
            "I2 violated after {after}: sold {} exceeds offered {} — the vault has written more \
             calls than it has collateral behind",
            st.notional_sold,
            st.notional_offered,
        );
        assert!(
            st.notional_offered <= st.locked_at_open,
            "I2 violated after {after}: offered {} exceeds locked_at_open {} — the offer is larger \
             than the collateral snapshotted to back it",
            st.notional_offered,
            st.locked_at_open,
        );
    }

    fn assert_i5(&self, after: &str) {
        let st = self.d.state();
        let mut sum = self.shares(&self.d.vault);
        for a in &self.actors {
            sum += self.shares(a);
        }
        assert_eq!(
            sum, st.shares_outstanding,
            "I5 violated after {after}: balances sum to {sum} and supply says {}",
            st.shares_outstanding
        );
    }

    fn apply(&mut self, op: &Op) {
        let c = self.d.client();
        let a = |i: usize| self.actors[i].clone();

        // Every call goes through `try_`: a rejection is an ordinary outcome here,
        // and it is the outcome most likely to leave state half-written, so the
        // invariants are checked after it just as after a success.
        match *op {
            Op::Deposit { who, amount } => {
                let _ = c.try_deposit(&a(who), &amount);
            }
            Op::Cancel { who } => {
                let _ = c.try_cancel_pending_deposit(&a(who));
            }
            Op::Redeem { who } => {
                let _ = c.try_redeem_shares(&a(who));
            }
            Op::RequestWithdraw {
                who,
                part,
                require_idle,
            } => {
                let n = self.part_of(&a(who), part);
                let _ = c.try_request_withdraw(&a(who), &n, &require_idle);
            }
            Op::ClaimWithdraw { who } => {
                let _ = c.try_claim_withdraw(&a(who));
            }
            Op::Transfer { from, to, part } => {
                let n = self.part_of(&a(from), part);
                let _ = c.try_transfer(&a(from), a(to), &n);
            }
            Op::TransferFrom {
                spender,
                from,
                to,
                part,
            } => {
                let n = self.part_of(&a(from), part);
                let _ = c.try_transfer_from(&a(spender), &a(from), &a(to), &n);
            }
            Op::Burn { who, part } => {
                let n = self.part_of(&a(who), part);
                let _ = c.try_burn(&a(who), &n);
            }
            Op::BurnFrom {
                spender,
                from,
                part,
            } => {
                let n = self.part_of(&a(from), part);
                let _ = c.try_burn_from(&a(spender), &a(from), &n);
            }
            Op::Approve {
                from,
                spender,
                amount,
            } => {
                let until = self.d.env.ledger().sequence() + 1_000;
                let _ = c.try_approve(&a(from), &a(spender), &amount, &until);
            }
            Op::Restore { who } => {
                let _ = c.try_restore_position(&a(who));
            }
            Op::Pause(on) => {
                let _ = c.try_set_paused(&on);
            }
            Op::SetFee(bps) => {
                let _ = c.try_set_fee_bps(&bps);
            }
            Op::OpenEpoch => {
                let _ = c.try_open_epoch();
            }
            Op::CloseRound { bounty_to } => {
                let _ = c.try_close_round(&a(bounty_to));
            }
            Op::Bid { who, part, max_bps } => {
                // Sized as a fraction of the live offer rather than an absolute, so a generated
                // sequence lands inside the range where fills actually happen instead of being
                // rejected as dust or clamped to the remainder every time. `part` is also allowed
                // to exceed the offer, which is what exercises the clamp and the final sliver.
                let st = self.d.state();
                let offer = st.notional_offered.max(1);
                let n = offer
                    .saturating_mul(i128::from(part.min(400)))
                    .saturating_div(100);
                let _ = c.try_bid(&a(who), &n, &max_bps);
            }
            Op::Jump(secs) => {
                let t = self.d.env.ledger().timestamp();
                self.d.env.ledger().set_timestamp(t + secs);
                self.prime_feed();
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, max_shrink_iters: 2_000, ..ProptestConfig::default() })]

    /// The walk. Every operation, then both invariants, then the next operation —
    /// with time jumps interleaved so auctions expire, idle gaps elapse and lazy
    /// finalization fires inside the sequence rather than at its edges.
    #[test]
    fn i1_and_i5_hold_after_every_call(ops in prop::collection::vec(op(), 1..40)) {
        let mut w = World::new();
        w.assert_i1("genesis");
        w.assert_i5("genesis");
        w.assert_i2("genesis");
        w.assert_i9("genesis");

        for (i, op) in ops.iter().enumerate() {
            w.apply(op);
            let label = format!("op {i}: {op:?}");
            w.assert_i1(&label);
            w.assert_i5(&label);
            w.assert_i2(&label);
            w.assert_i9(&label);
        }

        // The three terms this phase can move must actually have moved, or the
        // five-term assertion above proved less than it claims. The other two are
        // named in the module header and become live with DEV3's `bid`.
        prop_assert!(
            w.observed.bidder_claimable == 0 && w.observed.fee_claimable == 0,
            "a term this phase cannot reach moved: {:?} — if `bid` has landed, \
             delete this assertion and the header table with it",
            w.observed
        );
    }

    /// The same walk, but **inside a live round**, and the difference is coverage
    /// rather than taste.
    ///
    /// A freely generated sequence may never open one: `open_epoch` needs a
    /// deposit, an elapsed idle gap and a healthy feed all at once, so a case that
    /// happens not to line them up leaves every round-dependent path — pending
    /// deposits, queued withdrawals, the lapse, `close_round` — untouched while
    /// still passing. Forcing the prefix makes those paths reachable in *every*
    /// case rather than in the lucky ones, and the assertion below is what turns
    /// "reachable" into "reached".
    #[test]
    fn i1_and_i5_hold_through_a_live_round(ops in prop::collection::vec(op(), 1..30)) {
        let mut w = World::new();
        w.apply(&Op::Deposit { who: 0, amount: 800 * XLM });
        w.apply(&Op::Jump(60));
        w.apply(&Op::OpenEpoch);
        prop_assert_eq!(w.d.state().phase, Phase::Auction, "the forced prefix must open a round");
        w.assert_i1("forced open");
        w.assert_i5("forced open");
        w.assert_i2("forced open");
        w.assert_i9("forced open");

        for (i, op) in ops.iter().enumerate() {
            w.apply(op);
            let label = format!("live-round op {i}: {op:?}");
            w.assert_i1(&label);
            w.assert_i5(&label);
            w.assert_i2(&label);
            w.assert_i9(&label);
        }

        prop_assert!(w.observed.round > 0, "no round was ever live");
        // I2's coverage is **not** asserted per case, and the reason is worth recording because
        // the first version did assert it here and was wrong.
        //
        // `i9_backed` above can be a per-case assertion because its guard opens in most sequences.
        // A *fill* does not: it needs a live auction, a bid inside the window, above `min_fill`,
        // under the bidder's own limit and below the strike — so plenty of legitimate sequences
        // never fill one. Demanding it of every case makes proptest treat "no fill" as a failure
        // and **shrink toward the emptiest such sequence**, which is both a false red and the
        // least informative counterexample available.
        //
        // The vacuity worry is real all the same, so it is answered where it can be answered
        // honestly: `i2_is_checked_with_something_actually_sold` below drives a fill
        // deterministically and asserts the counter moved. The property suite checks I2 everywhere;
        // that test proves the check can fire.
    }

    /// Deposits alone, in bulk, so the run that most exercises `locked_assets`
    /// and the mint path is not diluted by the rest of the alphabet.
    #[test]
    fn deposits_and_exits_alone_preserve_both(
        amounts in prop::collection::vec(11 * XLM..2_000 * XLM, 1..12),
        parts in prop::collection::vec(0u32..=100, 1..12),
    ) {
        let mut w = World::new();
        for (i, amt) in amounts.iter().enumerate() {
            w.apply(&Op::Deposit { who: i % ACTORS, amount: *amt });
            w.assert_i1("deposit");
            w.assert_i5("deposit");
            w.assert_i2("deposit");
            w.assert_i9("deposit");
        }
        for (i, part) in parts.iter().enumerate() {
            w.apply(&Op::RequestWithdraw { who: i % ACTORS, part: *part, require_idle: false });
            w.assert_i1("withdraw");
            w.assert_i5("withdraw");
            w.assert_i2("withdraw");
            w.assert_i9("withdraw");
        }
        prop_assert!(w.observed.locked > 0, "no deposit ever landed");
        // This walk never opens a round, so every state above is Idle and the
        // deposit above put real shares behind it — which makes zero here a
        // broken harness, not a quiet case.
        prop_assert!(
            w.observed.i9_backed > 0,
            "I9 was never checked with a shareholder present — the assertion ran vacuously"
        );
    }
}

/// Not a property — a fixed sequence that reaches the state the generator is
/// unlikely to hit and that D-32 was about: shares burned into a round that then
/// lapses, with the claim taken afterwards.
#[test]
fn the_lapse_path_holds_both_invariants_through_a_full_cycle() {
    let mut w = World::new();
    w.apply(&Op::Deposit {
        who: 0,
        amount: 500 * XLM,
    });
    // `open_epoch` is gated on `last_finalize_time + min_idle_gap`, and the test
    // ledger starts at zero — so without this the open refuses on the gap and the
    // rest of the sequence quietly tests nothing.
    w.apply(&Op::Jump(60));
    w.apply(&Op::OpenEpoch);
    assert_eq!(
        w.d.state().phase,
        Phase::Auction,
        "the round has to actually open"
    );
    w.assert_i1("open");
    w.assert_i5("open");

    w.apply(&Op::RequestWithdraw {
        who: 0,
        part: 40,
        require_idle: false,
    });
    w.assert_i1("queued withdraw");
    w.assert_i5("queued withdraw");

    w.apply(&Op::Jump(4_000)); // past auction_end
    w.apply(&Op::Restore { who: 0 }); // any touch absorbs the lapse
    w.assert_i1("lapse");
    w.assert_i5("lapse");

    w.apply(&Op::ClaimWithdraw { who: 0 });
    w.assert_i1("claim");
    w.assert_i5("claim");

    assert!(
        w.observed.withdraw_claimable > 0,
        "the claim queue never carried anything, so this proved nothing about D-32"
    );
}

/// **I2's assertion is reachable, driven deterministically.**
///
/// `assert_i2` runs after every op in the property suite, but `notional_sold` is 0 until a bid
/// fills — and `0 <= notional_offered` holds in every state no bidder ever reached. So the
/// assertion could pass forever on a suite that never sells anything, which is the shape this
/// project has now recorded five times in other guises.
///
/// This is the answer to that, and it is deliberately not a `prop_assert!` inside the generated
/// sequences: a fill needs a live auction, a bid inside the window, above `min_fill`, under the
/// bidder's own limit and below the strike, so legitimate sequences often contain none. Demanding
/// one of every case turns a normal sequence into a red and makes proptest shrink toward the
/// emptiest one.
#[test]
fn i2_is_checked_with_something_actually_sold() {
    let mut w = World::new();
    // A depositor, a round, and a bid that clears `min_fill` inside the window.
    w.apply(&Op::Deposit {
        who: 0,
        amount: 500 * XLM,
    });
    // The gap and the feed, both for the reason DEV1 records on the lapse test below: the ledger
    // starts at zero, so without a jump the open refuses on `min_idle_gap` and the rest of the
    // sequence quietly tests nothing.
    w.apply(&Op::Jump(60));
    w.apply(&Op::OpenEpoch);
    assert_eq!(
        w.d.state().phase,
        Phase::Auction,
        "the round must be live to bid into"
    );

    w.apply(&Op::Bid {
        who: 1,
        part: 50,
        max_bps: 10_000,
    });

    let st = w.d.state();
    assert!(
        st.notional_sold > 0,
        "the fill did not land, so this test proves nothing — offered {}, sold {}",
        st.notional_offered,
        st.notional_sold
    );
    w.assert_i2("a real fill");
    assert!(
        w.observed.i2_sold > 0,
        "assert_i2 ran but never saw a non-zero notional_sold"
    );

    // And the invariant still holds once the offer is fully taken, which is the boundary the left
    // inequality is about: sold == offered is legal, sold > offered is not.
    w.apply(&Op::Bid {
        who: 2,
        part: 400,
        max_bps: 10_000,
    });
    let st = w.d.state();
    assert_eq!(
        st.notional_sold, st.notional_offered,
        "the offer should be fully taken"
    );
    w.assert_i2("a fully subscribed offer");
}
