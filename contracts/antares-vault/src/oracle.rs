//! The guard ladder — the vault's side of the oracle seam.
//!
//! `04-ORACLE.md` §3 is the single home for every rule here. This file carries the **anchored**
//! branch, which is everything `close_round` needs and `open_epoch` does not; the **live** branch
//! ships with `open_epoch` (`DEV2.md` §2.3) and is deliberately not here yet.
//!
//! # The organising question, and it decides who gets paid
//!
//! Every step below answers one question: **is this a fact about the expiry window, or a fact
//! about right now?** Only the first kind is evidence a round may be annulled on. Get it wrong in
//! one direction and a healthy feed refunds an out-of-the-money bidder his entire premium; get it
//! wrong in the other and depositors keep a premium they did not earn. `GuardOutcome` exists to
//! make the distinction structural rather than a comment.
//!
//! # What anchored mode does *not* do, and why the absence is the design
//!
//! **No staleness check and no deviation breaker.** Both apply in live mode only, and their
//! absence here is load-bearing:
//!
//! * Staleness measures the newest record against *now*. Against a historical anchor that is
//!   meaningless — the adapter has already proved enough records exist inside
//!   `[anchor − window, anchor]` — and `anchor − newest_ts` would underflow, since records after
//!   expiry exist by construction.
//! * The breaker would be worse than useless. A frozen window cannot recover from a rejection, so
//!   a breaker here could only ever convert a settleable round into a void — confiscating a
//!   bidder's earned payout, which is the exact harm D-25 exists to prevent, reintroduced through
//!   the back door. The artifact resistance the retry loop used to supply now lives in the
//!   estimator itself: the medians of §2 rule 4 are unmoved by one outlier in three or two in five
//!   (D-42).
//!
//! `docs/TRUST_MODEL.md` §4 and `docs/BIDDER.md` state both publicly. This file is what makes them
//! true.

use price_source_api::{PriceSourceClient, ReadResult};
use soroban_sdk::{Address, Env};

use crate::types::VoidReason;

/// The four ways an anchored read can end, partitioning the branches exhaustively (D-60).
///
/// Exhaustive is the point: `close_round` is one `match` over this behind one time check, which is
/// what makes I10 — *at most one terminal outcome, always reachable* — a property of the shape of
/// the code rather than a claim about its paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardOutcome {
    /// Settlement-grade: the price, and the feed scale it was normalized from.
    ///
    /// The scale travels **with** the price because `open_epoch` has to store it and the close has
    /// to compare against it, and neither can reach the adapter for it separately (D-68).
    Price(i128, u32),
    /// A fact about the **expiry window**: the feed was demonstrably unusable around expiry. The
    /// void branch acts on this and on nothing else.
    DeadAtExpiry(VoidReason),
    /// A fact about **now**, and irreversible: the anchor has aged past what the feed can serve.
    /// `close_round` takes the unresolved branch — depositors keep the premium, the bidder gets
    /// nothing (D-59).
    OutOfReach,
    /// A fact about **this ledger**, and reversible: nothing terminates, anyone retries.
    ///
    /// This variant is why a congested ledger cannot annul a round. Before D-60 a trap was
    /// admissible as evidence about expiry, and a single unreachable moment past the grace period
    /// could void a settleable round. It blocks all three evidence-based paths and clears on retry.
    Transient,
}

/// The anchored read, classified.
///
/// Arguments rather than storage reads, deliberately. `State` is DEV1's and `storage.rs` does not
/// exist yet, but the reason outlasts that: a function that takes the round's snapshot explicitly
/// can be driven through every branch from a test without constructing a live round, and
/// `close_round` is the one path that must never be under-tested.
///
/// * `snapshot_decimals` — `State.feed_decimals`, the scale the round was **opened** under.
/// * `last_settled_spot` — 0 until the first `Settled` round, which skips step 5.
#[allow(clippy::too_many_arguments)]
pub fn anchored_reading(
    env: &Env,
    oracle: &Address,
    anchor: u64,
    twap_window: u64,
    guard_window: u64,
    snapshot_decimals: u32,
    last_settled_spot: i128,
) -> GuardOutcome {
    // outbound: config.oracle
    let client = PriceSourceClient::new(env, oracle);

    // Step 0. Never a bare call. A cross-contract call that panics propagates and kills the
    // caller, so a direct call here would let an oracle that traps — wrong interface, archived
    // instance, its own internal panic — make **every** branch of `close_round` revert forever and
    // permanently trap every depositor's collateral. That is precisely the failure class this
    // design promises cannot exist.
    //
    // The four arms of the recoverable form collapse to two facts. Three of them —- an undecodable
    // return, a typed adapter error, an invocation failure -— are all "the adapter did not answer
    // this ledger", and the vault never branches on which. It does **not** catch budget
    // exhaustion; nothing does, and §3b says so rather than implying otherwise.
    let reading = match client.try_reading(&anchor, &twap_window, &guard_window) {
        Ok(Ok(value)) => value,
        Ok(Err(_)) | Err(_) => return GuardOutcome::Transient,
    };

    let reading = match reading {
        // Step 1. A fact about frozen history: the feed had nothing usable at that moment, and it
        // never will. This is the canonical void.
        ReadResult::Unusable => return GuardOutcome::DeadAtExpiry(VoidReason::FeedUnusable),
        // Step 1b. A fact about the present: the history may have been perfect, we simply waited
        // too long to look. Returning a bare `None` for both of these is what once let a healthy
        // feed produce a void eighteen hours after expiry and refund a bidder his entire premium
        // for doing nothing (D-59).
        ReadResult::OutOfReach => return GuardOutcome::OutOfReach,
        ReadResult::Reading(r) => r,
    };

    // Step 1c, anchored mode only. Live mode *establishes* this value instead of checking it,
    // because at open there is nothing yet to compare against.
    //
    // A scale change is a fact about now, not about the window — so `Transient`, and the round
    // settles normally if the feed reverts. It cannot be waved through: the records inside the
    // window were written under the old scale, and re-reading them under the new one rescales
    // history rather than reading it. A *large* change floors every price to zero, which the
    // adapter already routes to a config fault. A **small** one — 14 to 15 — floors nothing: it
    // produces a price wrong by exactly 10×, and step 5's coarse bound admits that range. The
    // round would settle at a wrong price, which is worse than any void (D-68).
    if reading.feed_decimals != snapshot_decimals {
        return GuardOutcome::Transient;
    }

    // Steps 2 and 4 are live-mode only and are absent by design — see the module docs.

    // Step 3, unconditional, and before any division. The adapter filters non-positive *records*,
    // but nothing guarantees the returned aggregate is positive, and on round 1 step 5 is skipped
    // entirely. Without this a zero price would make `strike = 0` — every bid rejected as in the
    // money, forever — and divide by zero at settlement.
    //
    // Records that exist but are nonsense are still a dead feed at expiry, which is why the void
    // branch cannot simply require `Unusable`: if it refused them the round would drift to
    // `Unresolved` and hand depositors the premium, which is depositors profiting from an oracle
    // failure (D-51).
    if reading.short_twap <= 0 || reading.guard_twap <= 0 {
        return GuardOutcome::DeadAtExpiry(VoidReason::InvalidPrice);
    }

    // Step 5, the coarse 100× sanity bound. Skipped on round 1, where there is nothing to compare
    // against — that skip is asserted (O-8) rather than left implicit.
    //
    // Checked arithmetic, not because the numbers are near a limit but because the alternative is
    // an argument about inputs. `last_settled_spot` is admin-independent and bounded by a real
    // price, but a proof about the inputs is not a check on them.
    if last_settled_spot > 0 {
        let (Some(low), Some(high)) = (
            last_settled_spot.checked_div(100),
            last_settled_spot.checked_mul(100),
        ) else {
            return GuardOutcome::DeadAtExpiry(VoidReason::InvalidPrice);
        };
        if reading.short_twap < low || reading.short_twap > high {
            return GuardOutcome::DeadAtExpiry(VoidReason::InvalidPrice);
        }
    }

    // Step 6.
    GuardOutcome::Price(reading.short_twap, reading.feed_decimals)
}

/// The freshest tick, for DEV3's in-the-money bid guard (D-29).
///
/// Every failure is `None`, which `bid` routes to `OracleUnreachable` and **never** to
/// `InTheMoney`. The keeper counts those two separately and only genuine no-bid epochs advance the
/// stop gate, so conflating them would corrupt the one measurement the project's own continuation
/// depends on.
///
/// `expected_decimals` is the scale the round was opened under. The source refuses on any mismatch
/// — a rescaled tick compared against the round's strike accepts or rejects a bid on a price wrong
/// by a factor of ten (D-68, O-4e). The vault does not add the feed's tick to `max_staleness`: the
/// source does, because resolution is a property of the feed and the vault has no `resolution`
/// field and must never grow one (D-58).
pub fn spot_check(
    env: &Env,
    oracle: &Address,
    max_staleness: u64,
    expected_decimals: u32,
) -> Option<i128> {
    // outbound: config.oracle
    let client = PriceSourceClient::new(env, oracle);
    match client.try_spot_check(&max_staleness, &expected_decimals) {
        Ok(Ok(spot)) => spot.filter(|px| *px > 0),
        Ok(Err(_)) | Err(_) => None,
    }
}

/// `supports_round` through the recoverable form, so an adapter fault during `validate_params` or
/// `open_epoch` surfaces as `InvalidParams` rather than a host trap escaping the constructor
/// (D-68, O-13e).
///
/// A trapping source answers `false`, which the caller turns into `InvalidParams`. The source is
/// also written to return `false` rather than trap; this wrapper does not depend on that, which is
/// the point of having it.
#[allow(clippy::too_many_arguments)]
pub fn supports_round(
    env: &Env,
    oracle: &Address,
    twap_window: u64,
    guard_window: u64,
    oracle_dead_after: u64,
    settle_grace: u64,
    unresolved_after: u64,
    round_span: u64,
) -> bool {
    // outbound: config.oracle
    let client = PriceSourceClient::new(env, oracle);
    match client.try_supports_round(
        &twap_window,
        &guard_window,
        &oracle_dead_after,
        &settle_grace,
        &unresolved_after,
        &round_span,
    ) {
        Ok(Ok(ok)) => ok,
        Ok(Err(_)) | Err(_) => false,
    }
}
