//! `fuzz_call_sequence` — arbitrary interleavings of every public call (`06-TEST-PLAN.md` §4,
//! target 1).
//!
//! This is the target whose weight exceeds its line count. Four things are asserted and **one of
//! them is made nowhere else in the project**:
//!
//! 1. **I1, I2, I5 after every call**, including after a rejected one — a revert is the outcome
//!    most likely to leave state half-written, so it is checked exactly as a success is.
//! 2. **I4 while any round is live.** `locked_assets` is byte-identical from the moment the phase
//!    leaves `Idle` until it returns, and every outbound transfer in between is funded by the
//!    claimable aggregates **or the pending-deposit pool**. That last clause is not optional and is
//!    the reason a naive I4 fails on a legitimate sequence: `cancel_pending_deposit` runs in any
//!    phase and pays from `pending_deposits_total`, which was never locked (I4's own stated
//!    exception). `docs/INVARIANTS.md` promises I4 is "verified by call-sequence fuzzing" and no
//!    other layer provides it.
//! 3. **I7** — a finalized `Round` record is never rewritten, checked by hashing every record the
//!    run has seen and re-hashing it after every call.
//! 4. **The pause-cannot-trap-funds proof.** Every sequence is replayed with `paused = true`
//!    injected at an arbitrary point, and every call in I8's set that succeeded in the clean run
//!    must still succeed in the paused one. That is I8's own wording — *"succeed under
//!    `paused == true` in every state where they'd succeed unpaused"* — and asserting it needs two
//!    runs, because "would have succeeded" is not observable from inside one.
//!
//! # Why the paused run compares against a recording rather than against a rule
//!
//! A one-run version would have to decide for itself whether a given call *should* have succeeded,
//! which means reimplementing every precondition in the target — a second copy of the contract's
//! logic, diffed by nothing, and wrong in exactly the cases that matter. Running the same sequence
//! twice and comparing outcomes needs no such copy: the clean run *is* the oracle.

#![no_main]

use libfuzzer_sys::fuzz_target;

use antares_vault::types::{EpochParams, Phase};
use antares_vault::{AntaresVault, AntaresVaultClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env, String};

const XLM: i128 = 10_000_000;
const ACTORS: usize = 3;

/// Every public call the contract offers, plus time.
///
/// Amounts are `u32` fractions or small `i64`s rather than free `i128`: the arbitrary bytes are
/// better spent on *orderings* than on values no precondition can accept. `fuzz_settlement_math`
/// already drives raw unconstrained tuples into the arithmetic, which is the other half of the job.
#[derive(arbitrary::Arbitrary, Debug, Clone)]
enum Op {
    Deposit {
        who: u8,
        amount: u32,
    },
    CancelPending {
        who: u8,
    },
    RedeemShares {
        who: u8,
    },
    RequestWithdraw {
        who: u8,
        part: u8,
        require_idle: bool,
    },
    ClaimWithdraw {
        who: u8,
    },
    Bid {
        who: u8,
        part: u8,
        max_bps: u16,
    },
    ClaimPayout {
        who: u8,
        round: u8,
    },
    ClaimRefund {
        who: u8,
        round: u8,
    },
    ClaimFee,
    RestorePosition {
        who: u8,
    },
    OpenEpoch,
    CloseRound {
        bounty_to: u8,
    },
    Transfer {
        from: u8,
        to: u8,
        part: u8,
    },
    Jump {
        seconds: u16,
    },
    Spot {
        up: bool,
        part: u8,
    },
}

impl Op {
    /// I8's set, verbatim from §9: the calls that must succeed under `paused == true` in every
    /// state where they would succeed unpaused.
    ///
    /// `open_epoch`, `deposit` and `bid` are deliberately absent — those are the three the pause is
    /// *for*. Getting this list wrong in either direction breaks the proof: too small and the
    /// target proves less than I8 claims, too large and it fails on a pause working correctly.
    fn in_i8_set(&self) -> bool {
        matches!(
            self,
            Op::CloseRound { .. }
                | Op::RequestWithdraw { .. }
                | Op::ClaimWithdraw { .. }
                | Op::ClaimPayout { .. }
                | Op::ClaimRefund { .. }
                | Op::ClaimFee
                | Op::CancelPending { .. }
                | Op::RedeemShares { .. }
                | Op::RestorePosition { .. }
        )
    }
}

#[derive(arbitrary::Arbitrary, Debug)]
struct Input {
    ops: Vec<Op>,
    /// Where `set_paused(true)` is injected on the second run.
    pause_at: u8,
}

struct World {
    env: Env,
    vault: Address,
    oracle: Address,
    asset: Address,
    admin: Address,
    actors: Vec<Address>,
    /// `locked_assets` observed when the phase last left `Idle`, and the round it belongs to.
    live_locked: Option<(u32, i128)>,
    /// Round record hashes, for I7.
    round_hashes: std::collections::BTreeMap<u32, u64>,
}

fn params() -> EpochParams {
    EpochParams {
        epoch_duration: 2_400,
        auction_duration: 100,
        min_idle_gap: 48,
        strike_bps_otm: 300,
        premium_start_bps: 450,
        premium_floor_bps: 40,
        twap_window: 10,
        guard_window: 20,
        max_staleness: 30,
        max_deviation_bps: 100,
        oracle_dead_after: 60,
        settle_grace: 10,
        unresolved_after: 240,
        min_fill: 100 * XLM,
        min_deposit: 10 * XLM,
        settle_bounty_bps: 25,
    }
}

impl World {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        // Not zero: the mock reports `last_timestamp() == 0` both for "no records" and for "a
        // record stamped at 0", so a price written at time 0 reads as an absent feed.
        env.ledger().set_timestamp(1_800_000_000);
        env.cost_estimate().budget().reset_unlimited();

        let admin = Address::generate(&env);
        let fee_recipient = Address::generate(&env);
        let oracle = env.register(mock_price_source::MockPriceSource, (admin.clone(), 14u32));
        let asset = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let vault = env.register(
            AntaresVault,
            (
                admin.clone(),
                asset.clone(),
                oracle.clone(),
                fee_recipient,
                params(),
                String::from_str(&env, "-F"),
                1_000_000 * XLM,
                100u32,
                5_000u32,
                0u64,
            ),
        );

        let actors: Vec<Address> = (0..ACTORS).map(|_| Address::generate(&env)).collect();
        let sac = StellarAssetClient::new(&env, &asset);
        for a in &actors {
            sac.mint(a, &(100_000 * XLM));
        }

        let w = World {
            env,
            vault,
            oracle,
            asset,
            admin,
            actors,
            live_locked: None,
            round_hashes: std::collections::BTreeMap::new(),
        };
        w.prime_feed();
        w
    }

    fn prime_feed(&self) {
        let now = self.env.ledger().timestamp();
        let o = mock_price_source::MockPriceSourceClient::new(&self.env, &self.oracle);
        // A flat history deep enough for both windows, at a scale the round's `feed_decimals`
        // snapshot will match.
        o.fill(&now, &40, &(4_000_000i128 * 10_000_000));
        o.set_expires(&Some(now + 10_000_000));
    }

    fn client(&self) -> AntaresVaultClient<'_> {
        AntaresVaultClient::new(&self.env, &self.vault)
    }

    fn state(&self) -> antares_vault::types::State {
        self.env.as_contract(&self.vault, || {
            antares_vault::storage::get_state(&self.env).unwrap()
        })
    }

    fn actor(&self, i: u8) -> Address {
        self.actors[usize::from(i) % ACTORS].clone()
    }

    fn balance(&self, of: &Address) -> i128 {
        soroban_sdk::token::TokenClient::new(&self.env, &self.asset).balance(of)
    }

    fn shares(&self, of: &Address) -> i128 {
        self.client().balance(of)
    }

    /// The four buckets I1 says the contract's XLM must cover, plus the pending pool.
    fn liabilities(&self) -> (i128, i128, i128, i128, i128) {
        let s = self.state();
        (
            s.locked_assets,
            s.pending_deposits_total,
            s.withdraw_claimable_total,
            s.bidder_claimable_total,
            s.fee_claimable,
        )
    }

    fn apply(&self, op: &Op) -> bool {
        let c = self.client();
        let ok = match op {
            Op::Deposit { who, amount } => c
                .try_deposit(&self.actor(*who), &(i128::from(*amount) * XLM / 100))
                .is_ok(),
            Op::CancelPending { who } => c.try_cancel_pending_deposit(&self.actor(*who)).is_ok(),
            Op::RedeemShares { who } => c.try_redeem_shares(&self.actor(*who)).is_ok(),
            Op::RequestWithdraw {
                who,
                part,
                require_idle,
            } => {
                let a = self.actor(*who);
                let n = self.shares(&a) * i128::from(*part) / 100;
                c.try_request_withdraw(&a, &n, require_idle).is_ok()
            }
            Op::ClaimWithdraw { who } => c.try_claim_withdraw(&self.actor(*who)).is_ok(),
            Op::Bid { who, part, max_bps } => {
                let st = self.state();
                let n = st.notional_offered.max(1) * i128::from(*part) / 100;
                c.try_bid(&self.actor(*who), &n, &u32::from(*max_bps))
                    .is_ok()
            }
            Op::ClaimPayout { who, round } => c
                .try_claim_payout(&u32::from(*round), &self.actor(*who))
                .is_ok(),
            Op::ClaimRefund { who, round } => c
                .try_claim_refund(&u32::from(*round), &self.actor(*who))
                .is_ok(),
            Op::ClaimFee => c.try_claim_fee().is_ok(),
            Op::RestorePosition { who } => c.try_restore_position(&self.actor(*who)).is_ok(),
            Op::OpenEpoch => c.try_open_epoch().is_ok(),
            Op::CloseRound { bounty_to } => c.try_close_round(&self.actor(*bounty_to)).is_ok(),
            Op::Transfer { from, to, part } => {
                let f = self.actor(*from);
                let n = self.shares(&f) * i128::from(*part) / 100;
                c.try_transfer(&f, &self.actor(*to), &n).is_ok()
            }
            Op::Jump { seconds } => {
                let t = self.env.ledger().timestamp();
                self.env.ledger().set_timestamp(t + u64::from(*seconds) + 1);
                self.prime_feed();
                true
            }
            Op::Spot { up, part } => {
                // A price that moves is what makes the ITM guard and the settle branch reachable.
                let base = 4_000_000i128;
                let delta = base * i128::from(*part) / 200;
                let px = if *up {
                    base + delta
                } else {
                    (base - delta).max(1)
                };
                let o = mock_price_source::MockPriceSourceClient::new(&self.env, &self.oracle);
                o.fill(&self.env.ledger().timestamp(), &40, &(px * 10_000_000));
                true
            }
        };
        ok
    }

    /// I1, I2, I5, I4 and I7, after every call.
    fn check(
        &mut self,
        label: &str,
        before: Option<(i128, i128, i128, i128, i128, i128, Phase, u32)>,
    ) {
        let s = self.state();

        // --- I1 (extended): the contract's XLM covers every bucket it owes. -------------------
        let held = self.balance(&self.vault);
        let owed = s.locked_assets
            + s.pending_deposits_total
            + s.withdraw_claimable_total
            + s.bidder_claimable_total
            + s.fee_claimable;
        assert!(
            held >= owed,
            "I1 violated after {label}: holds {held}, owes {owed}"
        );

        // --- I2: the offer never exceeds its own backing, and never oversells. ----------------
        assert!(
            s.notional_sold <= s.notional_offered && s.notional_offered <= s.locked_at_open,
            "I2 violated after {label}: sold {} offered {} locked_at_open {}",
            s.notional_sold,
            s.notional_offered,
            s.locked_at_open
        );

        // --- I5: balances sum to supply, over the closed set of holders. ----------------------
        let mut sum = self.shares(&self.vault);
        for a in &self.actors {
            sum += self.shares(a);
        }
        assert_eq!(
            sum, s.shares_outstanding,
            "I5 violated after {label}: balances {sum}, supply {}",
            s.shares_outstanding
        );

        // --- I4: the locked collateral does not move while a round is live. -------------------
        //
        // Two halves. `locked_assets` byte-identical from the moment the phase leaves `Idle` until
        // it returns; and any XLM that left the contract in between accounted for by a fall in the
        // claimable aggregates **or the pending pool**.
        //
        // The pending pool is the clause that makes this assertion survive a legitimate sequence.
        // `cancel_pending_deposit` works in any phase and returns money that was never locked, so
        // an I4 written without it fails on "deposit during the auction, then cancel" — which is
        // ordinary behaviour and I4's own stated exception.
        if s.phase != Phase::Idle {
            match self.live_locked {
                None => self.live_locked = Some((s.round, s.locked_assets)),
                Some((round, locked)) if round == s.round => {
                    assert_eq!(
                        s.locked_assets, locked,
                        "I4 violated after {label}: locked_assets moved from {locked} to {} while \
                         round {round} was live",
                        s.locked_assets
                    );
                }
                Some(_) => self.live_locked = Some((s.round, s.locked_assets)),
            }
            if let Some((held_before, lk, pd, wc, bc, fc, phase_before, _)) = before {
                if phase_before != Phase::Idle {
                    let out = held_before - held;
                    if out > 0 {
                        let funded = (pd - s.pending_deposits_total)
                            + (wc - s.withdraw_claimable_total)
                            + (bc - s.bidder_claimable_total)
                            + (fc - s.fee_claimable);
                        assert!(
                            funded >= out,
                            "I4 violated after {label}: {out} stroops left the contract during a \
                             live round but the claimable aggregates and the pending pool only \
                             fell by {funded} — the difference came out of locked collateral \
                             (locked was {lk})"
                        );
                    }
                }
            }
        } else {
            self.live_locked = None;
        }

        // --- I7: a finalized Round record is never rewritten. ---------------------------------
        for r in 1..=s.round {
            let record = self.env.as_contract(&self.vault, || {
                antares_vault::storage::get_round(&self.env, r)
            });
            let Some(record) = record else { continue };
            let mut h: u64 = 1469598103934665603;
            for byte in [
                record.pps,
                record.strike,
                record.notional_sold,
                record.premium,
                record.fee,
                record.settled_spot,
                record.payout_total,
                i128::from(record.expiry),
                record.outcome as i128,
            ]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            {
                h ^= u64::from(byte);
                h = h.wrapping_mul(1099511628211);
            }
            match self.round_hashes.get(&r) {
                Some(prev) => assert_eq!(
                    *prev, h,
                    "I7 violated after {label}: round {r}'s finalized record was rewritten"
                ),
                None => {
                    self.round_hashes.insert(r, h);
                }
            }
        }
    }

    fn snapshot(&self) -> (i128, i128, i128, i128, i128, i128, Phase, u32) {
        let s = self.state();
        let (lk, pd, wc, bc, fc) = self.liabilities();
        (
            self.balance(&self.vault),
            lk,
            pd,
            wc,
            bc,
            fc,
            s.phase,
            s.round,
        )
    }
}

fuzz_target!(|input: Input| {
    if input.ops.is_empty() || input.ops.len() > 40 {
        return;
    }

    // ---- Run A: the sequence as given, recording which I8-set calls succeeded. ----------------
    let mut a = World::new();
    let mut clean_outcomes: Vec<bool> = Vec::with_capacity(input.ops.len());
    for (i, op) in input.ops.iter().enumerate() {
        let before = Some(a.snapshot());
        let ok = a.apply(op);
        clean_outcomes.push(ok);
        a.check(&std::format!("op {i}"), before);
    }

    // ---- Run B: the same sequence, paused partway. --------------------------------------------
    //
    // Same construction, so the two runs are identical up to the injected pause: `Env::default()`
    // is deterministic and every address is generated in the same order.
    let mut b = World::new();
    let at = usize::from(input.pause_at) % input.ops.len();
    for (i, op) in input.ops.iter().enumerate() {
        if i == at {
            b.env.mock_all_auths();
            let _ = b.client().try_set_paused(&true);
        }
        let before = Some(b.snapshot());
        let ok = b.apply(op);
        b.check(&std::format!("paused op {i}"), before);

        // **The pause-cannot-trap-funds proof.** Past the injection point, every call in I8's set
        // that succeeded unpaused must still succeed. Before the injection point the two runs are
        // identical, so a difference there would be non-determinism in the harness rather than a
        // finding — which is why the comparison is guarded on `i >= at` rather than run for the
        // whole sequence.
        if i >= at && op.in_i8_set() && clean_outcomes[i] && !ok {
            panic!(
                "I8 violated: {op:?} at index {i} succeeded unpaused and failed with paused = true. \
                 Pause is a deposit-side control and may never stand between someone and money the \
                 contract already owes them."
            );
        }
    }

    // The admin is unused past construction in most sequences; touching it keeps the field from
    // being optimised into a warning while documenting that pause is the only admin power this
    // target exercises.
    let _ = &a.admin;
    let _ = &b.admin;
});
