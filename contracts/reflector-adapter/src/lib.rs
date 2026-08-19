#![no_std]
//! `ReflectorAdapter` — the `PriceSource` over Reflector's CEX & DEX XLM/USD feed.
//!
//! `04-ORACLE.md` is the single home for every rule below; read the *why* there, not here.
//!
//! # It holds no power of its own, and that is checkable
//!
//! No admin, no `upgrade`, no setter of any kind. Its entire exported surface is the three
//! `PriceSource` methods plus the constructor, and the deploy script asserts exactly that
//! (`09-DEPLOYMENT.md` §2 step 2). This is load-bearing rather than tidy: **every settlement number
//! is computed in here**, so an upgradeable adapter would be a second trust concentration exactly
//! as powerful as the vault's own `upgrade()` — able to move the settlement price silently — while
//! appearing in no trust statement. `docs/TRUST_MODEL.md` says so to users. If Reflector ever
//! migrates addresses the answer is a reviewed vault upgrade shipping a new adapter (D-13), which
//! is deliberate friction on the most security-critical dependency there is.
//!
//! That claim is about the **exported surface**, and there is a way to break it without writing a
//! setter: `#[contractimpl]`'s `#[no_mangle]` exports survive being linked in as a library, so a
//! dependency carrying a `#[contract]` would export its functions from this Wasm too. Hence no
//! crate in this one's dependency graph contains a `#[contract]` — `price-source-api` is library
//! only and registers nothing.
//!
//! # Nothing about the feed is remembered
//!
//! `resolution()` and `decimals()` are read **live on every call**, and the sampling grid, the
//! reachable depth and the normalization all derive from them. That is the whole of D-48, D-58 and
//! D-64: each of those decisions removed one constant that had been copied out of the feed and
//! then drifted. The only things stored here are the two the constructor pins.

use price_source_api::{self as api, AdapterError, PriceSource, ReadResult, Sample};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

// `pub`, and not to be generous with the API. `#[contractclient]` uses the trait only as a
// template — nothing implements it and nothing calls it by name — so a private module makes it
// dead code to the compiler and `-D warnings` refuses the build. The honest fix is to say what is
// true: this module *is* this crate's declared view of Reflector, and it is the thing a reader
// should be able to check against the feed's own source. Silencing the lint instead would hide a
// real question behind an `allow`.
pub mod reflector;
use reflector::{Asset, ReflectorClient};

#[contracttype]
#[derive(Clone)]
enum Key {
    /// The Reflector contract, pinned at construction. No setter — see the module docs.
    Feed,
    /// The asset symbol on that feed. XLM is `Other("XLM")`, verified live (D-48).
    Asset,
}

#[contract]
pub struct ReflectorAdapter;

// =================================================================================================
// Construction and internals
// =================================================================================================

#[contractimpl]
impl ReflectorAdapter {
    /// Pins the feed and the asset. There is no second call and no way to change either.
    ///
    /// **Feed selection is a security requirement, not plumbing (D-30).** The address handed in
    /// here must be Reflector's *external CEX & DEX* feed — prices aggregated from deep off-chain
    /// markets — and never an SDEX-sourced one. The 2026-02 YieldBlox exploit was exactly a
    /// correctly-functioning oracle reading a manipulable thin on-chain market: one trade, 100×
    /// price, $10 M gone. Global XLM/USD cannot be moved by a trade anyone can afford for the
    /// premium at stake here. Which address that is cannot be checked from inside a contract, so
    /// the deploy script asserts the pinned feed's identity — base asset and asset list — before
    /// any epoch opens (`09-DEPLOYMENT.md` §2 step 2).
    pub fn __constructor(env: Env, feed: Address, asset: Symbol) {
        env.storage().instance().set(&Key::Feed, &feed);
        env.storage().instance().set(&Key::Asset, &asset);
        Self::pay_rent(&env);
    }

    /// Extend the instance TTL to the **live** network ceiling, on every entry point.
    ///
    /// `04-ORACLE.md` §1 is the single home for why this is shaped the way it is.
    /// `03-STORAGE-TTL.md` §2 requires that TTL values not be compile-time constants, because
    /// ledger close time is a moving target — and its mechanism for that is an admin setter, which
    /// this contract is forbidden. So nothing is stored: the ceiling is read live and extended to,
    /// exactly the discipline `resolution()` gets, and a close-time halving cannot silently halve a
    /// number that was never written down.
    ///
    /// Not decoration. This contract's whole state is two small entries, and if they expire the
    /// vault's reads fail — which classifies as `Transient`, so **every round drifts to
    /// `Unresolved` on a perfectly healthy feed**: depositors keep every premium, bidders get
    /// nothing. Collateral is never trapped, because D-64's fallback makes no oracle call at all,
    /// and archival is permissionlessly restorable — but between those two facts sits a silent
    /// economic failure for as long as nobody notices.
    fn pay_rent(env: &Env) {
        let max = env.storage().max_ttl();
        env.storage().instance().extend_ttl(max / 2, max);
    }

    fn feed(env: &Env) -> Result<ReflectorClient<'_>, AdapterError> {
        let addr: Address = env
            .storage()
            .instance()
            .get(&Key::Feed)
            .ok_or(AdapterError::NotInitialized)?;
        Ok(ReflectorClient::new(env, &addr))
    }

    fn asset(env: &Env) -> Result<Asset, AdapterError> {
        let symbol: Symbol = env
            .storage()
            .instance()
            .get(&Key::Asset)
            .ok_or(AdapterError::NotInitialized)?;
        Ok(Asset::Other(symbol))
    }

    /// The live tick, in seconds.
    ///
    /// Every Reflector call in this file goes through a `try_` and maps failure to
    /// `FeedUnreachable`. The adapter is written not to trap in the first place, because a trap
    /// here is one the vault has to catch to avoid trapping collateral — and the vault must not
    /// have to depend on this contract being correct (§3b).
    fn live_resolution(env: &Env) -> Result<u64, AdapterError> {
        let res = Self::feed(env)?
            .try_resolution()
            .map_err(|_| AdapterError::FeedUnreachable)?
            .map_err(|_| AdapterError::FeedUnreachable)?;
        Ok(u64::from(res))
    }

    fn live_decimals(env: &Env) -> Result<u32, AdapterError> {
        Self::feed(env)?
            .try_decimals()
            .map_err(|_| AdapterError::FeedUnreachable)?
            .map_err(|_| AdapterError::FeedUnreachable)
    }

    fn live_last_timestamp(env: &Env) -> Result<u64, AdapterError> {
        Self::feed(env)?
            .try_last_timestamp()
            .map_err(|_| AdapterError::FeedUnreachable)?
            .map_err(|_| AdapterError::FeedUnreachable)
    }
}

// =================================================================================================
// PriceSource
// =================================================================================================

#[contractimpl(contracttrait)]
impl PriceSource for ReflectorAdapter {
    /// The anchored read: seven point queries on a grid derived from the live resolution, filtered,
    /// normalized, and reduced to two medians over odd sample sets.
    ///
    /// The outcomes are not interchangeable, and misfiling one is a transfer of money
    /// (`04-ORACLE.md` §2's routing rule):
    ///
    /// * `Ok(Reading)` — settlement-grade.
    /// * `Ok(Unusable)` — about the **records inside the window**. Routes to the void branch: the
    ///   bidder is refunded in full and depositors gain nothing.
    /// * `Ok(OutOfReach)` — about the **anchor being older than the feed can serve**. Routes to
    ///   unresolved: depositors keep the premium, the bidder gets nothing.
    /// * `Err(_)` — about the **feed's live configuration or reachability**, i.e. about *this
    ///   ledger*. Routes to `Transient`: nothing terminates, anyone retries, and the round still
    ///   settles once the fault clears.
    ///
    /// The last row is the one that keeps being misfiled, because it *feels* like a dead feed. It
    /// is not: the records are intact and only our ability to derive a grid over them has lapsed. A
    /// feed that re-times itself can re-time itself back, and classifying that as `Unusable`
    /// annuls a round and hands an out-of-the-money bidder his whole premium on a healthy feed —
    /// the incentive D-59 exists to destroy.
    fn reading(
        env: Env,
        anchor: u64,
        short_window: u64,
        guard_window: u64,
    ) -> Result<ReadResult, AdapterError> {
        ReflectorAdapter::pay_rent(&env);

        let res = ReflectorAdapter::live_resolution(&env)?;
        let decimals = ReflectorAdapter::live_decimals(&env)?;
        let now = env.ledger().timestamp();

        // Rules 0 and 1: feasibility, then the grid — and that order is normative, because snapping
        // divides by `res` and a division by zero here would be indistinguishable from the adapter
        // faults this step exists to classify.
        let (end, points) = api::grid(res, anchor, now, short_window, guard_window)?;

        // Rule 3, before any sampling, and the position is normative. Read as "after rule 2", an
        // out-of-reach anchor would first drop every sample and return `Unusable` — the void
        // branch, refunding an out-of-the-money bidder in full for nothing but patience. That is
        // the free option D-59 removed, reachable through nothing but the order two paragraphs are
        // printed in.
        //
        // The horizon is `max(now, last_timestamp())` (D-69). Reflector's cap is defined against
        // `last_timestamp`, and the two separate in both directions: a stalled feed leaves it
        // behind `now`, and Reflector carries an explicit branch for it running ahead of the ledger
        // clock. The larger of the two is never wrong in the direction that costs money.
        let horizon = now.max(ReflectorAdapter::live_last_timestamp(&env)?);
        if api::out_of_reach(res, guard_window, horizon, end)? {
            return Ok(ReadResult::OutOfReach);
        }

        let feed = ReflectorAdapter::feed(&env)?;
        let asset = ReflectorAdapter::asset(&env)?;
        let mut samples: [Option<Sample>; 7] = [None; 7];
        for (i, slot) in samples.iter_mut().enumerate() {
            let Some(&t) = points.get(i) else { continue };
            // A failed *call* is a fact about this ledger and must never be quietly read as a
            // missing record: one is `Transient`, the other is the void branch. So it propagates
            // rather than becoming a `None` sample.
            let record = feed
                .try_price(&asset, &t)
                .map_err(|_| AdapterError::FeedUnreachable)?
                .map_err(|_| AdapterError::FeedUnreachable)?;
            *slot = record.map(|p| Sample {
                raw_price: p.price,
                reported_ts: p.timestamp,
            });
        }

        // Rules 2, 4, 5 and 6 — filtering, normalization, the counts, the odd-set rule and the
        // medians — live in `price-source-api`, so this adapter and the mock the O-matrix drives
        // run the same arithmetic. Written twice they would be tested once.
        api::fold(end, &points, &samples, short_window, guard_window, decimals)
    }

    /// The freshest tick, for the in-the-money bid guard (D-29). Cheap and **not**
    /// settlement-grade — it guards bids only, and settlement never touches it.
    ///
    /// The asymmetry with `reading` is deliberate: a bid wrongly rejected costs an epoch's premium
    /// at most and a lapsed epoch is free, while a settlement needs the full TWAP and breaker
    /// machinery. Every failure here is simply `None`, which the vault routes to
    /// `OracleUnreachable` — never to `InTheMoney`, because the keeper counts those two separately
    /// and only genuine no-bid epochs advance the stop gate.
    fn spot_check(env: Env, max_staleness: u64, expected_decimals: u32) -> Option<i128> {
        ReflectorAdapter::pay_rent(&env);

        let decimals = ReflectorAdapter::live_decimals(&env).ok()?;
        // A changed scale makes the tick incomparable with the round's strike (D-68). This function
        // returns a bare `Option` and so cannot report the scale it used, which is exactly why the
        // caller passes the one it committed to and this refuses on any mismatch. O-4e is the
        // regression test for the sibling path — an earlier draft fixed the settlement side of a
        // decimals change and left this one, where a rescaled tick compared against the strike
        // accepts or rejects a bid on a price wrong by a factor of ten.
        if decimals != expected_decimals {
            return None;
        }

        let feed = ReflectorAdapter::feed(&env).ok()?;
        let asset = ReflectorAdapter::asset(&env).ok()?;
        let record = feed.try_lastprice(&asset).ok()?.ok()??;

        // The staleness budget is the caller's tolerance **plus one feed tick**, and the tick is
        // added *here* rather than by the vault: resolution is a property of the feed, and the
        // vault has no `resolution` field and must never grow one (D-58).
        let res = ReflectorAdapter::live_resolution(&env).ok()?;
        let tolerance = res.checked_add(max_staleness)?;
        let now = env.ledger().timestamp();
        if now.saturating_sub(record.timestamp) > tolerance {
            return None;
        }
        if record.price <= 0 {
            return None;
        }
        api::normalize(record.price, decimals).filter(|px| *px > 0)
    }

    /// Can this feed honour this round's timing? The vault learns yes or no and nothing else.
    ///
    /// It never sees `resolution()`, the reach limit, the expiry timestamp, the Reflector address
    /// or the `Asset` variant — that is the seam D-58 opened and D-64 kept closed, and it is why
    /// this question lives in the adapter at all. The eight conditions themselves belong to
    /// `price-source-api` and are evaluated by the same function the mock calls, so the matrix that
    /// drives them to `false` through the mock is testing the code that ships here.
    ///
    /// **Returns `false` on any fault, never a panic.** Every arithmetic step inside is checked and
    /// an unreadable feed config is a `false` rather than a trap escaping the vault's constructor.
    /// The vault wraps this call as well, which is belt and braces on purpose.
    fn supports_round(
        env: Env,
        twap_window: u64,
        guard_window: u64,
        oracle_dead_after: u64,
        settle_grace: u64,
        unresolved_after: u64,
        round_span: u64,
    ) -> bool {
        ReflectorAdapter::pay_rent(&env);

        let Ok(res) = ReflectorAdapter::live_resolution(&env) else {
            return false;
        };
        // Condition 7's input, fetched only when a span is given: `validate_params` passes 0 and
        // skips the condition, so that a sponsorship shortfall can never block the very
        // `set_epoch_params` call that would repair it (D-68).
        let expires = if round_span == 0 {
            None
        } else {
            let (Ok(feed), Ok(asset)) =
                (ReflectorAdapter::feed(&env), ReflectorAdapter::asset(&env))
            else {
                return false;
            };
            match feed.try_expires(&asset) {
                Ok(Ok(e)) => e,
                _ => return false,
            }
        };

        api::supports_round(
            res,
            twap_window,
            guard_window,
            oracle_dead_after,
            settle_grace,
            unresolved_after,
            round_span,
            expires,
            env.ledger().timestamp(),
        )
    }
}

#[cfg(test)]
mod test_adapter;
