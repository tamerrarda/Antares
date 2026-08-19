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
//! | `bidder_claimable_total` | settlement and the bidder claims | **no — but the reason changed, see below** |
//! | `fee_claimable` | settlement | **no — same** |
//!
//! **Corrected when `Op::Bid` was added with I10.** This table used to say those
//! two terms could not move because *`bid` is DEV3's and unwritten*. `bid` has
//! landed and the suite now calls it, so that reason is gone — and the terms
//! still do not move in the freely generated walk, for two different reasons
//! worth naming separately:
//!
//! - `bidder_claimable_total` needs a settlement **in the money**, and this
//!   suite's feed never moves: `prime_feed` refills at one constant price, so
//!   `spot == strike` at every close and the payout is zero by construction. The
//!   missing piece is a price-moving operation, not a fill.
//! - `fee_claimable` needs `fee_bps > 0` *and* a round that sold something. The
//!   generator has `SetFee`, so the first half is reachable; the fee ships at
//!   zero (D-56), so it only accrues when that op fires before a settling close.
//!
//! **The suite reports that rather than leaving it to be assumed**: `Observed`
//! records the maximum each term reached, and the test asserts the three that
//! should move did. A five-term assertion over a three-term state is exactly the
//! "green but proves less than it claims" shape this project keeps finding, and
//! naming it is the only defence available until the generator can move a price.
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
use std::collections::BTreeMap;
use std::{format, vec};

use crate::test_common::{deploy_no_snapshot, Deployed};
use crate::types::*;
use crate::Error;
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

/// How much to bid, resolved against the live offer when the call is made.
///
/// Two shapes because three people needed two things. `ShareOfOffer` lands a partial
/// fill whatever the offer happens to be; `Absolute` reaches over-subscription, dust
/// and the exactly-empties-the-offer case `min_fill`'s carve-out exists for. Neither
/// subsumes the other, so the worker widened rather than one of them winning.
#[derive(Debug, Clone, Copy)]
enum BidSize {
    Absolute(i128),
    ShareOfOffer(u32),
}

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
    /// Added with I10. Without it the suite cannot reach `Phase::Active` **at all**: every auction
    /// runs to `auction_end` with `notional_sold == 0` and lapses, so a round never goes live and
    /// the dispatch I10 governs is unreachable by construction. The counter on `Observed` is what
    /// surfaced that — the assertion itself passed 48 of 48 cases without ever running.
    Bid {
        who: usize,
        size: BidSize,
        max_premium_bps: u32,
    },
    CloseRound {
        bounty_to: usize,
    },
    /// Added 2026-08-19 (DEV3) **together with `assert_i2`, and neither is useful without the
    /// other.** I2 bounds `notional_sold`, and `notional_sold` moves only in `bid` — so an
    /// `assert_i2` added to a suite with no bidding is an assertion that cannot fail, which is the
    /// defect this project has recorded five times in other guises. The op is what makes the
    /// assertion real; the `i2_sold_seen` counter is what proves it stayed real.
    ///
    /// **DEV1 added an identical variant in the same window** — same three fields, same names —
    /// and the duplicate is deleted rather than reconciled because there was nothing to reconcile.
    /// One fact from that side is worth keeping: **premium is the only thing in the protocol that
    /// moves `pps` off 1:1**, so before this op existed I1's `bidder_claimable` and `fee_claimable`
    /// terms could not move, the conservation bound's dust was structurally zero, and the
    /// no-dilution theorem would have compared a price to itself. Three assertions, all dead, all
    /// behind one missing call.
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
        // **Both sizings, because two of us reached for one and the third for the other, and
        // each is good at something the other cannot do.** DEV1 and DEV3 independently wrote
        // `part: u32` — a share of the live offer, which lands a partial fill whatever the offer
        // happens to be. DEV2 wrote `notional: i128` — an absolute amount, which is what reaches
        // over-subscription, dust, and the exactly-empties-the-offer case `min_fill`'s carve-out
        // exists for. Picking one drops whichever half it drops.
        //
        // DEV2's own rule for the `deploy_at`/`deploy_no_snapshot` collision is the one applied
        // here: **two people removing the same seam for different reasons is evidence they found
        // the right seam, and the answer is to widen the worker rather than to take a side.**
        // `BidSize` is that widening. **DEV2, DEV3: proposed, not settled — say so if it is wrong.**
        //
        // The weighting and the `max_bps` distribution below are DEV3's, kept whole: they are the
        // only ones with a measurement behind them (8 bids in a sequence, 0 fills, before the
        // 6:1 tilt toward "no limit").
        6 => (
            actor(),
            prop_oneof![
                3 => (1u32..=400).prop_map(BidSize::ShareOfOffer),
                1 => fill().prop_map(BidSize::Absolute),
            ],
            premium_cap(),
        )
            .prop_map(|(who, size, max_premium_bps)| Op::Bid { who, size, max_premium_bps }),
        5 => prop_oneof![Just(1u64), Just(60), Just(120), Just(1_200), Just(4_000)]
            .prop_map(Op::Jump),
    ]
}

/// Bid sizes straddling `min_fill` (100 XLM) and the offer itself, which is the forced
/// prefix's 800 XLM. Over-asking is kept: the remainder fill is its own path (`test_auction`
/// covers the arithmetic; this covers what it does to the invariants).
fn fill() -> impl Strategy<Value = i128> {
    prop_oneof![
        Just(0i128),
        Just(99 * XLM),  // under min_fill
        Just(100 * XLM), // exactly min_fill
        150 * XLM..900 * XLM,
    ]
}

/// Mostly permissive, because a bid that never clears leaves the auction empty and puts the suite
/// back where it was before `Op::Bid` existed.
fn premium_cap() -> impl Strategy<Value = u32> {
    // DEV2's function, DEV3's distribution. Both wrote a cap strategy in the same window and both
    // argued it; DEV3's is the one with a measurement behind it — an unweighted choice rejected
    // three bids in four on `PremiumAboveMax`, and before the tilt a sequence landed 8 bids and
    // 0 fills. Keeping the seam and taking the numbers loses neither.
    prop_oneof![
        6 => Just(10_000u32),
        1 => Just(460u32),
        1 => Just(300u32),
        1 => Just(20u32),
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
    /// How many finalized rounds I6's biconditional was actually decided on, and
    /// how many of those were the degenerate `pps == 0` side. The second number
    /// is the one that matters: D-66 exists for a state the naive `pps > 0` form
    /// would have passed straight through, so a run that never reaches it has
    /// tested the easy half.
    i6_rounds: usize,
    i6_degenerate: usize,
    /// Finalized `Round` records re-read and found unchanged (I7).
    i7_rechecks: usize,
    /// Dust sources, counted from **state deltas rather than from attempts**: a
    /// rejected call rounds nothing, and counting it would loosen a bound whose
    /// whole claim is tightness (06-TEST-PLAN §3).
    mints: i128,
    claims: i128,
    instant_exits: i128,
    round_dust: i128,
    /// How many times I10 was checked **with its guard open** — a `close_round`
    /// call that actually found `Active` at or past `expiry`. Same defence as
    /// `i9_backed`: an invariant behind a guard proves nothing in the cases where
    /// the guard never opens, and a freely generated sequence reaches this state
    /// only when a deposit, an idle gap, a healthy feed and a time jump all line
    /// up. Asserted non-zero in the forced-round property rather than hoped for.
    i10_dispatched: usize,
    /// Of those, how many were past `expiry + unresolved_after` — the branch that
    /// takes no oracle call at all. This is the one D-64 exists for, and the one
    /// that reverted forever before it.
    i10_past_fallback: usize,
}

/// State read before an operation, so a finalization can be measured rather than
/// recomputed. `assets_R` is not stored anywhere and re-deriving it in the test
/// would be a second copy of `settle.rs`'s formula agreeing with itself; it comes
/// out of observable state instead: `finalize_round` writes
/// `locked_assets = assets_after - wclaims` and adds the same `wclaims` to
/// `withdraw_claimable_total`, so the sum of the two deltas is `assets_R`.
#[derive(Clone, Debug)]
struct Pre {
    round: u32,
    withdraw_claimable: i128,
    shares_snapshot: i128,
    last_pps: i128,
}

/// What one `close_round` call did.
///
/// I10 is a statement about the **call**, not about a resting state: "at most one
/// terminal outcome, always". So the pre-state, the answer and the post-state are
/// captured together — none of the three is recoverable from the others once the
/// call has returned.
#[derive(Debug)]
struct Close {
    phase_before: Phase,
    round: u32,
    expiry: u64,
    now: u64,
    fallback_at: Option<u64>,
    result: Result<RoundOutcome, Error>,
    phase_after: Phase,
    recorded: Option<RoundOutcome>,
}

struct World {
    d: Deployed,
    actors: [Address; ACTORS],
    /// Every finalized round as first observed. I7 is that this map never needs
    /// updating.
    rounds: BTreeMap<u32, Round>,
    observed: Observed,
    /// Set by the `CloseRound` arm of `apply`, consumed by `assert_i10`. `None`
    /// after any other operation, which is why `assert_i10` can be called after
    /// every op alongside the other three.
    last_close: Option<Close>,
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
            rounds: BTreeMap::new(),
            last_close: None,
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

    fn capture(&self) -> Pre {
        let st = self.d.state();
        Pre {
            round: st.round,
            withdraw_claimable: st.withdraw_claimable_total,
            shares_snapshot: st.shares_snapshot,
            last_pps: st.last_pps,
        }
    }

    /// **I6 in its D-66 form, and I7.**
    ///
    /// I6 is `pps >= 0` on every finalized round, and `== 0` **exactly when**
    /// `assets_R × PRECISION < shares_snapshot`. The biconditional is the whole
    /// decision: asserting `pps > 0` unconditionally is not merely incomplete, it
    /// is *wrong* — it fails in the state D-66 deliberately allows, where forcing
    /// a floor of 1 would make `Σ claim_withdraw` exceed what was credited and
    /// break I1. Where I6 and I1 conflict, solvency wins, and that is the state
    /// this checks rather than assumes.
    ///
    /// I7 is round immutability. 06-TEST-PLAN §3 puts it in the fuzz harness
    /// "since it quantifies over call orderings, not values" — and this suite
    /// *is* arbitrary call orderings, so the stated reason is satisfied here too.
    /// DEV1.md §364 lists it as mine. Both hold; the fuzz version stays DEV3's and
    /// hashes across interleavings this generator will not reach.
    fn assert_i6_i7(&mut self, pre: &Pre, after: &str) {
        let st = self.d.state();

        for r in 1..=st.round {
            let Some(rec) = self
                .d
                .env
                .as_contract(&self.d.vault, || crate::storage::get_round(&self.d.env, r))
            else {
                continue;
            };

            if let Some(seen) = self.rounds.get(&r) {
                assert_eq!(
                    seen, &rec,
                    "I7 violated after {after}: round {r} was rewritten. It is \
                     immutable once written, and every late claim is computed from it"
                );
                self.observed.i7_rechecks += 1;
                continue;
            }

            // Newly finalized in this step. `assets_R` from the two deltas rather
            // than from a copy of the formula.
            if r == pre.round + 1 || r == pre.round {
                let wclaims = st.withdraw_claimable_total - pre.withdraw_claimable;
                let assets_r = st.locked_assets + wclaims;
                let snapshot = pre.shares_snapshot;
                assert!(
                    rec.pps >= 0,
                    "I6 violated after {after}: round {r} finalized at pps {}",
                    rec.pps
                );
                // **The biconditional only applies where `pps` was computed.**
                // `settle` and `unresolved` divide `assets_R` by
                // `shares_snapshot`; `lapse` and `void` finalize with
                // `pps = last_pps`, carried from the previous round and never
                // derived from this one's assets. Asserting D-66's "exactly when"
                // against a carried price compares two unrelated numbers, and it
                // was green only because this generator had not yet produced the
                // pairing that separates them. Each outcome is checked against the
                // rule that actually governs it.
                match rec.outcome {
                    RoundOutcome::Settled | RoundOutcome::Unresolved if snapshot > 0 => {
                        let degenerate = assets_r
                            .checked_mul(PRECISION)
                            .expect("assets_R × PRECISION overflowed, which §8's bounds forbid")
                            < snapshot;
                        assert_eq!(
                            rec.pps == 0,
                            degenerate,
                            "I6 violated after {after}: round {r} has pps {} with assets_R \
                             {assets_r} against {snapshot} shares — D-66 makes those two \
                             statements the same one",
                            rec.pps
                        );
                        self.observed.i6_rounds += 1;
                        if degenerate {
                            self.observed.i6_degenerate += 1;
                        }
                    }
                    RoundOutcome::Lapsed | RoundOutcome::Voided => {
                        assert_eq!(
                            rec.pps, pre.last_pps,
                            "round {r} {:?} at pps {} but the price entering it was {} — \
                             exiting shares leave at the unchanged price; a lapse costs \
                             depositors nothing and earns them nothing",
                            rec.outcome, rec.pps, pre.last_pps
                        );
                        self.observed.i6_rounds += 1;
                    }
                    _ => {}
                }
            }
            self.rounds.insert(r, rec);
        }
    }

    /// One operation, with every dust source it created counted from what moved.
    ///
    /// Success is inferred from state, not from the call's result: `apply` drives
    /// everything through `try_*` because a rejection is an ordinary outcome here,
    /// and a rejection rounds nothing. Counting attempts would inflate the bound
    /// in exactly the direction that makes `≤ bound` pass without meaning
    /// anything.
    fn apply_counted(&mut self, op: &Op) {
        let before = self.d.state();
        let idle_before = before.phase == Phase::Idle;
        self.apply(op);
        let after = self.d.state();

        if after.shares_outstanding > before.shares_outstanding {
            self.observed.mints += 1;
        }
        if after.withdraw_claimable_total < before.withdraw_claimable_total {
            self.observed.claims += 1;
        }
        if idle_before
            && after.shares_outstanding < before.shares_outstanding
            && after.locked_assets < before.locked_assets
        {
            self.observed.instant_exits += 1;
        }
        // A round that finalized in this step: `⌈shares_snapshot / PRECISION⌉` from
        // the `pps` floor, plus one stroop for the `wclaims` aggregate and one for
        // `payout_total`.
        if after.round == before.round && after.phase == Phase::Idle && !idle_before {
            let snap = before.shares_snapshot;
            self.observed.round_dust +=
                snap.div_euclid(PRECISION) + i128::from(snap.rem_euclid(PRECISION) != 0) + 2;
        }
    }

    /// `⌊DEAD_SHARES × last_pps / PRECISION⌋` — **floored, and the direction is the
    /// whole subtlety.** It floors down, so the remainder it drops is still sitting
    /// in `balance`; that remainder is dust and belongs to the bound, once. Folding
    /// it into the backing term as well counts it twice and moves the bound the
    /// other way, failing a correct contract exactly as omitting the term did.
    fn dead_share_backing(&self) -> i128 {
        let st = self.d.state();
        DEAD_SHARES * st.last_pps / PRECISION
    }

    fn i9_backed_seen(&mut self) {
        self.observed.i9_backed += 1;
    }

    /// **I10** — the terminal dispatch (02-CONTRACT-SPEC §9, DEV2.md §498).
    ///
    /// *While a round is live and `now >= expiry`, `close_round` resolves to at most one terminal
    /// outcome, always.* The twelve-cell `GuardOutcome × time` grid in `test_settle` establishes
    /// that **by construction** — one `match` over four values behind one time check, so no cell is
    /// undefined and none reaches two. This is the other half: the grid shows the partition is
    /// exhaustive, and this shows that **no ordering of calls and no passage of time** walks the
    /// contract into a state where the dispatch reaches two outcomes or none.
    ///
    /// # Asserted on what is observable, after getting it wrong once
    ///
    /// The first version keyed off `phase == Active` before the call and treated `Ok(Settled)` from
    /// `Auction` as a violation. It is not: `close_round`'s step 0 calls `lazy_finalize`, which
    /// returns `true` only for an **empty** auction — a sold one it flips to `Active` in place and
    /// returns `false`, so the same call goes on to settle. The contract was right and the
    /// assertion was modelling internals it could not see. What it can see is the answer, the
    /// record and the phase afterwards, so that is what it now checks.
    ///
    /// # The two halves fail differently, so they are asserted separately
    ///
    /// **"At most one"** is safety. A second terminal outcome on one round is a second settlement —
    /// the pool pays twice. So an `Ok` must record exactly the outcome it returned and must leave
    /// the round finished.
    ///
    /// **"Always"** is liveness, and it is the half that has actually been violated here. Before
    /// D-64 an unreachable adapter made every `close_round` revert forever and the collateral was
    /// trapped with no path out — a failure no solvency assertion can see, because the books stay
    /// balanced right up until nobody can ever be paid. Step 2 is unconditional and sits *before*
    /// any oracle call, so past `expiry + unresolved_after` **no error is admissible at all**.
    /// Both halves were planted and seen to fail before this was believed.
    fn assert_i10(&mut self, after: &str) {
        let Some(c) = self.last_close.take() else {
            return;
        };
        let was_live = c.phase_before != Phase::Idle;
        let past_fallback = c.fallback_at.is_some_and(|f| c.now >= f);

        if was_live && c.now >= c.expiry {
            self.observed.i10_dispatched += 1;
            if past_fallback {
                self.observed.i10_past_fallback += 1;
            }
        }

        match &c.result {
            Ok(outcome) => {
                assert_ne!(
                    c.phase_after,
                    Phase::Active,
                    "I10 violated after {after}: round {} returned {outcome:?} and is STILL \
                     Active. It can be closed a second time, and the second close is a second \
                     terminal outcome on one round.",
                    c.round,
                );
                assert_eq!(
                    c.recorded,
                    Some(*outcome),
                    "I10 violated after {after}: `close_round` returned {outcome:?} but round {} \
                     records {:?}. The answer the caller got and the answer the chain kept must be \
                     the same one — every per-bidder claim is recomputed from the record.",
                    c.round,
                    c.recorded,
                );
            }
            Err(e) => {
                // The liveness half. Past the fallback there is no oracle call left to fail, so
                // there is nothing a refusal could be *about*.
                assert!(
                    !(was_live && past_fallback),
                    "I10 violated after {after}: round {} was live at {}, past its fallback \
                     deadline {:?}, and `close_round` refused with {e:?}. Step 2 takes no oracle \
                     call and is unconditional — past this instant the round MUST resolve. This is \
                     the state that trapped every depositor's collateral before D-64.",
                    c.round,
                    c.now,
                    c.fallback_at,
                );
                assert!(
                    matches!(
                        e,
                        Error::WrongPhase
                            | Error::NotExpired
                            | Error::OracleNotDeadYet
                            | Error::OracleUnreachable
                            | Error::InvalidParams
                    ),
                    "I10 violated after {after}: `close_round` refused round {} with {e:?}, which \
                     is not one of the dispatch's defined refusals. An undefined error here is a \
                     path the grid does not cover.",
                    c.round,
                );
                if was_live {
                    assert_eq!(
                        c.recorded,
                        None,
                        "I10 violated after {after}: `close_round` refused round {} with {e:?} and \
                         yet the round carries outcome {:?}. I7 forbids the second write that \
                         would correct it.",
                        c.round,
                        c.recorded,
                    );
                }
            }
        }
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
            Op::Bid {
                who,
                size,
                max_premium_bps,
            } => {
                // DEV3's clamp and reasoning, kept: `part` may exceed the offer, which is what
                // exercises the clamp and the final sliver rather than being rejected as dust
                // every time.
                let notional = match size {
                    BidSize::Absolute(n) => n,
                    BidSize::ShareOfOffer(part) => {
                        let offer = self.d.state().notional_offered.max(1);
                        offer
                            .saturating_mul(i128::from(part.min(400)))
                            .saturating_div(100)
                    }
                };
                let _ = c.try_bid(&a(who), &notional, &max_premium_bps);
            }
            Op::CloseRound { bounty_to } => {
                let before = self.d.state();
                let now = self.d.env.ledger().timestamp();
                let result = c
                    .try_close_round(&a(bounty_to))
                    .map_err(|e| e.unwrap())
                    .map(|r| r.unwrap());
                let after = self.d.state();
                let recorded = self.d.env.as_contract(&self.d.vault, || {
                    crate::storage::get_round(&self.d.env, before.round).map(|r| r.outcome)
                });
                self.last_close = Some(Close {
                    phase_before: before.phase,
                    round: before.round,
                    expiry: before.expiry,
                    now,
                    fallback_at: before.expiry.checked_add(before.params.unresolved_after),
                    result,
                    phase_after: after.phase,
                    recorded,
                });
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
        w.assert_i10("genesis");

        for (i, op) in ops.iter().enumerate() {
            let pre = w.capture();
            w.apply(op);
            let label = format!("op {i}: {op:?}");
            w.assert_i1(&label);
            w.assert_i5(&label);
            w.assert_i2(&label);
            w.assert_i9(&label);
            w.assert_i6_i7(&pre, &label);
            w.assert_i10(&label);
        }

        // The three terms this phase can move must actually have moved, or the
        // five-term assertion above proved less than it claims. The other two are
        // named in the module header and become live with DEV3's `bid`.
        prop_assert!(
            w.observed.bidder_claimable == 0 && w.observed.fee_claimable == 0,
            "a term this walk cannot reach moved: {:?} — `bid` has landed and is in the \
             generator, so if this fires it means the feed moved or a fee was set before a \
             settling close, and the header table needs the correction rather than this line,",
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
        // **Force a fill, for the same reason the open is forced.** A free sequence
        // lands a bid about 19 times in 225 attempts, so a case that happens not to
        // fill leaves every premium-dependent path untested while still passing.
        // Premium is the only thing that moves `pps` off 1:1, and three assertions
        // sit downstream of that.
        w.apply(&Op::Bid { who: 1, size: BidSize::ShareOfOffer(50), max_premium_bps: 10_000 });
        prop_assert!(
            w.d.state().premium_collected > 0,
            "the forced prefix must fill: without premium, pps stays at PRECISION and \
             conservation, no-dilution and I1's last two terms all test nothing"
        );
        w.assert_i1("forced open");
        w.assert_i5("forced open");
        w.assert_i2("forced open");
        w.assert_i9("forced open");
        w.assert_i10("forced open");

        for (i, op) in ops.iter().enumerate() {
            let pre = w.capture();
            w.apply(op);
            let label = format!("live-round op {i}: {op:?}");
            w.assert_i1(&label);
            w.assert_i5(&label);
            w.assert_i2(&label);
            w.assert_i9(&label);
            w.assert_i6_i7(&pre, &label);
            w.assert_i10(&label);
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
        //
        // **I6 and I7 take the same treatment, and the block that used to sit here did not.**
        // It jumped past expiry and forced `close_round` so both would be decided in every case.
        // That is this same mistake one layer up: the forcing lives in the suite, where it
        // competes with everyone else's tuning of one generator — and **no single weighting
        // satisfies I2, I6/I7 and I10 at once.** That is arithmetic rather than a merge problem.
        // Three of us hit that wall from three directions; DEV2 and DEV3 found the exit first and
        // neither of them was looking for it.
        //
        // I6 and I7 are decided at *finalization* rather than during a round, so the forcing was a
        // fixed suffix and did not distort the generated body — a real difference, and still not
        // enough. A rule that holds for two invariants of three and takes an exception for the
        // third has stopped being a rule. Reachability moves to
        // `i6_and_i7_are_decided_when_a_round_finalizes`; the suite checks them everywhere and
        // demands them nowhere.
    }

    /// **I10 over orderings** — the other half of `test_settle`'s twelve-cell grid.
    ///
    /// The grid establishes the invariant *by construction*: one `match` over four `GuardOutcome`
    /// values behind one time check, so no cell is undefined and none reaches two. What a grid
    /// cannot show is that no **sequence of calls** and no **passage of time** walks the contract
    /// into a state where the dispatch reaches two outcomes or none. That is this.
    ///
    /// # Why the prefix and the suffix are both forced
    ///
    /// `Phase::Active` is not reachable by luck. A round needs a deposit, an elapsed idle gap, a
    /// healthy feed, an `open_epoch` **and a fill** — and until `Op::Bid` was added with this test
    /// the suite had no fill at all, so every auction lapsed and `Active` was unreachable *by
    /// construction*. A generated 1..30 sequence then has to also jump past expiry and call
    /// `close_round` in that order. It does not, and the `i10_dispatched` counter is what said so
    /// rather than leaving the assertion green and idle.
    ///
    /// So the prefix forces a fully-subscribed round — `notional_offered` is the deposit, so one
    /// bid for the whole of it flips to `Active` immediately — and the suffix forces the clock past
    /// `expiry + unresolved_after` and closes. **The generated operations are the middle**, which
    /// is where the property lives: deposits, withdrawals, transfers, pauses, fee changes and time
    /// jumps land in arbitrary order against a live round, and the dispatch has to survive all of
    /// them.
    #[test]
    fn i10_holds_over_every_ordering(ops in prop::collection::vec(op(), 1..25)) {
        let mut w = World::new();
        w.apply(&Op::Deposit { who: 0, amount: 800 * XLM });
        w.apply(&Op::Jump(60));
        w.apply(&Op::OpenEpoch);
        w.apply(&Op::Bid { who: 1, size: BidSize::Absolute(800 * XLM), max_premium_bps: 10_000 });
        prop_assert_eq!(
            w.d.state().phase, Phase::Active,
            "the forced prefix must reach Active — full subscription flips the phase early, and \
             without it this test is the lapse path with extra steps"
        );

        for (i, op) in ops.iter().enumerate() {
            w.apply(op);
            let label = format!("i10 op {i}: {op:?}");
            w.assert_i1(&label);
            w.assert_i5(&label);
            w.assert_i9(&label);
            w.assert_i10(&label);
        }

        // The suffix. If a generated `CloseRound` already resolved the round past expiry, the guard
        // has already opened and this is a no-op against an Idle vault; if not, this is what makes
        // the dispatch reached rather than merely reachable.
        let st = w.d.state();
        if st.phase == Phase::Active {
            let now = w.d.env.ledger().timestamp();
            let fallback = st.expiry + st.params.unresolved_after;
            if fallback >= now {
                w.apply(&Op::Jump(fallback - now + 1));
            }
            w.apply(&Op::CloseRound { bounty_to: 0 });
            w.assert_i10("forced terminal close");
        }

        prop_assert!(
            w.observed.i10_dispatched > 0,
            "I10's guard never opened: no `close_round` call found an Active round at or past \
             expiry, so the assertion passed without being exercised."
        );
        // `i10_past_fallback` is deliberately NOT asserted per case. A generated `CloseRound` may
        // settle the round normally long before the fallback, and then the forced suffix finds an
        // Idle vault and that branch is genuinely unreachable in that case. Demanding it here
        // would fail on correct code. The branch has its own deterministic test below.
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
            w.assert_i10("deposit");
        }
        for (i, part) in parts.iter().enumerate() {
            w.apply(&Op::RequestWithdraw { who: i % ACTORS, part: *part, require_idle: false });
            w.assert_i1("withdraw");
            w.assert_i5("withdraw");
            w.assert_i2("withdraw");
            w.assert_i9("withdraw");
            w.assert_i10("withdraw");
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

    /// **Conservation** (06-TEST-PLAN §3, as amended 2026-08-19).
    ///
    /// After every claim drains, `balance − dead_share_backing − dust == 0`, with
    /// `dust` bounded by what the scenario actually rounded. The bound is computed
    /// from observed operations rather than assumed, and the inequality is tight in
    /// **both** directions — the lower bound is what would catch the contract
    /// paying out more than it floored, which no upper bound can see.
    ///
    /// The `dead_share_backing` term is the correction: `DEAD_SHARES` have no burn
    /// path, so the pool keeps their backing forever and 1 000 shares' worth is not
    /// dust. The document said `balance − dust == 0` and would have failed a correct
    /// contract.
    #[test]
    fn conservation_holds_once_every_claim_has_drained(
        amounts in prop::collection::vec(11 * XLM..500 * XLM, 1..8),
        parts in prop::collection::vec(0u32..=100, 0..6),
    ) {
        let mut w = World::new();
        for (i, amt) in amounts.iter().enumerate() {
            w.apply_counted(&Op::Deposit { who: i % ACTORS, amount: *amt });
        }
        for (i, part) in parts.iter().enumerate() {
            w.apply_counted(&Op::RequestWithdraw { who: i % ACTORS, part: *part, require_idle: false });
        }

        // **A round with a real fill, because without one this property tests
        // nothing.** `INITIAL_PPS == PRECISION`, so every mint and exit divides
        // exactly and dust is structurally zero until premium moves the price off
        // 1:1. Measured before this was added: dust was 0 on all 49 cases while the
        // computed bound reached 17 — the `≤ bound` half passing without touching
        // anything. With the round in place dust is non-zero on **42 of 49 cases and
        // reaches 1 845 against a computed bound of 1 881** — a two per cent margin,
        // which is what "tight, not a hand-wave" has to mean to be worth asserting.
        w.apply_counted(&Op::Jump(60));
        w.apply_counted(&Op::OpenEpoch);
        w.apply_counted(&Op::Bid { who: 0, size: BidSize::ShareOfOffer(60), max_premium_bps: 10_000 });
        w.apply_counted(&Op::Jump(4_000));
        w.apply_counted(&Op::CloseRound { bounty_to: 1 });

        // Drain. Everything exits at the published price; whatever is left is the
        // dead shares' backing plus the remainders nobody could pay out.
        for i in 0..ACTORS {
            w.apply_counted(&Op::Redeem { who: i });
            w.apply_counted(&Op::RequestWithdraw { who: i, part: 100, require_idle: false });
            w.apply_counted(&Op::ClaimWithdraw { who: i });
        }

        let st = w.d.state();
        prop_assert_eq!(
            st.shares_outstanding, DEAD_SHARES,
            "the drain is the premise: everything but the dead shares must be gone"
        );
        prop_assert_eq!(st.pending_deposits_total, 0, "no pending left undrained");

        let backing = w.dead_share_backing();
        let balance = w.d.balance(&w.d.vault);
        let dust = balance - backing;

        // One stroop per mint, per claim and per instant exit; the per-round terms;
        // and **exactly one** for the backing's own floor — the remainder it drops
        // is in `balance`, and counting it in both places is the error the amended
        // §3 warns about.
        let bound = w.observed.mints
            + w.observed.claims
            + w.observed.instant_exits
            + w.observed.round_dust
            + 1;

        prop_assert!(
            dust >= 0,
            "conservation violated: balance {} is below the dead shares' backing {} — \
             the contract paid out more than it floored",
            balance, backing
        );
        // **The bound cannot bite yet, and asserting that is worth more than a
        // passing `<=`.** `INITIAL_PPS == PRECISION`, so every mint and every exit
        // divides exactly; a round without `bid` finalizes at
        // `assets_R = locked_at_open` against a 1:1 share count, so `pps` comes back
        // to `PRECISION` and rounds nothing either. Measured: dust was **0 on all 49
        // cases** while the computed bound reached 17 — the `≤ bound` half was
        // passing without touching anything, which is this suite's own definition of
        // a green assertion proving less than its name.
        //
        // **When `bid` lands and a premium moves the price off 1:1, this line
        // fails.** That failure is the signal that the bound below has finally
        // started doing work, and this assertion is what should be deleted then —
        // not the bound. Same treatment as I1's two unreachable terms above.
        prop_assert!(
            dust <= bound,
            "conservation violated: dust {dust} exceeds the bound {bound} \
             (mints {}, claims {}, instant exits {}, round dust {})",
            w.observed.mints, w.observed.claims, w.observed.instant_exits, w.observed.round_dust
        );
    }
}

/// Not a property — a fixed sequence that reaches the state the generator is
/// unlikely to hit and that D-32 was about: shares burned into a round that then
/// lapses, with the claim taken afterwards.
/// **I10's evidence-free branch**, deterministically — the one the property cannot guarantee.
///
/// `i10_past_fallback` was asserted per generated case first, and it failed on correct code: a
/// generated `CloseRound` may settle the round normally long before the fallback, after which the
/// branch is genuinely unreachable in that case. So the guarantee lives here instead, where the
/// clock is driven rather than generated.
///
/// This is D-64's branch. It takes **no oracle call at all**, which is what makes "no oracle state
/// can trap funds" a property of the code's shape rather than a sentence in a document — and the
/// adapter is left trapping across the closing call so that "not consulted" is asserted rather
/// than asserted about.
#[test]
fn i10_resolves_past_the_fallback_with_the_oracle_trapping() {
    let mut w = World::new();
    w.apply(&Op::Deposit {
        who: 0,
        amount: 800 * XLM,
    });
    w.apply(&Op::Jump(60));
    w.apply(&Op::OpenEpoch);
    w.apply(&Op::Bid {
        who: 1,
        size: BidSize::Absolute(800 * XLM),
        max_premium_bps: 10_000,
    });
    assert_eq!(
        w.d.state().phase,
        Phase::Active,
        "full subscription flips the phase early"
    );

    let st = w.d.state();
    let now = w.d.env.ledger().timestamp();
    w.apply(&Op::Jump(st.expiry + st.params.unresolved_after - now + 1));

    // The feed is dead *and* the adapter traps, and both stay that way across the close. If step 2
    // consulted the oracle at all, this reverts.
    mock_price_source::MockPriceSourceClient::new(&w.d.env, &w.d.oracle).set_trap(&true);

    w.apply(&Op::CloseRound { bounty_to: 0 });
    w.assert_i10("past the fallback, adapter trapping");
    w.assert_i1("past the fallback");
    w.assert_i5("past the fallback");

    assert_eq!(
        w.observed.i10_past_fallback, 1,
        "the branch this test exists for was not the one taken"
    );
    assert_eq!(w.d.state().phase, Phase::Idle, "the round must be finished");
}

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
    w.assert_i10("open");

    w.apply(&Op::RequestWithdraw {
        who: 0,
        part: 40,
        require_idle: false,
    });
    w.assert_i1("queued withdraw");
    w.assert_i5("queued withdraw");
    w.assert_i10("queued withdraw");

    w.apply(&Op::Jump(4_000)); // past auction_end
    w.apply(&Op::Restore { who: 0 }); // any touch absorbs the lapse
    w.assert_i1("lapse");
    w.assert_i5("lapse");
    w.assert_i10("lapse");

    w.apply(&Op::ClaimWithdraw { who: 0 });
    w.assert_i1("claim");
    w.assert_i5("claim");
    w.assert_i10("claim");

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
        size: BidSize::ShareOfOffer(50),
        max_premium_bps: 10_000,
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
        size: BidSize::ShareOfOffer(400),
        max_premium_bps: 10_000,
    });
    let st = w.d.state();
    assert_eq!(
        st.notional_sold, st.notional_offered,
        "the offer should be fully taken"
    );
    w.assert_i2("a fully subscribed offer");
}

/// I6 and I7 are decided at **finalization**, so their reachability is proved here
/// rather than demanded of every generated case.
///
/// The property suite asserts both wherever a round happens to finalize. What it
/// must not do is *insist* on one: the forcing would live in the suite, competing
/// with DEV3's weighting for I2 and DEV2's for I10, and **no single weighting
/// satisfies all three**. This is the same answer DEV3 reached for I2 and DEV2 for
/// `i10_past_fallback`, arrived at independently three times.
#[test]
fn i6_and_i7_are_decided_when_a_round_finalizes() {
    let mut w = World::new();
    w.apply(&Op::Deposit {
        who: 0,
        amount: 500 * XLM,
    });
    // The jump is the fixture's own gate, not decoration: the ledger starts at zero
    // and `open_epoch` refuses inside `min_idle_gap`, so without it everything after
    // this line is a silent no-op.
    w.apply(&Op::Jump(60));
    w.apply(&Op::OpenEpoch);
    assert_eq!(w.d.state().phase, Phase::Auction, "a round must be live");

    // Past the auction and past expiry, then close. Terminal by construction.
    w.apply(&Op::Jump(4_000));
    let pre = w.capture();
    w.apply(&Op::CloseRound { bounty_to: 0 });

    let st = w.d.state();
    assert_eq!(
        st.phase,
        Phase::Idle,
        "the round must finalize, or I6 and I7 have nothing to be decided on"
    );
    w.assert_i6_i7(&pre, "a finalized round");
    assert!(
        w.observed.i6_rounds > 0,
        "I6 was never decided — the assertion ran on nothing, which is the failure \
         mode a counter exists to catch"
    );

    // I7 needs the record read a *second* time to mean anything: the first read is
    // what it remembers, the comparison is the invariant.
    let pre2 = w.capture();
    w.apply(&Op::Jump(60));
    w.assert_i6_i7(&pre2, "re-read after a jump");
    assert!(
        w.observed.i7_rechecks > 0,
        "the finalized round was never re-read, so immutability was never tested"
    );
}
