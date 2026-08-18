#![no_std]
//! `MockPriceSource` — a `PriceSource` whose every input is settable, so that every guard in the
//! oracle seam can be **forced** rather than waited for.
//!
//! `04-ORACLE.md` §2 and §6 are the single home for what this has to be able to do; `DEV2.md` §2.1
//! is the checklist. Two rules shape the whole file:
//!
//! **1. There is no reject switch on `supports_round`.** It evaluates all eight conditions from the
//! settable primitives, through the *same* function the real adapter calls
//! (`price_source_api::supports_round`). A boolean "fail now" flag would prove the vault handles
//! `false`, not that it handles the conditions — and it would keep passing even if condition 3's
//! strictness or condition 6 were deleted from the code. A settable `resolution()` is what makes
//! conditions 4 and 7 reachable at all.
//!
//! **2. The trap switch is not an exception to that.** It makes the *call* fail; it does not make
//! the conditions evaluate differently (O-13e). It is the only way to exercise the vault's
//! recoverable wrappers, and without it the rule in `04-ORACLE.md` §3b has no regression test.
//!
//! This contract is also deployed for real on fast-test instances (`09-DEPLOYMENT.md` §2 step 2),
//! which is why its setters are admin-gated rather than open. Such deployments are economically
//! meaningless by construction and are labelled so: they prove mechanism, never demand.

use price_source_api::{self as api, AdapterError, PriceSource, ReadResult, Sample};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Map, Vec,
};

/// What the next `reading()` should do, regardless of what the records say.
///
/// `ForceUnusable` and `ForceOutOfReach` exist because `06-TEST-PLAN.md`'s I10 grid says *"drive
/// every outcome from `MockPriceSource`"*, and two of the four `GuardOutcome` values are otherwise
/// only reachable by arranging records just so — i.e. by luck. `ForceBadConfig` is here so the
/// routing rule's third row can be forced without having to pick a resolution that violates one
/// specific window.
#[contracttype]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Compute honestly from the records. The default.
    Normal,
    /// Answer `Ok(Unusable)` — a fact about the window, which routes to the void branch.
    ForceUnusable,
    /// Answer `Ok(OutOfReach)` — a fact about now, which routes to the unresolved branch.
    ForceOutOfReach,
    /// Answer `Err(BadConfig)` — a live-configuration fault, which routes to `Transient`.
    ForceBadConfig,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum MockError {
    NotInitialized = 1,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    Resolution,
    Decimals,
    Expires,
    Collapse,
    Mode,
    Trap,
    Records,
}

#[contract]
pub struct MockPriceSource;

// =================================================================================================
// Construction and the settable primitives
// =================================================================================================

#[contractimpl]
impl MockPriceSource {
    /// `decimals` is given because the scale is what the vault pins per round; `resolution()`
    /// defaults to **1 second** and that default is normative rather than incidental.
    /// `02-CONTRACT-SPEC.md` §1's definition of a fast-test profile rests on it — at Reflector's
    /// 300-second tick, condition 1 alone forces `twap_window ≥ 600`, so a second-scale profile
    /// against the real feed cannot be constructed at all. Changing this number changes which
    /// fast-test profiles are admissible.
    pub fn __constructor(env: Env, admin: Address, decimals: u32) {
        let s = env.storage().instance();
        s.set(&Key::Admin, &admin);
        s.set(&Key::Resolution, &1u32);
        s.set(&Key::Decimals, &decimals);
        s.set(&Key::Expires, &None::<u64>);
        s.set(&Key::Collapse, &u32::MAX);
        s.set(&Key::Mode, &Mode::Normal);
        s.set(&Key::Trap, &false);
        s.set(&Key::Records, &Map::<u64, (i128, u64)>::new(&env));
    }

    pub fn set_resolution(env: Env, seconds: u32) {
        Self::auth(&env);
        env.storage().instance().set(&Key::Resolution, &seconds);
    }

    pub fn set_decimals(env: Env, decimals: u32) {
        Self::auth(&env);
        env.storage().instance().set(&Key::Decimals, &decimals);
    }

    /// A record whose reported timestamp *is* its slot — the ordinary case.
    pub fn set_price(env: Env, at: u64, price: i128) {
        Self::set_price_stamped(env, at, price, at);
    }

    /// A record whose reported timestamp differs from the slot it answers for.
    ///
    /// This is what makes O-4b constructible — timestamp skew, ordering shuffles, out-of-range
    /// stamps. Without it there is no way to ask what happens when the feed answers with evidence
    /// about a *different* moment than the one requested, and rule 2's window filter has no test.
    pub fn set_price_stamped(env: Env, at: u64, price: i128, reported_ts: u64) {
        Self::auth(&env);
        let mut records = Self::records(&env);
        records.set(at, (price, reported_ts));
        env.storage().instance().set(&Key::Records, &records);
    }

    /// Remove one grid point — the way a single-tick gap is made.
    pub fn clear_price(env: Env, at: u64) {
        Self::auth(&env);
        let mut records = Self::records(&env);
        records.remove(at);
        env.storage().instance().set(&Key::Records, &records);
    }

    /// Populate a healthy, gapless grid — `count` ticks ending at `end`, all at `price`.
    ///
    /// Convenience, not policy: every test that wants a *sick* feed starts from a healthy one and
    /// removes exactly what it is testing, which is what keeps a failing assertion pointing at one
    /// cause.
    pub fn fill(env: Env, end: u64, count: u32, price: i128) {
        Self::auth(&env);
        let res = u64::from(Self::resolution(env.clone()));
        // Snap to a tick boundary, because that is where a real feed's records sit and where
        // `reading()` will look: the grid derives `end` as `end − (end mod res)` (04-ORACLE §2
        // rule 0). Filling at an unaligned `end` would produce a feed whose every record misses the
        // grid by a constant offset — a gapless feed that reads as totally dead, which is a
        // confusing way for a test to fail and says nothing about the code under test.
        let end = end.saturating_sub(end.checked_rem(res).unwrap_or(0));
        let mut records = Self::records(&env);
        for i in 0..count {
            let Some(back) = u64::from(i).checked_mul(res) else {
                break;
            };
            let Some(t) = end.checked_sub(back) else {
                break;
            };
            records.set(t, (price, t));
        }
        env.storage().instance().set(&Key::Records, &records);
    }

    /// `None` is an unsponsored feed, which condition 7 treats as `false`.
    pub fn set_expires(env: Env, at: Option<u64>) {
        Self::auth(&env);
        env.storage().instance().set(&Key::Expires, &at);
    }

    /// Where the batch `prices()` call stops answering. Reflector's own collapse was measured at
    /// 20 records (D-48), long before the retention window.
    pub fn set_prices_collapse(env: Env, records: u32) {
        Self::auth(&env);
        env.storage().instance().set(&Key::Collapse, &records);
    }

    pub fn set_mode(env: Env, mode: Mode) {
        Self::auth(&env);
        env.storage().instance().set(&Key::Mode, &mode);
    }

    /// The trap switch: `reading`, `spot_check` and `supports_round` panic rather than return.
    ///
    /// A genuine host trap, not an error return — and that distinction is the test. The vault's
    /// recoverable wrapper catches a panic, a wrong interface and an archived instance alike, and
    /// it must surface all of them as a typed error rather than let a trap escape its constructor
    /// (O-13e). An error return would assert the easier half.
    pub fn set_trap(env: Env, on: bool) {
        Self::auth(&env);
        env.storage().instance().set(&Key::Trap, &on);
    }

    // ---- Reflector-shaped views, so the mock reads like the thing it stands in for -------------

    pub fn resolution(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Key::Resolution)
            .unwrap_or_else(|| panic_with_error!(&env, MockError::NotInitialized))
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Key::Decimals)
            .unwrap_or_else(|| panic_with_error!(&env, MockError::NotInitialized))
    }

    pub fn expires(env: Env) -> Option<u64> {
        env.storage().instance().get(&Key::Expires).unwrap_or(None)
    }

    /// The newest record's timestamp — the quantity a real feed's reachable depth is measured
    /// against (D-69). Zero when there are no records at all.
    pub fn last_timestamp(env: Env) -> u64 {
        let mut newest = 0u64;
        for (t, _) in Self::records(&env).iter() {
            if t > newest {
                newest = t;
            }
        }
        newest
    }

    pub fn price(env: Env, at: u64) -> Option<i128> {
        Self::records(&env).get(at).map(|(px, _)| px)
    }

    /// The batch call, with its settable collapse point.
    ///
    /// **Nothing in this project reads it.** D-48 removed the batch call from the adapter, the
    /// `PriceSource` trait has no `prices()`, and no row of the O-matrix drives it. It exists so
    /// the mock stays a faithful stand-in for the feed it imitates, and it is recorded as uncovered
    /// here so it is never mistaken for coverage — the same hygiene D-68 applied to conditions 0
    /// and 5.
    pub fn prices(env: Env, records: u32) -> Option<Vec<i128>> {
        if records > Self::collapse(&env) {
            return None;
        }
        let res = u64::from(Self::resolution(env.clone()));
        let end = Self::last_timestamp(env.clone());
        let all = Self::records(&env);
        let mut out = Vec::new(&env);
        for i in 0..records {
            let Some(back) = u64::from(i).checked_mul(res) else {
                break;
            };
            let Some(t) = end.checked_sub(back) else {
                break;
            };
            if let Some((px, _)) = all.get(t) {
                out.push_back(px);
            }
        }
        Some(out)
    }

    // ---- internals ------------------------------------------------------------------------------

    fn auth(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&Key::Admin)
            .unwrap_or_else(|| panic_with_error!(env, MockError::NotInitialized));
        admin.require_auth();
    }

    fn records(env: &Env) -> Map<u64, (i128, u64)> {
        env.storage()
            .instance()
            .get(&Key::Records)
            .unwrap_or_else(|| Map::new(env))
    }

    fn collapse(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&Key::Collapse)
            .unwrap_or(u32::MAX)
    }

    fn mode(env: &Env) -> Mode {
        env.storage()
            .instance()
            .get(&Key::Mode)
            .unwrap_or(Mode::Normal)
    }

    fn maybe_trap(env: &Env) {
        if env.storage().instance().get(&Key::Trap).unwrap_or(false) {
            panic!("MockPriceSource trap switch is on");
        }
    }
}

// =================================================================================================
// The interface under test
// =================================================================================================

#[contractimpl(contracttrait)]
impl PriceSource for MockPriceSource {
    fn reading(
        env: Env,
        anchor: u64,
        short_window: u64,
        guard_window: u64,
    ) -> Result<ReadResult, AdapterError> {
        MockPriceSource::maybe_trap(&env);
        match MockPriceSource::mode(&env) {
            Mode::ForceUnusable => return Ok(ReadResult::Unusable),
            Mode::ForceOutOfReach => return Ok(ReadResult::OutOfReach),
            Mode::ForceBadConfig => return Err(AdapterError::BadConfig),
            Mode::Normal => {}
        }

        let res = u64::from(MockPriceSource::resolution(env.clone()));
        let decimals = MockPriceSource::decimals(env.clone());
        let now = env.ledger().timestamp();

        // Rule 0 then rule 1 — the order is normative, since snapping divides by `res`.
        let (end, points) = api::grid(res, anchor, now, short_window, guard_window)?;

        // Rule 3, before any sampling. Read as "after rule 2", an out-of-reach anchor would first
        // drop every sample and return `Unusable` — the void branch, refunding an out-of-the-money
        // bidder in full for having waited.
        let horizon = now.max(MockPriceSource::last_timestamp(env.clone()));
        if api::out_of_reach(res, guard_window, horizon, end)? {
            return Ok(ReadResult::OutOfReach);
        }

        let records = MockPriceSource::records(&env);
        let mut samples: [Option<Sample>; 7] = [None; 7];
        for (i, slot) in samples.iter_mut().enumerate() {
            let Some(&t) = points.get(i) else { continue };
            *slot = records.get(t).map(|(raw_price, reported_ts)| Sample {
                raw_price,
                reported_ts,
            });
        }

        api::fold(end, &points, &samples, short_window, guard_window, decimals)
    }

    fn spot_check(env: Env, max_staleness: u64, expected_decimals: u32) -> Option<i128> {
        MockPriceSource::maybe_trap(&env);
        let decimals = MockPriceSource::decimals(env.clone());
        // A changed scale makes the tick incomparable with the round's strike, and `spot_check`
        // cannot report the value it used — it returns a bare `Option` — so it takes the expected
        // scale as an argument and refuses on any mismatch (D-68, O-4e).
        if decimals != expected_decimals {
            return None;
        }
        let res = u64::from(MockPriceSource::resolution(env.clone()));
        let now = env.ledger().timestamp();
        let newest = MockPriceSource::last_timestamp(env.clone());
        if newest == 0 {
            return None;
        }
        // One missed tick is tolerated on top of the caller's own budget, and the *source* adds it:
        // resolution is a property of the feed, not of the vault, and the vault must never grow a
        // `resolution` field (D-58).
        let tolerance = res.checked_add(max_staleness)?;
        if now.saturating_sub(newest) > tolerance {
            return None;
        }
        let (raw, _) = MockPriceSource::records(&env).get(newest)?;
        if raw <= 0 {
            return None;
        }
        api::normalize(raw, decimals).filter(|px| *px > 0)
    }

    fn supports_round(
        env: Env,
        twap_window: u64,
        guard_window: u64,
        oracle_dead_after: u64,
        settle_grace: u64,
        unresolved_after: u64,
        round_span: u64,
    ) -> bool {
        MockPriceSource::maybe_trap(&env);
        // The same function the real adapter calls. The mock supplies only its own live
        // `resolution()` and its own `expires()` — which is exactly what keeps condition 7 a fact
        // about this source's feed rather than a flag.
        api::supports_round(
            u64::from(MockPriceSource::resolution(env.clone())),
            twap_window,
            guard_window,
            oracle_dead_after,
            settle_grace,
            unresolved_after,
            round_span,
            MockPriceSource::expires(env.clone()),
            env.ledger().timestamp(),
        )
    }
}

#[cfg(test)]
mod test_mock;
