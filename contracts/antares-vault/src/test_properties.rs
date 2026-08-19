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
use std::collections::BTreeMap;
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
    /// A real fill, added 2026-08-19. Until this existed `bid` was unreachable
    /// from the suite, and with it three assertions were structurally dead:
    /// I1's `bidder_claimable`/`fee_claimable` terms could not move, the
    /// conservation bound's dust was always zero because `pps` never left
    /// `PRECISION`, and the no-dilution theorem compared a price to itself.
    /// **Premium is the only thing in the protocol that moves `pps` off 1:1**, so
    /// nothing downstream of it was being tested at all.
    Bid {
        who: usize,
        part: u32,
        max_bps: u32,
    },
    OpenEpoch,
    CloseRound {
        bounty_to: usize,
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
        6 => (actor(), 10u32..=100, prop_oneof![Just(10_000u32), Just(400), Just(120), Just(1)])
            .prop_map(|(who, part, max_bps)| Op::Bid { who, part, max_bps }),
        5 => prop_oneof![Just(1u64), Just(60), Just(120), Just(1_200), Just(4_000)]
            .prop_map(Op::Jump),
    ]
}

/// What each of I1's five terms reached across a run.
#[derive(Default, Debug)]
struct Observed {
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

struct World {
    d: Deployed,
    actors: [Address; ACTORS],
    /// Every finalized round as first observed. I7 is that this map never needs
    /// updating.
    rounds: BTreeMap<u32, Round>,
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
            rounds: BTreeMap::new(),
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

    /// **I5**: `Σ balance(user) == shares_outstanding`, over the closed set of
    /// holders — the four actors plus the vault itself, which holds `DEAD_SHARES`
    /// and is the holder a naive sum forgets.
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
            Op::Bid { who, part, max_bps } => {
                let offered = self.d.state().notional_offered;
                let notional = offered.saturating_mul(i128::from(part)) / 100;
                let _ = c.try_bid(&a(who), &notional, &max_bps);
            }
            Op::OpenEpoch => {
                let _ = c.try_open_epoch();
            }
            Op::CloseRound { bounty_to } => {
                let _ = c.try_close_round(&a(bounty_to));
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
        w.assert_i9("genesis");

        for (i, op) in ops.iter().enumerate() {
            let pre = w.capture();
            w.apply(op);
            let label = format!("op {i}: {op:?}");
            w.assert_i1(&label);
            w.assert_i5(&label);
            w.assert_i9(&label);
            w.assert_i6_i7(&pre, &label);
        }

        // The three terms this phase can move must actually have moved, or the
        // five-term assertion above proved less than it claims. The other two are
        // named in the module header and become live with DEV3's `bid`.
        // The assertion that used to stand here said these two terms could not move
        // and told its reader to delete it once `bid` landed. **`bid` has landed** —
        // `Op::Bid` reached the generator on 2026-08-19 and fills 19 times in 225
        // attempts — so the premise is false and the assertion goes, as instructed
        // by itself. What replaces it is not another claim about what cannot happen:
        // I1 above now quantifies over all five terms with two of them genuinely
        // live, which is what the extended form was always supposed to mean.
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
        w.apply(&Op::Bid { who: 1, part: 50, max_bps: 10_000 });
        prop_assert!(
            w.d.state().premium_collected > 0,
            "the forced prefix must fill: without premium, pps stays at PRECISION and \
             conservation, no-dilution and I1's last two terms all test nothing"
        );
        w.assert_i1("forced open");
        w.assert_i5("forced open");
        w.assert_i9("forced open");

        for (i, op) in ops.iter().enumerate() {
            let pre = w.capture();
            w.apply(op);
            let label = format!("live-round op {i}: {op:?}");
            w.assert_i1(&label);
            w.assert_i5(&label);
            w.assert_i9(&label);
            w.assert_i6_i7(&pre, &label);
        }

        prop_assert!(w.observed.round > 0, "no round was ever live");

        // **Force a terminal outcome so I6 and I7 are decided rather than merely
        // reachable.** A free sequence may leave the round open, and then both
        // assertions run zero times while the case still passes — the shape this
        // suite exists to refuse. Measured before this was added: I6 decided 28
        // rounds and I7 matched 230 times across a run, but nothing held that at
        // more than zero *per case*.
        w.apply(&Op::Jump(4_000));
        let pre = w.capture();
        w.apply(&Op::CloseRound { bounty_to: 0 });
        w.assert_i6_i7(&pre, "forced close");
        prop_assert!(
            w.observed.i6_rounds > 0,
            "I6 was never decided: no round reached a terminal outcome, so the \
             assertion ran on nothing"
        );
        prop_assert!(
            w.observed.i7_rechecks > 0 || w.rounds.len() == 1,
            "I7 never re-read a finalized round, so immutability was never tested"
        );
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
            w.assert_i9("deposit");
        }
        for (i, part) in parts.iter().enumerate() {
            w.apply(&Op::RequestWithdraw { who: i % ACTORS, part: *part, require_idle: false });
            w.assert_i1("withdraw");
            w.assert_i5("withdraw");
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
        w.apply_counted(&Op::Bid { who: 0, part: 60, max_bps: 10_000 });
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
