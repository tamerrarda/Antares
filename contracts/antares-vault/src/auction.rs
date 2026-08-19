//! §2.7 — the Dutch auction: the decay curve, `bid`, and I2.
//!
//! `02-CONTRACT-SPEC.md` §5 is the authority on `bid`'s steps and §16 on their
//! order; `05-AUCTION-SETTLEMENT.md` §1 carries the *why* and the adversarial
//! analysis. This module owns the surface a counterparty actually touches, so
//! every rejection here is something a stranger will meet and has to understand
//! from an error code alone.
//!
//! **Invariant I2** — `notional_sold ≤ notional_offered ≤ locked_at_open`. The
//! second half is `open_epoch`'s (it snapshots both from `locked_assets`); the
//! first is this module's only job to preserve, and `filled` is the one place it
//! could be broken.
//!
//! **The curve lives here and nowhere else.** `views.rs` calls
//! [`premium_bps`] rather than holding its own copy: a duplicate would be diffed
//! by nothing, since `curve_ref.py` mirrors *this* file, so a second copy sits
//! outside every layer that would catch it drifting (06-TEST-PLAN §2's views
//! entry, and DEV1's reasoning when they left the field wired to 0).
//!
//! D-70: `///` on a `#[contractimpl]` function is ABI payload shipped to every
//! consumer and paid for in the binary, so it carries one or two lines for a
//! caller and nothing else. Reasoning is in `//` comments, which are free.

use soroban_sdk::{contractimpl, Address, Env};

use crate::errors::Error;
use crate::events::BidFilled;
use crate::storage;
use crate::types::{Fill, Phase, State, BPS};
use crate::vault::{self, Ctx};
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};
use price_source_api::PriceSourceClient;

// =================================================================================================
// §5's linear decay curve (D-03)
// =================================================================================================

// `p = start − ⌊(start − floor) × (now − opened_at) / auction_duration⌋`
//
// Linear, integer-exact, monotonically non-increasing, and it reaches exactly
// `floor` at `auction_end` — a timestamp at which no bid is admissible (§16
// makes `bid` require `now < auction_end` strictly), so the floor bounds the
// price from below without ever being transacted at. That is the right direction:
// the reserve is never undercut.
//
// **The floor is on the subtracted term, not on `p`** (§6's rounding table).
// Flooring what is taken away makes `p` very slightly *higher* — at most 1 bp, in
// the vault's favour. Writing it as `⌊start − (start−floor)·e/d⌋` would round the
// other way and hand the bidder the bp.
//
// **Reads `State.params`, never `Config.params`** (§15). A mid-auction
// `set_epoch_params` must not move a live bidder's terms, and taking `&State`
// rather than a bare `&EpochParams` is what makes the wrong copy unreachable
// through the type rather than merely discouraged: a caller in `views.rs` cannot
// pass `Config.params` here by accident and still compile.
//
// **Returns 0 outside the auction window**, which is §12's rule for
// `current_premium_bps` and is kept here so the window has one home too. Both
// halves matter: `Phase::Active` means the offer sold out and the curve stopped
// mattering at that instant (05 §1), and `now >= auction_end` means the window
// is shut — which is also how a stored `Auction` that a lazy lapse has not yet
// closed reads 0 without this function knowing about lazy finalization at all.
pub(crate) fn premium_bps(state: &State, now: u64) -> u32 {
    if state.phase != Phase::Auction || now < state.opened_at || now >= state.auction_end {
        return 0;
    }

    let params = &state.params;
    // `floor <= start` and `0 < auction_duration` are both `validate_params`
    // guarantees (§1), so neither branch below is reachable on a live round.
    // They are still written as saturating/checked rather than asserted: this
    // function is called from a *view*, and a view that panics is a UI that
    // cannot render a round at all.
    let span = params
        .premium_start_bps
        .saturating_sub(params.premium_floor_bps);
    if params.auction_duration == 0 {
        return params.premium_start_bps;
    }

    let elapsed = now.saturating_sub(state.opened_at);
    // u64 throughout: `span <= BPS` and `elapsed < auction_duration <= one year`,
    // so the product is at most 3.2e11 — nowhere near u64. The crate is built
    // under `-D arithmetic_side_effects`, so every step is checked regardless of
    // what the bound proves.
    let decayed = u64::from(span)
        .checked_mul(elapsed)
        .and_then(|n| n.checked_div(params.auction_duration))
        .unwrap_or(u64::from(span));

    // `decayed <= span` because `elapsed < auction_duration`, so this cannot
    // underflow; saturating rather than checked so the view stays panic-free.
    params
        .premium_start_bps
        .saturating_sub(u32::try_from(decayed).unwrap_or(span))
}

// =================================================================================================
// The in-the-money guard (D-29)
// =================================================================================================

// `spot_check` through the client's recoverable form, and **two outcomes that
// must never be conflated**.
//
// `InTheMoney` means a readable price at or above the strike; `OracleUnreachable`
// means the check itself could not be made. The keeper counts them separately and
// only genuine no-bid epochs advance the D-34 stop gate (08-OFFCHAIN §1), so
// collapsing an outage into "no demand" would feed a feed failure straight into
// the gate that can end this project.
//
// `try_` per 04-ORACLE §3b: a trapping, archived or wrong-interface adapter must
// surface as a typed error rather than let a host trap escape `bid`. `None` and a
// trap are the same answer here — the guard could not be made — which is why both
// arms map to one code. The adapter adds its own `resolution()` to
// `max_staleness` internally, so the vault passes its own tolerance and never
// grows a `resolution` field (D-58).
fn spot_check(env: &Env, ctx: &Ctx) -> Result<i128, Error> {
    // outbound: config.oracle
    let client = PriceSourceClient::new(env, &ctx.config.oracle);
    client
        .try_spot_check(&ctx.state.params.max_staleness, &ctx.state.feed_decimals)
        .map_err(|_| Error::OracleUnreachable)?
        .map_err(|_| Error::OracleUnreachable)?
        .ok_or(Error::OracleUnreachable)
}

// =================================================================================================
// §5's `bid`
// =================================================================================================

#[contractimpl]
impl AntaresVault {
    /// Buy part of this round's offer at the current decay price.
    ///
    /// `max_premium_bps` is your own slippage guard: the call rejects rather than
    /// fill above it. Returns the notional actually filled, which may be less
    /// than requested — partial fills are the expected case. The premium is
    /// transferred from you when the fill succeeds.
    pub fn bid(
        env: Env,
        bidder: Address,
        notional: i128,
        max_premium_bps: u32,
    ) -> Result<i128, Error> {
        bidder.require_auth();

        // §16's canonical order, and `enter` is the first three steps of it:
        // `lazy_finalize` then the pause check. Everything below is the
        // precondition block, in the order §16 fixes — one canonical order,
        // because two orders would disagree about *which* rejection a call
        // produces. A zero-notional bid on a paused vault returns `Paused`.
        let mut ctx = vault::enter(&env, true)?;

        // §11, and its position is deliberately the same as `deposit`'s rather
        // than the one DEV3 proposed for the §16 row (after `notional > 0`).
        // `deposit` already answers this pair in code — self-address first, then
        // the amount — and two entry points ordering the same two guards
        // differently is the defect §16's canonical order exists to prevent, one
        // level up. A SAC self-transfer succeeds while moving nothing, so without
        // this a "fill" would cost the bidder no premium at all.
        if bidder == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }

        if notional <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Phase and time. `AuctionClosed` (5) is retired and stays retired:
        // `lazy_finalize` has already moved the phase by the time a late bid is
        // evaluated, so `WrongPhase` is the only answer a late caller can get.
        // The `now < auction_end` comparison is **strict** — a bid in the closing
        // second of the window is admissible and one at `auction_end` is not.
        if ctx.state.phase != Phase::Auction {
            return Err(Error::WrongPhase);
        }
        let now = env.ledger().timestamp();
        if now >= ctx.state.auction_end {
            return Err(Error::WrongPhase);
        }

        // D-63: checked **only while** the gate is both enabled and unexpired.
        // Past `allowlist_expires_at` it is inert and no setter can restore it —
        // `set_allowlist_enabled(true)` after the expiry does nothing, which is
        // what makes the permissionless path a property rather than a promise.
        //
        // `check_allowed` is the bumping read (03-STORAGE-TTL §2 rule 4): it
        // refreshes an existing entry's TTL and creates nothing for a stranger,
        // so a bidder who keeps bidding keeps their entry alive and a probe by
        // someone unlisted writes no storage.
        if ctx.config.allowlist_enabled
            && now < ctx.config.allowlist_expires_at
            && !storage::check_allowed(&env, ctx.rent, &bidder)
        {
            return Err(Error::AllowlistForbidden);
        }

        // The bidder's own guard, before the vault's. They learn the price is
        // above their limit without paying for an oracle read.
        let premium_bps_now = premium_bps(&ctx.state, now);
        if premium_bps_now > max_premium_bps {
            return Err(Error::PremiumAboveMax);
        }

        // D-29. Strictly below the strike, or the vault refuses to sell
        // intrinsic value: the strike is fixed at open while the curve
        // *descends*, so once spot crosses it every fill hands the buyer
        // collateral for pennies. Lapsing keeps the upside, and a lapse costs
        // depositors nothing while a mispriced fill costs them collateral.
        let spot = spot_check(&env, &ctx)?;
        if spot >= ctx.state.strike {
            return Err(Error::InTheMoney);
        }

        // I2's only load-bearing line. `notional_offered >= notional_sold` holds
        // at open and every fill below preserves it, so the subtraction cannot
        // underflow — checked anyway, because §8's bounds are proofs about the
        // inputs and a checked op is what turns a violated proof into a revert.
        let remaining = ctx
            .state
            .notional_offered
            .checked_sub(ctx.state.notional_sold)
            .ok_or(Error::InvalidAmount)?;
        let filled = if notional < remaining {
            notional
        } else {
            remaining
        };

        if filled == 0 {
            return Err(Error::SoldOut);
        }
        // The sliver exception, and it is not a griefing vector: to *create* a
        // sub-`min_fill` remainder an attacker must place a real fill of at least
        // `min_fill` and pay real premium for it, and the sliver they leave is
        // then sweepable by anyone. Without the exception an offer whose
        // remainder dropped below `min_fill` could never fully fill.
        if filled < ctx.state.params.min_fill && filled != remaining {
            return Err(Error::BelowMinFill);
        }

        // `⌊filled × p / BPS⌋` — floor, D-20. The only inbound floor in the
        // contract, so the rounding favours the bidder by at most a stroop and
        // solvency is unaffected.
        let premium = vault::mul_div_floor(filled, i128::from(premium_bps_now), BPS)?;
        // A fill that costs nothing is a free option. Reachable rather than
        // theoretical: a 1-stroop sliver at the floor rounds to zero premium.
        if premium == 0 {
            return Err(Error::ZeroPremium);
        }

        // Upsert, never insert. Re-bids **accumulate** into one record, so
        // per-bidder state is bounded no matter how many times someone bids, and
        // `claimed` stays false — a bidder who has already claimed a *different*
        // round is unaffected, and within a round a claim happens only after it
        // finalizes, by which time no bid is possible.
        let mut fill = storage::get_fill(&env, ctx.state.round, &bidder).unwrap_or(Fill {
            notional: 0,
            premium_paid: 0,
            claimed: false,
        });
        fill.notional = fill
            .notional
            .checked_add(filled)
            .ok_or(Error::InvalidAmount)?;
        fill.premium_paid = fill
            .premium_paid
            .checked_add(premium)
            .ok_or(Error::InvalidAmount)?;
        storage::set_fill(&env, ctx.rent, ctx.state.round, &bidder, &fill);

        ctx.state.notional_sold = ctx
            .state
            .notional_sold
            .checked_add(filled)
            .ok_or(Error::InvalidAmount)?;
        ctx.state.premium_collected = ctx
            .state
            .premium_collected
            .checked_add(premium)
            .ok_or(Error::InvalidAmount)?;

        // Full subscription flips to `Active` immediately (05 §1): the offer is
        // gone, so the curve stops mattering at this instant rather than at
        // `auction_end`, and a later bid gets `WrongPhase` instead of `SoldOut`.
        if ctx.state.notional_sold == ctx.state.notional_offered {
            ctx.state.phase = Phase::Active;
        }

        let round = ctx.state.round;
        let notional_sold_after = ctx.state.notional_sold;
        vault::commit(&env, &ctx);

        // Checks, effects, then interactions — §11. The transfer is after every
        // state write, and an earlier version of §5's list put it at step 4,
        // which §11 had to override by declaration.
        let vault_address = env.current_contract_address();
        vault::asset_client(&env, &ctx.config).transfer(&bidder, &vault_address, &premium);

        BidFilled {
            round,
            bidder,
            notional: filled,
            premium_bps: premium_bps_now,
            premium,
            notional_sold_after,
        }
        .publish(&env);

        Ok(filled)
    }
}
