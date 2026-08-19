//! §2.8 — the three pull-based claims, and the last place money leaves the contract.
//!
//! `02-CONTRACT-SPEC.md` §5's *Bidder claims* and §4's rows are the authority; `05-AUCTION-SETTLEMENT.md`
//! §2's *O(1) settlement and pull-based claims* carries the why. Settlement touches no per-bidder
//! state at all (D-19), so everything owed to an individual is claimed here, by them, paying their
//! own fee.
//!
//! **Three rules bind all three functions and none of them is local to one:**
//!
//! - **Any phase, and unpausable** (I8). Pause is a deposit-side control; it may never stand
//!   between someone and money the contract already owes them.
//! - **Both bidder paths decrement `bidder_claimable_total`.** The first draft of §5 omitted it on
//!   the refund path, which violates I1 on the very first refund — the spec records that, and it
//!   is the kind of omission that reads as symmetric until you total the balance.
//! - **A `Fill` is kept with `claimed = true`, never deleted** (§16). Deleting it would make a
//!   re-claim answer `NoFill` instead of `AlreadyClaimed` — the difference between "you already
//!   have it" and "you never had it" — and the record is the bidder's own receipt.
//!
//! D-70: `///` on a `#[contractimpl]` function is ABI payload shipped to every consumer and paid
//! for in the binary, so it carries one or two lines for a caller. Reasoning is in `//`, which is
//! free.

use soroban_sdk::{contractimpl, Address, Env};

use crate::errors::Error;
use crate::events::{FeeClaimed, PayoutClaimed, RefundClaimed};
use crate::storage;
use crate::types::{Fill, Round, RoundOutcome};
use crate::vault;
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

// The two bidder paths differ only in which outcome they accept and how the amount is derived, so
// everything else lives here once. Returns the round record and the unclaimed fill, or the
// rejection the caller should surface.
//
// `touch_fill` rather than `get_fill`, and that is 03-STORAGE-TTL §2 **rule 3** rather than a
// convenience: touching a `Fill` also bumps the `Round(r)` it is computed from. Miss it and the
// round record archives while claims against it are still outstanding, which turns I7's *"always
// reachable"* into *"eventually restorable"*. DEV1's helper, my call site, their review.
fn open_claim(
    env: &Env,
    ctx: &vault::Ctx,
    round: u32,
    bidder: &Address,
    required: RoundOutcome,
) -> Result<(Round, Fill), Error> {
    // Distinct from *archived*, which the caller meets at simulation as a third case (§12). A
    // round that never existed is a caller error; an archived one is a restore.
    let record = storage::get_round(env, round).ok_or(Error::RoundNotFound)?;

    // Outcome before fill, deliberately: a bidder asking the wrong question about a round that
    // exists should learn that before learning whether they were in it, and the round's outcome is
    // public while their fill is theirs.
    if record.outcome != required {
        return Err(Error::WrongOutcome);
    }

    let fill = storage::touch_fill(env, ctx.rent, round, bidder).ok_or(Error::NoFill)?;
    if fill.claimed {
        return Err(Error::AlreadyClaimed);
    }
    Ok((record, fill))
}

// Mark, decrement, and hand back the amount to transfer.
//
// The order is not cosmetic: the `Fill` is written back with `claimed = true` **before** any
// transfer, which is §11's checks-effects-interactions and is what makes a re-entrant claim
// impossible rather than merely unlikely.
fn settle_claim(
    env: &Env,
    ctx: &mut vault::Ctx,
    round: u32,
    bidder: &Address,
    mut fill: Fill,
    amount: i128,
) -> Result<(), Error> {
    fill.claimed = true;
    storage::set_fill(env, ctx.rent, round, bidder, &fill);

    // Both paths decrement. §5 says so explicitly because the first draft did not, and the
    // aggregate is what makes I1 checkable without iterating fills (05 §2).
    ctx.state.bidder_claimable_total = ctx
        .state
        .bidder_claimable_total
        .checked_sub(amount)
        .ok_or(Error::InvalidAmount)?;
    Ok(())
}

// =================================================================================================
// The two per-bidder amounts — extracted so the differential layer can reach them
// =================================================================================================

// `⌊notional × (spot − strike) / spot⌋`, or 0 at or below the strike — §5's *Bidder claims*.
//
// **The same formula `payout_total` uses, on this fill's notional**, which is what makes
// `Σ per-bidder ≤ payout_total` hold: `Σ⌊xᵢ⌋ ≤ ⌊Σxᵢ⌋`, so the per-bidder floor dust stays in the
// pool, in the vault's favour (§6, D-20). Recomputing rather than storing a per-bidder amount at
// settlement is D-19's point — settlement is O(1) and touches no fill, so an attacker cannot make
// it expensive by splitting across addresses.
//
// `checked_sub` although the branch already proves it cannot underflow: §8's bounds are proofs
// about the *inputs*, and a checked op turns a violated proof into a revert rather than a wrapped
// value.
//
// Extracted from `claim_payout` for the same reason `fill_amount` came out of `bid`: a replay
// harness cannot call the inside of an entry point, and a term the differential layer cannot reach
// is a term it does not cover. `claims_ref.py` decomposes it the same way.
pub(crate) fn payout_for_fill(notional: i128, spot: i128, strike: i128) -> Result<i128, Error> {
    if spot <= strike {
        return Ok(0);
    }
    let intrinsic = spot.checked_sub(strike).ok_or(Error::InvalidAmount)?;
    vault::mul_div_floor(notional, intrinsic, spot)
}

// The refund is the recorded premium, unchanged — **no arithmetic at all**, which is the point.
//
// Two bidders on a descending curve paid different rates, so any pro-rata split would silently
// redistribute between them; and because each premium is an integer the same bid *added* to the
// pool, the refunds sum to `premium_collected` with no residue. A function rather than a field
// read so the reference has the same shape to diff against, and so the absence of rounding is
// stated somewhere rather than inferred from its absence.
pub(crate) fn refund_for_fill(premium_paid: i128) -> i128 {
    premium_paid
}

#[contractimpl]
impl AntaresVault {
    // Recomputed from the round's own immutable record, so the answer is the same whenever it is
    // asked; and it works in any phase and while the vault is paused, which is I8.
    /// Collect what a settled round owes you on a fill you made in it.
    /// Any phase, and unpausable.
    pub fn claim_payout(env: Env, round: u32, bidder: Address) -> Result<i128, Error> {
        bidder.require_auth();
        // `false`: unpausable. I8 — pause cannot stand between anyone and money already owed.
        let mut ctx = vault::enter(&env, false)?;

        let (record, fill) = open_claim(&env, &ctx, round, &bidder, RoundOutcome::Settled)?;

        // **The same formula as `payout_total`, on this fill's notional.** That is what makes
        // `Σ per-bidder ≤ payout_total` hold: `Σ⌊xᵢ⌋ ≤ ⌊Σxᵢ⌋`, so the per-bidder floor dust stays
        // in the pool, in the vault's favour (§6, D-20). Recomputing rather than storing a
        // per-bidder amount at settlement is D-19's whole point — settlement is O(1) and touches
        // no fill, so an attacker cannot make it expensive by splitting across addresses.
        let payout = payout_for_fill(fill.notional, record.settled_spot, record.strike)?;

        // §16: a zero-payout settled round answers `NothingToClaim` and the `Fill` stays unclaimed
        // forever, which is correct and costs the vault nothing. Note what it does *not* do — it
        // does not mark the fill, so this is not a state the bidder can be tricked out of.
        if payout == 0 {
            return Err(Error::NothingToClaim);
        }

        settle_claim(&env, &mut ctx, round, &bidder, fill, payout)?;
        vault::commit(&env, &ctx);

        let vault_address = env.current_contract_address();
        vault::asset_client(&env, &ctx.config).transfer(&vault_address, &bidder, &payout);

        PayoutClaimed {
            round,
            bidder,
            amount: payout,
        }
        .publish(&env);

        Ok(payout)
    }

    // Exactly what was paid, to the stroop — no pro-rata arithmetic and no rounding. Any phase,
    // and unpausable, like the other two.
    /// Take back the premium you paid into a round that was voided.
    /// Exactly what you paid.
    pub fn claim_refund(env: Env, round: u32, bidder: Address) -> Result<i128, Error> {
        bidder.require_auth();
        let mut ctx = vault::enter(&env, false)?;

        let (_record, fill) = open_claim(&env, &ctx, round, &bidder, RoundOutcome::Voided)?;

        // **`fill.premium_paid`, exactly — no pro-rata arithmetic and no rounding at all.** Two
        // bidders on a descending curve paid different rates, so a pro-rata split would silently
        // redistribute between them; and because each premium is a recorded integer that the same
        // bid *added* to the pool, `Σ refunds == premium_collected` with no residue. That is
        // stronger than §6's aggregate-dust rule, which is about payouts: the void branch is the
        // one place `bidder_claimable_total` provably drains to exactly zero.
        let refund = refund_for_fill(fill.premium_paid);
        if refund == 0 {
            return Err(Error::NothingToClaim);
        }

        settle_claim(&env, &mut ctx, round, &bidder, fill, refund)?;
        vault::commit(&env, &ctx);

        let vault_address = env.current_contract_address();
        vault::asset_client(&env, &ctx.config).transfer(&vault_address, &bidder, &refund);

        RefundClaimed {
            round,
            bidder,
            amount: refund,
        }
        .publish(&env);

        Ok(refund)
    }

    // Spans rounds rather than belonging to one, which is why the event carries no round. Ships at
    // zero and stays there until a visible admin transaction changes it (D-56).
    /// Collect the accrued protocol fee.
    /// Only the configured `fee_recipient` may call it.
    pub fn claim_fee(env: Env) -> Result<i128, Error> {
        let mut ctx = vault::enter(&env, false)?;
        // Auth after `enter` rather than before, unlike the two bidder paths: *who* the recipient
        // is comes from `Config`, so there is nobody to authenticate until it is loaded. The
        // ordering §16 fixes is over the guards, and this is the same guard in the only position
        // it can occupy.
        ctx.config.fee_recipient.require_auth();

        // **Pulled, never pushed** (D-39). Pushing made settlement depend on the recipient being
        // able to receive: point `fee_recipient` at an address that cannot and `close_round`
        // reverts forever, which is a single admin setter trapping every depositor's collateral in
        // `Active`. With a pull, a bad recipient can strand nothing but the fee.
        let amount = ctx.state.fee_claimable;
        if amount == 0 {
            return Err(Error::NothingToClaim);
        }

        ctx.state.fee_claimable = 0;
        vault::commit(&env, &ctx);

        let vault_address = env.current_contract_address();
        let recipient = ctx.config.fee_recipient.clone();
        vault::asset_client(&env, &ctx.config).transfer(&vault_address, &recipient, &amount);

        FeeClaimed { recipient, amount }.publish(&env);

        Ok(amount)
    }
}
