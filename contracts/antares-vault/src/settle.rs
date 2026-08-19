#![allow(clippy::arithmetic_side_effects)] // there is none: every operation below is `checked_`
//! `close_round` — the single place a round ends.
//!
//! `02-CONTRACT-SPEC.md` §5 is authoritative for the dispatch and for all three paths;
//! `04-ORACLE.md` §3–§4 for the classification this dispatches on.
//!
//! # I10 is a property of this file's shape, not a claim about it
//!
//! *While `phase == Active` and `now ≥ expiry`, `close_round` resolves to **at most one** terminal
//! outcome, always.* That holds because there is **one** entry point (D-61), **one** time check,
//! and **one** `match` over four values that partition the branches exhaustively. The caller never
//! names the outcome — it is a pure function of frozen history — so no ordering of calls and no
//! passage of time can reach two outcomes or an undefined one.
//!
//! Both non-terminating cases close with time rather than with luck: the grace period ends at
//! `expiry + oracle_dead_after`, and a `Transient` that never clears ends at
//! `expiry + unresolved_after`, where step 2 resolves the round **without calling the oracle**.
//!
//! # Step 2 is the sentence the whole seam exists to make true
//!
//! *No oracle state can trap funds.* Nothing else in this project establishes it. The guarded read
//! classifying correctly and the adapter answering correctly both presuppose that the adapter can
//! be **called at all** — and `try_` catches a panic, a wrong interface and an archived instance
//! but provably does **not** catch budget exhaustion, which kills the whole invocation before any
//! classification exists (04-ORACLE §3b). A fallback that had to ask the adapter first would have
//! inherited that hole. This one touches no external contract.
//!
//! The previous answer to "what bounds a `Transient` that never clears" was circular: *the anchor
//! eventually ages out and `OutOfReach` applies*. `OutOfReach` is **the adapter's return value**.
//! An adapter that cannot be called cannot produce it — the vault gets a call failure forever,
//! `close_round` reverts forever, and the round stays `Active` with every depositor's collateral
//! inside it. The stated bound required the broken component to answer (D-64).
//!
//! # Why the fallback adds no reachable outcome
//!
//! `supports_round` condition 3 guarantees `unresolved_after > reach_limit`, **strictly**. So past
//! `expiry + unresolved_after` a *working* adapter could only have answered `OutOfReach`, which
//! reaches this same path with the same accounting. The clock therefore returns what the evidence
//! would have returned, which is what keeps I10 intact and is why the two entrances must produce
//! byte-identical numbers — any divergence would be a case where the outcome depended on whether
//! the adapter happened to be healthy at call time, which is exactly what D-40 and D-61 destroy.
//! The only difference is `oracle_answered`, which is diagnostic and enters no computation.

use soroban_sdk::{contractimpl, Address, Env};

use crate::errors::Error;
use crate::events::{EpochUnresolved, EpochVoided, FeeAccrued, SettleBounty, Settled};
use crate::oracle::{self, GuardOutcome};
use crate::storage::{self, Rent};
use crate::types::{Config, Phase, RoundOutcome, State, VoidReason, BPS, PRECISION};
use crate::vault::{asset_client, finalize_round, lazy_finalize, mul_div_floor, Settlement};
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

#[contractimpl]
impl AntaresVault {
    // **Not pausable**, and that is I8: pause stops new risk being written and never stops a round
    // being closed. `bounty_to` is the caller's choice of recipient, which is what makes paying it
    // safe — an address that cannot receive is the caller's own problem and someone else can close
    // with a different one. Contrast `fee_recipient`, which the admin sets and the caller cannot
    // route around, and which is therefore accrued rather than paid (D-39).
    //
    // O(1) on every branch. No branch iterates fills: a per-bidder loop would make the exit path's
    // cost grow with participation, which is a denial of service aimed at the one path that must
    // never fail. Per-bidder amounts are pulled afterwards, recomputed from the round record.
    /// Close the round. Settles, voids or resolves it as unresolved, and pays the caller's bounty.
    /// Anyone may call it once the round has expired.
    pub fn close_round(env: Env, bounty_to: Address) -> Result<RoundOutcome, Error> {
        let config: Config =
            storage::get_config(&env).expect("Config: unrepresentable after __constructor");
        let mut state: State =
            storage::get_state(&env).expect("State: unrepresentable after __constructor");
        let rent = Rent::effective(&env, &config);

        // Step 0. If the round was an empty auction, this closed it — and that is a real
        // finalization, so the answer is `Lapsed` rather than a revert that would discard it
        // (D-43). The caller asked for the round to end; it ended.
        if lazy_finalize(&env, &mut state, rent)? {
            storage::set_state(&env, &state);
            storage::bump_instance(&env, rent);
            return Ok(RoundOutcome::Lapsed);
        }

        // Step 1.
        if state.phase != Phase::Active {
            return Err(Error::WrongPhase);
        }
        let now = env.ledger().timestamp();
        if now < state.expiry {
            return Err(Error::NotExpired);
        }

        // Step 2, **before any oracle call**. See the module docs: this is the branch that makes
        // "no oracle state can trap funds" a property rather than a sentence.
        let Some(fallback_at) = state.expiry.checked_add(state.params.unresolved_after) else {
            return Err(Error::InvalidParams);
        };
        if now >= fallback_at {
            return unresolved(&env, &config, &mut state, rent, &bounty_to, false);
        }

        // Step 3. One read, one match, four values.
        match oracle::anchored_reading(
            &env,
            &config.oracle,
            state.expiry,
            state.params.twap_window,
            state.params.guard_window,
            state.feed_decimals,
            state.last_settled_spot,
        ) {
            GuardOutcome::Price(spot, _) => {
                settle(&env, &config, &mut state, rent, &bounty_to, spot)
            }
            GuardOutcome::DeadAtExpiry(reason) => {
                // The grace period is not waiting for the feed to recover — frozen history does
                // not recover. It is there so a transient *present-tense* failure cannot be
                // recorded as "the feed was dead at expiry" (04-ORACLE §4).
                let Some(dead_at) = state.expiry.checked_add(state.params.oracle_dead_after) else {
                    return Err(Error::InvalidParams);
                };
                if now < dead_at {
                    return Err(Error::OracleNotDeadYet);
                }
                void(&env, &mut state, rent, reason)
            }
            GuardOutcome::OutOfReach => {
                unresolved(&env, &config, &mut state, rent, &bounty_to, true)
            }
            // Nothing terminates. Anyone retries, and step 2 bounds the wait.
            GuardOutcome::Transient => Err(Error::OracleUnreachable),
        }
    }
}

// =================================================================================================
// The arithmetic, as a pure function of raw numbers
// =================================================================================================

/// What a terminal round computes, before any of it is written anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoundNumbers {
    pub payout_total: i128,
    pub fee: i128,
    pub bounty: i128,
    pub assets_r: i128,
    pub pps: i128,
}

/// The settle and unresolved formulas, taking raw values and touching no storage.
///
/// **Pure on purpose.** `06-TEST-PLAN.md` §4's `fuzz_settlement_math` drives *raw tuples* into
/// these formulas, which is only possible if they can be called without an `Env`, a `State` or a
/// deployed contract. Factoring it out is what makes the fuzz target test the shipped arithmetic
/// rather than a copy of it — the same argument that put the eight conditions in one place.
///
/// **`spot` is an `Option`, and that is what makes "two entrances, one path" structural.** `Some`
/// is the settle branch; `None` is unresolved, where no price was ever observed and the payout is
/// zero by definition rather than by arithmetic. Both then run *identical* code, which is the
/// property D-64 requires and which a second function would only be able to promise.
///
/// Every step is checked. §8's bounds are proofs about legitimate inputs; they are not a licence to
/// stop checking, and this function is reachable from a fuzz target precisely to hunt states
/// outside them.
// Eight, and a struct would not improve it: the fuzz target cannot implement `Arbitrary` for a
// type this crate owns (orphan rule), so it would keep its own shape either way — and then there
// would be two. The same exception `validate_params` and `__constructor` already take.
#[allow(clippy::too_many_arguments)]
pub fn round_numbers(
    spot: Option<i128>,
    strike: i128,
    notional_sold: i128,
    locked_at_open: i128,
    premium_collected: i128,
    shares_snapshot: i128,
    fee_bps: u32,
    bounty_bps: u32,
) -> Result<RoundNumbers, Error> {
    // **Total over its whole input domain, not over the domain its caller happens to produce**
    // (added 2026-08-19 after `fuzz_settlement_math` found it on its first run). Every quantity
    // below is non-negative in every reachable state — `notional_sold` starts at 0 and only `bid`
    // raises it, `strike > 0` is guaranteed by `open_epoch` rejecting a non-positive price before
    // deriving it, and `shares_snapshot > 0` by its `shares_outstanding` check. But this function
    // already refuses to *return* a negative `assets_R` rather than trusting the arithmetic, and
    // trusting the inputs while distrusting the outputs is the inconsistency the fuzzer walked
    // straight into: at `notional_sold < 0` it produced a **negative payout**, which is a transfer
    // *from* the bidder.
    //
    // No reachable behaviour changes — these are all impossible today. What changes is that
    // "impossible" stops being load-bearing on the one path that must never fail.
    if strike <= 0
        || shares_snapshot <= 0
        || notional_sold < 0
        || locked_at_open < 0
        || premium_collected < 0
    {
        return Err(Error::InvalidAmount);
    }

    // I3: strictly below `notional_sold` for every input, including as `spot → ∞`. The fraction
    // `(spot − strike)/spot` is under 1 for every `strike > 0`, and the floor can only make it
    // smaller.
    let payout_total = match spot {
        Some(s) if s > strike => {
            let gap = s.checked_sub(strike).ok_or(Error::InvalidAmount)?;
            mul_div_floor(notional_sold, gap, s)?
        }
        _ => 0,
    };

    // D-39: the snapshot, never the live rate. Read live, an admin could apply a fee retroactively
    // to a round auctioned under a different one — and a large enough value drove `assets_R`
    // negative and wedged the close on a checked subtraction.
    let fee = mul_div_floor(premium_collected, i128::from(fee_bps), BPS)?;
    // From the same open-time snapshot. There is deliberately no second copy of
    // `settle_bounty_bps` in `State` (D-64): a second source of truth for one number, with nothing
    // keeping the two equal.
    let bounty = mul_div_floor(premium_collected, i128::from(bounty_bps), BPS)?;

    // `assets_R` backs `shares_snapshot`. Asserted non-negative rather than assumed: D-39's finding
    // was that a parameter read at the wrong time can drive it below zero, and a checked
    // subtraction that underflows on the exit path is exactly what I8 forbids.
    let assets_r = locked_at_open
        .checked_add(premium_collected)
        .and_then(|v| v.checked_sub(payout_total))
        .and_then(|v| v.checked_sub(fee))
        .and_then(|v| v.checked_sub(bounty))
        .ok_or(Error::InvalidAmount)?;
    if assets_r < 0 {
        return Err(Error::InvalidAmount);
    }

    // §6: floors, so the error is a lower price and the beneficiary is the vault. **Never
    // clamped** — D-66 removed the `pps ≥ 1` floor, because forcing it in the degenerate state
    // makes `Σ claim_withdraw` exceed what was credited, and where I6 and I1 conflict solvency
    // wins. `pps == 0` is a legitimate answer and is recorded honestly.
    let pps = mul_div_floor(assets_r, PRECISION, shares_snapshot)?;

    Ok(RoundNumbers {
        payout_total,
        fee,
        bounty,
        assets_r,
        pps,
    })
}

// =================================================================================================
// Settle
// =================================================================================================

fn settle(
    env: &Env,
    config: &Config,
    state: &mut State,
    rent: Rent,
    bounty_to: &Address,
    spot: i128,
) -> Result<RoundOutcome, Error> {
    // Every number this branch needs, from one pure function that `unresolved` also calls and that
    // `fuzz_settlement_math` drives with raw tuples.
    let n = round_numbers(
        Some(spot),
        state.strike,
        state.notional_sold,
        state.locked_at_open,
        state.premium_collected,
        state.shares_snapshot,
        state.fee_bps_snapshot,
        state.params.settle_bounty_bps,
    )?;
    let (payout_total, fee, bounty, assets_r, pps) =
        (n.payout_total, n.fee, n.bounty, n.assets_r, n.pps);

    state.bidder_claimable_total = state
        .bidder_claimable_total
        .checked_add(payout_total)
        .ok_or(Error::InvalidAmount)?;
    state.fee_claimable = state
        .fee_claimable
        .checked_add(fee)
        .ok_or(Error::InvalidAmount)?;
    // The only branch that writes it: step 5's coarse bound must never be re-based on a price
    // nobody read (04-ORACLE §3).
    state.last_settled_spot = spot;

    let round = state.round;
    let notional_sold = state.notional_sold;
    let premium = state.premium_collected;
    let strike = state.strike;
    let wclaims = finalize_round(
        env,
        state,
        rent,
        RoundOutcome::Settled,
        pps,
        assets_r,
        Settlement {
            fee,
            settled_spot: spot,
            payout_total,
        },
    )?;
    storage::set_state(env, state);
    storage::bump_instance(env, rent);

    Settled {
        round,
        spot,
        strike,
        notional_sold,
        payout_total,
        premium,
        fee,
        pps,
        wclaims,
    }
    .publish(env);
    if fee > 0 {
        FeeAccrued { round, amount: fee }.publish(env);
    }
    pay_bounty(env, config, bounty_to, round, bounty)?;
    Ok(RoundOutcome::Settled)
}

// =================================================================================================
// Void
// =================================================================================================

fn void(
    env: &Env,
    state: &mut State,
    rent: Rent,
    reason: VoidReason,
) -> Result<RoundOutcome, Error> {
    // Every fill's own `premium_paid` comes back, exactly, pulled per bidder through
    // `claim_refund`. No pro-rata arithmetic and no rounding loss: each fill on a Dutch curve paid
    // a different rate, so splitting the pool would move value between counterparties who agreed to
    // different prices — and it would floor, leaving the aggregate short of what was collected.
    state.bidder_claimable_total = state
        .bidder_claimable_total
        .checked_add(state.premium_collected)
        .ok_or(Error::InvalidAmount)?;

    let round = state.round;
    let premium_refunded = state.premium_collected;
    // Exiting shares leave at the **unchanged** price: a void costs depositors nothing, and it
    // earns them nothing either. `last_settled_spot` is untouched — a voided round never produced
    // a settlement price.
    let pps = state.last_pps;
    let wclaims = finalize_round(
        env,
        state,
        rent,
        RoundOutcome::Voided,
        pps,
        state.locked_at_open,
        Settlement::NONE,
    )?;
    storage::set_state(env, state);
    storage::bump_instance(env, rent);

    EpochVoided {
        round,
        reason,
        premium_refunded,
        pps,
        wclaims,
    }
    .publish(env);
    // No bounty, and no event for one (D-51). The bidder is always motivated to void — it is how he
    // gets his premium back — so paying for a call that will happen anyway would be pure cost, and
    // it has no source: the premium is refunded in full, so a bounty could only come out of the
    // refund or out of collateral.
    Ok(RoundOutcome::Voided)
}

// =================================================================================================
// Unresolved — two entrances, one path
// =================================================================================================

fn unresolved(
    env: &Env,
    config: &Config,
    state: &mut State,
    rent: Rent,
    bounty_to: &Address,
    oracle_answered: bool,
) -> Result<RoundOutcome, Error> {
    // The out-of-the-money outcome: premium **retained by depositors**, payout zero. That is what
    // makes waiting worth nothing to an out-of-the-money bidder and strictly negative to an
    // in-the-money one, so every party's best move is to resolve the round. A refund here is what
    // paid the bidder to wait, and no bounty funded from that premium could ever outbid it (D-59).
    //
    // `None`, not `Some(0)`: no price was ever observed on this path. Everything else is the
    // identical call `settle` makes — which is what makes the two entrances agree by construction
    // rather than by two implementations happening to match.
    let n = round_numbers(
        None,
        state.strike,
        state.notional_sold,
        state.locked_at_open,
        state.premium_collected,
        state.shares_snapshot,
        state.fee_bps_snapshot,
        state.params.settle_bounty_bps,
    )?;
    let (fee, bounty, assets_r, pps) = (n.fee, n.bounty, n.assets_r, n.pps);

    state.fee_claimable = state
        .fee_claimable
        .checked_add(fee)
        .ok_or(Error::InvalidAmount)?;

    let round = state.round;
    let premium_retained = state.premium_collected;
    // `last_settled_spot` is **unchanged**: no settlement price was ever observed, so the coarse
    // 100× bound must not be re-based on a price nobody read.
    let wclaims = finalize_round(
        env,
        state,
        rent,
        RoundOutcome::Unresolved,
        pps,
        assets_r,
        // `settled_spot` stays 0 — §2 declares it "0 unless `Settled`" — while the fee is real and
        // has to reach the record, which is the gap that made `Settlement` necessary.
        Settlement {
            fee,
            settled_spot: 0,
            payout_total: 0,
        },
    )?;
    storage::set_state(env, state);
    storage::bump_instance(env, rent);

    EpochUnresolved {
        round,
        premium_retained,
        fee,
        pps,
        wclaims,
        oracle_answered,
    }
    .publish(env);
    if fee > 0 {
        FeeAccrued { round, amount: fee }.publish(env);
    }
    pay_bounty(env, config, bounty_to, round, bounty)?;
    Ok(RoundOutcome::Unresolved)
}

// =================================================================================================
// The one transfer either branch performs
// =================================================================================================

// **Last, after `finalize_round` and after the state is committed** (§11,
// checks-effects-interactions). An earlier version of §5's own list paid it before finalization,
// which §11 then had to override by declaration.
fn pay_bounty(
    env: &Env,
    config: &Config,
    bounty_to: &Address,
    round: u32,
    amount: i128,
) -> Result<(), Error> {
    if amount <= 0 {
        return Ok(());
    }
    // outbound: config.asset
    asset_client(env, config).transfer(&env.current_contract_address(), bounty_to, &amount);
    SettleBounty {
        round,
        to: bounty_to.clone(),
        amount,
    }
    .publish(env);
    Ok(())
}
