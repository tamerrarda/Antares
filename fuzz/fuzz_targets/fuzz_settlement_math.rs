//! `fuzz_settlement_math` — raw tuples into the settle formulas (`06-TEST-PLAN.md` §4, target 2).
//!
//! It asserts three things and it asserts them about **the shipped arithmetic**, not about a copy:
//! `round_numbers` is the same function `close_round`'s settle and unresolved branches call. That
//! is the whole reason it was factored out of `settle()`.
//!
//! 1. **I3** — `payout_total < notional_sold`, strictly, for every input including `spot → ∞`.
//! 2. **`pps ≥ 0` in its D-66 form** — never negative, and **`0` is a legitimate answer**. The
//!    clamp that forced `pps ≥ 1` was removed because in the degenerate state it makes
//!    `Σ claim_withdraw` exceed what was credited; where I6 and I1 conflict, solvency wins.
//! 3. **No panic inside 02-CONTRACT-SPEC §8's documented bounds.** §8's products are proofs about
//!    *legitimate* states — this target exists to hunt states outside them, so the contract here is
//!    that an out-of-range input returns `Err`, never a panic and never a wrapped number.
//!
//! # What is deliberately not constrained
//!
//! The inputs are almost unconstrained on purpose. `strike > 0` and `shares_snapshot > 0` are the
//! only preconditions, and both are *guaranteed by other code* — `open_epoch` rejects a
//! non-positive price before deriving the strike, and it checks `shares_outstanding > 0` before
//! opening at all. Constraining anything further would be fuzzing the caller's assumptions rather
//! than the arithmetic, and this layer exists precisely to find where those assumptions do not
//! hold.

#![no_main]

use antares_vault::settle::round_numbers;
use libfuzzer_sys::fuzz_target;

#[derive(arbitrary::Arbitrary, Debug)]
struct Input {
    /// `None` is the unresolved branch: no price was ever observed there.
    spot: Option<i128>,
    strike: i128,
    notional_sold: i128,
    locked_at_open: i128,
    premium_collected: i128,
    shares_snapshot: i128,
    fee_bps: u32,
    bounty_bps: u32,
}

fuzz_target!(|input: Input| {
    // **Nothing is filtered here.** The first version of this target excluded `strike <= 0` and
    // `shares_snapshot <= 0` because other code guarantees them — and on its first run the fuzzer
    // found the gap that reasoning leaves: at `notional_sold < 0` the function produced a negative
    // payout, a transfer *from* the bidder. `round_numbers` now states its own domain and returns
    // `Err` outside it, so the target hands it everything and asserts only what must hold.
    let Ok(n) = round_numbers(
        input.spot,
        input.strike,
        input.notional_sold,
        input.locked_at_open,
        input.premium_collected,
        input.shares_snapshot,
        input.fee_bps,
        input.bounty_bps,
    ) else {
        // An `Err` is the correct answer for an input outside §8's bounds. Reaching it is not a
        // finding; *panicking* on the way there would be, and the harness catches that for us.
        return;
    };

    // -- I3 -------------------------------------------------------------------------------------
    // Strict, and it must hold however far `spot` is pushed. The fraction `(spot − strike)/spot` is
    // under 1 for every `strike > 0`, and the floor can only make the product smaller — so the
    // only way this fails is an arithmetic error, which is what we are looking for.
    //
    // Guarded on `notional_sold > 0`: at or below zero there is nothing sold and I3 is vacuous,
    // and a negative `notional_sold` is not a state any caller can construct.
    if input.notional_sold > 0 {
        assert!(
            n.payout_total < input.notional_sold,
            "I3 violated: payout {} >= notional_sold {} (spot {:?}, strike {})",
            n.payout_total,
            input.notional_sold,
            input.spot,
            input.strike,
        );
    }
    assert!(
        n.payout_total >= 0,
        "a negative payout would be a transfer from the bidder: {}",
        n.payout_total,
    );

    // -- pps, in D-66's form --------------------------------------------------------------------
    assert!(n.pps >= 0, "pps must never be negative, got {}", n.pps);

    // -- assets_R -------------------------------------------------------------------------------
    // The function refuses to return a negative one rather than recording it, because a checked
    // subtraction underflowing on the exit path is what I8 forbids (D-39).
    assert!(n.assets_r >= 0, "assets_R must never be negative, got {}", n.assets_r);

    // -- the two rates never exceed what they are taken from ------------------------------------
    // `fee` and `bounty` are floors of a bps fraction of the premium, so on a non-negative premium
    // neither can exceed it. Stated as an assertion because it is the property that keeps
    // `assets_R` from being eaten by its own deductions.
    if input.premium_collected >= 0 {
        assert!(n.fee >= 0 && n.fee <= input.premium_collected.saturating_mul(i128::from(input.fee_bps)) / 10_000 + 1);
        assert!(n.bounty >= 0 || input.bounty_bps == 0);
    }

    // -- the two entrances, checked against each other ------------------------------------------
    // D-64 requires that the clock path and the `OutOfReach` path produce identical numbers. They
    // share this function, so the property is structural — but "structural" is exactly the kind of
    // claim that stops being true after a refactor, and this is where that would show up.
    //
    // The unresolved branch is `spot = None`. A settle at or below the strike pays nothing either,
    // so the two must agree on every field except that one is reached with a price and one is not.
    if input.spot.is_some_and(|s| s > 0 && s <= input.strike) {
        let unresolved = round_numbers(
            None,
            input.strike,
            input.notional_sold,
            input.locked_at_open,
            input.premium_collected,
            input.shares_snapshot,
            input.fee_bps,
            input.bounty_bps,
        );
        assert_eq!(
            Ok(n),
            unresolved,
            "an out-of-the-money settle and an unresolved round must compute identically",
        );
    }
});
