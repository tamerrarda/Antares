#![no_std]
//! The `PriceSource` interface — the seam between the vault and whatever tells it a price.
//!
//! `04-ORACLE.md` §2 is the single home for this interface and for every rule below; read the
//! *why* there, not from this file. What lives here is the declaration all three contracts build
//! against: the two value types, the adapter's error enum, the trait, and — because writing it
//! twice would mean testing it once — the **one** implementation of `supports_round`'s eight
//! conditions.
//!
//! # This crate exports no contract function, deliberately
//!
//! It contains no `#[contract]`. `#[contractimpl]` emits `#[no_mangle]` Wasm exports, and those
//! survive being linked in as a library — measured on the pinned toolchain, a crate that merely
//! depends on a crate carrying a `#[contract]` exports that contract's functions from its own
//! Wasm. So the interface cannot live inside either implementation: putting it in
//! `reflector-adapter` would export the adapter's surface from the mock's Wasm, and the adapter's
//! immutability rule (`04-ORACLE.md` §1, `docs/TRUST_MODEL.md`) is a claim about precisely that
//! surface, asserted at deploy (`09-DEPLOYMENT.md` §2 step 2).
//!
//! # Frozen at IP-1
//!
//! From IP-1 a change to anything in this file is a **breaking change** for all three developers:
//! announce it, get both acknowledgements, then land it (`DEV-PROTOCOL.md` §5). `AdapterError`'s
//! numbers are ABI in the adapter's own numbering space, independent of the vault's.

use soroban_sdk::{contracterror, contracttrait, contracttype, Env};

// =================================================================================================
// Values
// =================================================================================================

// `feed_decimals` travels with every reading because the vault has to pin it per round and compare
// it later (D-68). The source cannot make that comparison itself: `reading` has no snapshot
// parameter, and one adapter serves every vault instance, so it cannot hold per-round state
// either. It reports; the vault compares.
/// One anchored read. Prices are 1e7 fixed point; `feed_decimals` is the scale they came from.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OracleReading {
    /// Median over the short window, ending at the anchor. The settlement price.
    pub short_twap: i128,
    /// Median over the guard window, ending at the anchor.
    pub guard_twap: i128,
    /// Timestamp of the newest record used.
    pub newest_ts: u64,
    /// The feed's `decimals()` these prices were normalized from.
    pub feed_decimals: u32,
}

// All three are successful returns (D-64): the source answered. Only a genuine malfunction — a
// trap, a wrong interface, an archived instance, or a live-configuration fault — arrives on the
// error channel. That split is the whole of D-60's organizing question, made structural rather
// than left to a decoding convention: `Ok` is a statement about the window, `Err` is a statement
// about this ledger. The two failure variants are opposites and must never be conflated (D-59) —
// one says the feed was dead at that moment, the other says we can no longer see that moment.
/// The outcome of an anchored read. All three are answers; failures arrive as `Err`.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadResult {
    /// Settlement-grade.
    Reading(OracleReading),
    /// No settlement-grade records inside the window. A fact about history.
    Unusable,
    /// The anchor is older than the feed can serve. A fact about now.
    OutOfReach,
}

// Its own numbering space, independent of the vault's. It exists so the vault's recoverable call
// has a concrete `E: TryFrom<Error>` and so a malfunction carries a diagnosable code. The vault
// treats every variant identically (`Transient`) and never branches on one — the codes are for a
// human reading a failed simulation, not for control flow. `BadConfig` is a fact about *now*,
// never about the window: filing one as `Unusable` annuls a round on a healthy feed
// (`04-ORACLE.md` §2).
/// Faults a price source can report. Callers treat all of them alike: retry later.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AdapterError {
    /// The underlying feed call failed.
    FeedUnreachable = 1,
    /// The feed's live configuration cannot serve the requested windows.
    BadConfig = 2,
    /// No feed is pinned.
    NotInitialized = 3,
}

// =================================================================================================
// The trait
// =================================================================================================

// Implemented by `ReflectorAdapter` and by `MockPriceSource`; consumed by the vault through the
// generated `PriceSourceClient`, whose `try_` methods are the recoverable form every call site
// uses (`04-ORACLE.md` §3b).
#[contracttrait]
pub trait PriceSource {
    // `Unusable` and `OutOfReach` are answers and ride in the `Ok` arm; the `Err` arm carries only
    // a live-configuration fault. That split is the routing rule of `04-ORACLE.md` §2, and this
    // signature is what makes the compiler hold it rather than a comment.
    /// Both TWAPs over the windows ending at `anchor`; `anchor == 0` means "ending now".
    fn reading(
        env: Env,
        anchor: u64,
        short_window: u64,
        guard_window: u64,
    ) -> Result<ReadResult, AdapterError>;

    // Cheap, and deliberately not settlement-grade: it guards bids only, and a bid wrongly
    // rejected costs an epoch's premium at most, while a settlement needs the full TWAP and
    // breaker machinery (D-29). The source adds its own `resolution()` to `max_staleness` because
    // resolution is a property of the feed — the vault has no `resolution` field and must never
    // grow one (D-58). A mismatched scale makes the tick incomparable with the round's strike, so
    // it is refused rather than rescaled (D-68).
    /// Freshest single tick at `expected_decimals`, or `None`. Tolerance is `max_staleness`
    /// plus one feed tick. Not settlement-grade.
    fn spot_check(env: Env, max_staleness: u64, expected_decimals: u32) -> Option<i128>;

    // The vault learns yes or no and nothing else — never the resolution, the reach limit or the
    // feed's expiry. That is the seam D-58 opened and D-64 kept closed. `validate_params` passes
    // `round_span = 0`, which skips the sponsorship condition so that a shortfall cannot block the
    // very call that repairs it; `open_epoch` passes `epoch_duration + unresolved_after` and
    // enforces it. Both implementations answer by calling this crate's `supports_round`, so there
    // is exactly one copy of the eight conditions.
    /// Can this source honour a round with this timing? `round_span = 0` skips the feed-expiry
    /// check; otherwise pass `epoch_duration + unresolved_after`.
    fn supports_round(
        env: Env,
        twap_window: u64,
        guard_window: u64,
        oracle_dead_after: u64,
        settle_grace: u64,
        unresolved_after: u64,
        round_span: u64,
    ) -> bool;
}

// =================================================================================================
// The eight conditions — one implementation, called by both sources
// =================================================================================================

/// The feed's reachable depth in ticks: `R = RECORD_CAP_TICKS * resolution()`.
///
/// **255, not 256, and the difference is a void (D-69).** Reflector's bitmask holds 256 records,
/// which span 255 intervals, and `R` is a *depth*. Measured against the live testnet feed on
/// 2026-08-19 by `scripts/verify-environment.ts`: `price(asset, t)` answers at 255 ticks of depth
/// and returns `None` at 256. With 256 the adapter's oldest guard sample would have landed one
/// tick past the horizon, returned `None`, been dropped by `04-ORACLE.md` §2 rule 2, and taken the
/// valid count under its threshold — so a **healthy feed would have produced `Unusable`, which is
/// the void path**: the bidder refunded in full for nothing.
pub const RECORD_CAP_TICKS: u64 = 255;

/// The realized sampling steps for a given live resolution.
///
/// The step is derived and the count is not (D-58): three samples across the short window, five
/// spanning the guard window. Returns `None` on any input that cannot produce a grid — the caller
/// turns that into `false` or `BadConfig` as its context requires.
pub fn steps(res: u64, twap_window: u64, guard_window: u64) -> Option<(u64, u64)> {
    if res == 0 {
        return None;
    }
    let short_step = twap_window
        .checked_div(2)?
        .checked_div(res)?
        .checked_mul(res)?
        .max(res);
    let guard_step = guard_window
        .checked_div(4)?
        .checked_div(res)?
        .checked_mul(res)?
        .max(res);
    Some((short_step, guard_step))
}

/// Evaluate all eight conditions. **The evaluation order is normative: 0, 4, 1, 2, 3, 5, 6, 7.**
///
/// Condition 4 is evaluated first because it is what bounds `guard_window < R`, which is what
/// makes `reach_limit`'s subtraction safe for 3, 5 and 6. The vault's own validation admits a
/// `guard_window` of up to one year while `R` is only 76 500 s at the live resolution, so on a
/// rejected-but-well-formed parameter set that subtraction would otherwise underflow before any
/// condition rejected it.
///
/// Every step is checked regardless of the order, and **any overflow, underflow or unreadable feed
/// configuration returns `false` — never a panic.** The vault additionally calls this through the
/// recoverable form so that even a trapping source surfaces as `InvalidParams` rather than a host
/// trap escaping the constructor (D-68, test O-13e); that wrapper is the vault's, this totality is
/// ours, and the two are independent.
///
/// # Inputs that are the caller's, not ours
///
/// `res` is the source's own live `resolution()`, and `expires`/`now` answer condition 7. Keeping
/// those three as parameters is what lets one function serve both the mock and the real adapter
/// while condition 7 stays a fact about each one's actual feed.
///
/// `round_span == 0` **skips condition 7 entirely**. `validate_params` passes `0` so that a
/// sponsorship shortfall can never block the `set_epoch_params` call that repairs it; `open_epoch`
/// passes `epoch_duration + unresolved_after` and enforces it.
#[allow(clippy::too_many_arguments)]
pub fn supports_round(
    res: u64,
    twap_window: u64,
    guard_window: u64,
    oracle_dead_after: u64,
    settle_grace: u64,
    unresolved_after: u64,
    round_span: u64,
    expires: Option<u64>,
    now: u64,
) -> bool {
    // -- 0. a usable grid exists at all -------------------------------------------------------
    // The overflow arm is unreachable in practice — `resolution()` is a u32, so 255*res cannot
    // exceed ~1.1e12 — and is kept only because a check that reads uniformly is easier to audit
    // than one with a documented exception (04-ORACLE §2).
    if res == 0 {
        return false;
    }
    let Some(r) = RECORD_CAP_TICKS.checked_mul(res) else {
        return false;
    };

    // -- 4. FIRST, because it is what bounds guard_window < R ----------------------------------
    let Some(sum) = oracle_dead_after
        .checked_add(guard_window)
        .and_then(|x| x.checked_add(settle_grace))
    else {
        return false;
    };
    if sum >= r {
        return false;
    }

    // -- 1. the windows can hold 3 and 5 distinct ticks ----------------------------------------
    let (Some(two_res), Some(four_res)) = (res.checked_mul(2), res.checked_mul(4)) else {
        return false;
    };
    if twap_window < two_res || guard_window < four_res {
        return false;
    }

    // -- 2. the REALIZED spans, not the arguments ----------------------------------------------
    // `guard_window > twap_window` is true of the arguments and checked by the vault, and it does
    // not imply the same of the spans: the floors truncate the guard by up to 4*res and the short
    // by only 2*res, so the breaker can end up comparing two equal windows — or an inverted pair,
    // where the guard is the *more* artifact-sensitive side. Silent, and it turns D-25's breaker
    // into a near no-op (D-64).
    let Some((short_step, guard_step)) = steps(res, twap_window, guard_window) else {
        return false;
    };
    let (Some(guard_span), Some(short_span)) =
        (guard_step.checked_mul(4), short_step.checked_mul(2))
    else {
        return false;
    };
    if guard_span <= short_span {
        return false;
    }

    // -- 3. the evidence-free fallback fires strictly after the adapter gives up ----------------
    // Strict: with `>=` the two paths disagree at exactly one instant — the adapter answers
    // `OutOfReach` only when `now - end > reach_limit`, so at `now == expiry + reach_limit` a
    // working adapter still returns a price while `close_round`'s step 2 has already fired. One
    // second wide, and it is the single case where the fallback and the evidence disagree, which
    // is the property D-64 exists to guarantee.
    let Some(reach_limit) = r.checked_sub(guard_window) else {
        return false; // unreachable after condition 4; checked anyway, per the totality rule
    };
    if unresolved_after <= reach_limit {
        return false;
    }

    // -- 5. the void window has its guaranteed width -------------------------------------------
    // IMPLIED BY 4 (`oda + gw + sg < R` rearranges to `sg < reach_limit - oda`), so it can never
    // be the sole cause of a rejection. Kept as executable documentation of the guarantee an
    // operator reasons about; 04-ORACLE §2 records it as redundant precisely so nobody reads it as
    // test coverage, and O-13's matrix does not demand a case for it.
    let Some(void_window) = reach_limit.checked_sub(oracle_dead_after) else {
        return false;
    };
    if void_window < settle_grace {
        return false;
    }

    // -- 6. the ceiling -------------------------------------------------------------------------
    // Without it `unresolved_after` had a floor and no roof, so `set_epoch_params` could push the
    // oracle-free terminal path out until it never fired — an admin setter disabling the exact
    // guarantee D-64 made structural — while `expiry + unresolved_after` overflowed u64 on the
    // way. Every second past `reach_limit` buys nothing: no adapter can answer there.
    let Some(ceiling) = reach_limit.checked_add(settle_grace) else {
        return false;
    };
    if unresolved_after > ceiling {
        return false;
    }

    // -- 7. the feed's own funding outlasts the round ------------------------------------------
    // Only when a span is given. A sponsorship lapse *deletes records that existed at expiry*, so
    // an anchored read afterwards finds an empty window and returns `Unusable` — the void branch —
    // on a feed that was perfectly healthy when the option was written. `expires()` is public, so
    // left unguarded this is D-59's free option returning through a different door: an
    // out-of-the-money bidder reads the eviction date and waits (04-ORACLE §5).
    if round_span == 0 {
        return true;
    }
    let Some(expiry) = expires else {
        return false; // a None expiry is an unfunded feed
    };
    let Some(deadline) = now.checked_add(round_span) else {
        return false;
    };
    expiry > deadline
}

#[cfg(test)]
mod test_conditions;

// =================================================================================================
// The anchored read, factored so both sources run the same arithmetic
// =================================================================================================

/// One fetched record: the raw price at the feed's own scale, and the timestamp it reported.
///
/// The reported timestamp is carried separately from the grid slot it was fetched for, because
/// they can differ — and a feed that answers with a stamp outside the window is exactly what rule 2
/// drops. Test O-4b is unconstructible without that distinction.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub raw_price: i128,
    pub reported_ts: u64,
}

/// The seven grid points of an anchored read, in a fixed order:
/// `[end, end−ss, end−2ss, end−gs, end−2gs, end−3gs, end−4gs]`.
///
/// `end` is shared between the two windows, which is why seven calls cover 3 + 5 samples. The step
/// is derived from the live resolution and the requested windows; **the count is not** (D-58).
pub type Grid = [u64; 7];

const SHORT_SLOTS: [usize; 3] = [0, 1, 2];
const GUARD_SLOTS: [usize; 5] = [0, 3, 4, 5, 6];

/// Rule 0's feasibility check plus rule 1's grid, in that order — **the order is normative**.
///
/// Snapping is `end − (end mod res)`, so performing it before the `res == 0` check is a division by
/// zero, and a panic there is indistinguishable from the adapter faults this step exists to
/// classify. Every failure is `BadConfig`, i.e. a **live-configuration fault**: a fact about *now*,
/// which routes to `Transient` and lets the round retry. Filing any of these as `Unusable` would
/// annul a round on a healthy feed, which is the defect the routing rule exists to forbid.
///
/// The offsets are computed with checked arithmetic rather than argued safe. The environmental
/// argument — that a ledger timestamp is ~1.8e9 while the offsets are bounded by a year — is true
/// of a real network and **false on a fresh test ledger**, where the clock starts near zero and
/// `end < 4·guard_step` is ordinary (02-CONTRACT-SPEC §1's fast-test profiles).
pub fn grid(
    res: u64,
    anchor: u64,
    now: u64,
    short_window: u64,
    guard_window: u64,
) -> Result<(u64, Grid), AdapterError> {
    if res == 0 {
        return Err(AdapterError::BadConfig);
    }
    let Some(r) = RECORD_CAP_TICKS.checked_mul(res) else {
        return Err(AdapterError::BadConfig);
    };
    // The requested windows must still hold 3 and 5 distinct ticks on the *live* grid. This is
    // `supports_round`'s conditions 0 and 1 applied on the read path, and it is what makes the
    // routing rule operative rather than merely declared: the windows were validated against
    // whatever resolution was live then, and this derives from the resolution live now.
    if short_window.checked_div(2).is_none_or(|h| res > h) {
        return Err(AdapterError::BadConfig);
    }
    if guard_window.checked_div(4).is_none_or(|q| res > q) {
        return Err(AdapterError::BadConfig);
    }
    if guard_window >= r {
        return Err(AdapterError::BadConfig); // reach_limit would underflow
    }
    // `reading` is a public function and the vault's call pattern is not a guarantee about every
    // caller.
    if anchor > now {
        return Err(AdapterError::BadConfig);
    }

    let raw_end = if anchor == 0 { now } else { anchor };
    // `res` is non-zero here, but the remainder is taken with `checked_rem` anyway: the
    // `arithmetic_side_effects` lint is a compile-time refusal of the unchecked write, and
    // satisfying it by argument rather than by construction is how the exception creeps back in.
    let Some(rem) = raw_end.checked_rem(res) else {
        return Err(AdapterError::BadConfig);
    };
    let Some(end) = raw_end.checked_sub(rem) else {
        return Err(AdapterError::BadConfig);
    };

    let Some((short_step, guard_step)) = steps(res, short_window, guard_window) else {
        return Err(AdapterError::BadConfig);
    };

    let mut g: Grid = [end; 7];
    for (i, slot) in [1usize, 2].into_iter().enumerate() {
        let mult = u64::try_from(i).ok().and_then(|x| x.checked_add(1));
        let Some(off) = mult.and_then(|m| short_step.checked_mul(m)) else {
            return Err(AdapterError::BadConfig);
        };
        let Some(t) = end.checked_sub(off) else {
            return Err(AdapterError::BadConfig);
        };
        g[slot] = t;
    }
    for (i, slot) in [3usize, 4, 5, 6].into_iter().enumerate() {
        let mult = u64::try_from(i).ok().and_then(|x| x.checked_add(1));
        let Some(off) = mult.and_then(|m| guard_step.checked_mul(m)) else {
            return Err(AdapterError::BadConfig);
        };
        let Some(t) = end.checked_sub(off) else {
            return Err(AdapterError::BadConfig);
        };
        g[slot] = t;
    }
    Ok((end, g))
}

/// Rule 3, evaluated **after rule 0 and before any sampling** — the position is normative.
///
/// Read as "rule 3 runs after rule 2", an out-of-reach anchor would first drop every sample and
/// return `Unusable` — the void branch, refunding an out-of-the-money bidder in full. That is the
/// free option D-59 removed, reachable through nothing but the order two paragraphs are printed in.
///
/// `horizon` is `max(now, last_timestamp())` (D-69). The feed's cap is defined against
/// `last_timestamp`, and the two separate in both directions: a stalled feed leaves it behind
/// `now`, and it can also run ahead of the ledger clock. Taking the larger is never wrong in the
/// direction that costs money and never later than the `now`-based bound D-64's equivalence
/// argument rests on.
pub fn out_of_reach(
    res: u64,
    guard_window: u64,
    horizon: u64,
    end: u64,
) -> Result<bool, AdapterError> {
    let Some(r) = RECORD_CAP_TICKS.checked_mul(res) else {
        return Err(AdapterError::BadConfig);
    };
    let Some(reach_limit) = r.checked_sub(guard_window) else {
        return Err(AdapterError::BadConfig);
    };
    let age = horizon.saturating_sub(end);
    Ok(age > reach_limit)
}

/// Rule 5's normalization to 1e7 fixed point. `None` on overflow — only an absurd scale can
/// overflow a real price, and the multiplying direction exists as well as the dividing one.
pub fn normalize(raw: i128, feed_decimals: u32) -> Option<i128> {
    const TARGET: u32 = 7;
    if feed_decimals == TARGET {
        return Some(raw);
    }
    if feed_decimals > TARGET {
        let exp = feed_decimals.checked_sub(TARGET)?;
        let divisor = 10i128.checked_pow(exp)?;
        raw.checked_div(divisor)
    } else {
        let exp = TARGET.checked_sub(feed_decimals)?;
        let factor = 10i128.checked_pow(exp)?;
        raw.checked_mul(factor)
    }
}

/// Rules 2, 4, 5 and 6: filter, normalize, apply the counts and the odd-set rule, take the medians.
///
/// `samples` are the seven grid slots in [`Grid`] order; `None` is "the feed had no record there".
///
/// Three outcomes, and which one a fault lands in is a transfer of money (04-ORACLE §2):
/// * `Ok(Reading)` — settlement-grade.
/// * `Ok(Unusable)` — a fact about the **records inside the window**. Routes to the void branch.
/// * `Err(BadConfig)` — a fact about the feed's **live configuration**. Routes to `Transient`, so
///   the round retries and still settles if the fault clears.
pub fn fold(
    end: u64,
    grid_points: &Grid,
    samples: &[Option<Sample>; 7],
    short_window: u64,
    guard_window: u64,
    feed_decimals: u32,
) -> Result<ReadResult, AdapterError> {
    let mut normalized: [Option<(i128, u64)>; 7] = [None; 7];
    let mut raw_valid = 0u32;
    let mut zeroed = 0u32;

    for i in 0..7 {
        let Some(sample) = samples[i] else { continue };
        // Rule 2 drops record faults FIRST — missing or non-positive raw values — and only then
        // examines what remains. The order is normative: it is what separates "this feed printed
        // nonsense" from "our scale is wrong".
        if sample.raw_price <= 0 {
            continue;
        }
        let window = if SHORT_SLOTS.contains(&i) && !GUARD_SLOTS.contains(&i) {
            short_window
        } else {
            guard_window
        };
        let lower = end.saturating_sub(window);
        if sample.reported_ts > end || sample.reported_ts < lower {
            continue; // a stamp outside its own window is not evidence about that window
        }
        raw_valid = raw_valid.saturating_add(1);
        let Some(px) = normalize(sample.raw_price, feed_decimals) else {
            return Err(AdapterError::BadConfig);
        };
        if px <= 0 {
            zeroed = zeroed.saturating_add(1);
            continue;
        }
        normalized[i] = Some((px, sample.reported_ts));
    }

    // Rule 5's classification, and the empty case is the one an earlier draft got vacuously wrong:
    // "every sample normalized to zero" is true of the empty set, which would route the clearest
    // dead-window case to `Transient` instead of to the void branch it belongs in.
    if raw_valid > 0 && zeroed == raw_valid {
        return Err(AdapterError::BadConfig); // the scale is wrong, not the records
    }

    let mut short_vals = [0i128; 3];
    let mut short_n = 0usize;
    for &i in SHORT_SLOTS.iter() {
        if let Some((px, _)) = normalized[i] {
            short_vals[short_n] = px;
            short_n = short_n.saturating_add(1);
        }
    }
    // D-65: all three, not "at least two". A median of two has ZERO outlier resistance — it is
    // whichever of the pair the tie-break names — and outlier resistance is the entire reason
    // rule 4 chose a median over a mean.
    if short_n < 3 {
        return Ok(ReadResult::Unusable);
    }

    let mut guard_vals = [0i128; 5];
    let mut guard_ages = [0u64; 5];
    let mut guard_n = 0usize;
    for &i in GUARD_SLOTS.iter() {
        if let Some((px, _)) = normalized[i] {
            guard_vals[guard_n] = px;
            guard_ages[guard_n] = end.saturating_sub(grid_points[i]);
            guard_n = guard_n.saturating_add(1);
        }
    }
    if guard_n < 3 {
        return Ok(ReadResult::Unusable);
    }
    // Both medians are taken over an ODD set. Requiring that removes the tie-break question rather
    // than answering it: there is no even-count case left to round, in Rust or in the Python
    // reference, so the byte-identical vector diff has nothing to disagree about.
    if guard_n.is_multiple_of(2) {
        let mut furthest = 0usize;
        for j in 1..guard_n {
            if guard_ages[j] > guard_ages[furthest] {
                furthest = j;
            }
        }
        for j in furthest..guard_n.saturating_sub(1) {
            guard_vals[j] = guard_vals[j.saturating_add(1)];
            guard_ages[j] = guard_ages[j.saturating_add(1)];
        }
        guard_n = guard_n.saturating_sub(1);
    }

    let mut newest_ts = 0u64;
    for slot in normalized.iter().flatten() {
        if slot.1 > newest_ts {
            newest_ts = slot.1;
        }
    }

    Ok(ReadResult::Reading(OracleReading {
        short_twap: median(&mut short_vals[..short_n]),
        guard_twap: median(&mut guard_vals[..guard_n]),
        newest_ts,
        feed_decimals,
    }))
}

/// The middle element of an odd-sized set. No averaging, so there is no rounding direction to
/// specify and no second definition to keep in sync with the Python reference (D-42, D-65).
fn median(values: &mut [i128]) -> i128 {
    let n = values.len();
    // Insertion sort: n is 3 or 5, and a sort with no allocation and no panic path is worth more
    // here than an asymptotically better one.
    for i in 1..n {
        let mut j = i;
        while j > 0 && values[j.saturating_sub(1)] > values[j] {
            values.swap(j.saturating_sub(1), j);
            j = j.saturating_sub(1);
        }
    }
    values[n / 2]
}

#[cfg(test)]
mod test_reading;
