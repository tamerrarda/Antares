//! The adapter against a settable stand-in for Reflector.
//!
//! **Every failure mode is forced, never waited for** (`04-ORACLE.md` §6). The stand-in below is
//! not the `MockPriceSource` the vault tests against — that one implements `PriceSource`, the
//! interface the adapter *provides*. This one implements the interface the adapter *consumes*, so
//! that the adapter's own arithmetic and, more importantly, its **classification** can be driven.
//!
//! The classification is what these tests are really about. Three sources of failure exist and
//! they pay different parties, so misfiling one is a transfer of money:
//!
//! | fault about… | class | who pays |
//! |---|---|---|
//! | records inside the window | `Ok(Unusable)` → void | depositors gain nothing; bidder refunded |
//! | the anchor being older than the feed serves | `Ok(OutOfReach)` → unresolved | bidder gets nothing |
//! | the feed's live config or reachability | `Err(_)` → `Transient` | nobody; retry |
//!
//! Rows O-15, O-16 and O-16b exist because the third row keeps being filed as the first, and that
//! mistake annuls a round on a **healthy feed**.

use crate::reflector::{Asset, PriceData};
use crate::ReflectorAdapter;
use price_source_api::{PriceSourceClient, ReadResult};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, testutils::Ledger as _, Address, Env, Map,
    Symbol,
};

// =================================================================================================
// A settable stand-in for Reflector
// =================================================================================================

#[contracttype]
#[derive(Clone)]
enum K {
    Res,
    Dec,
    Last,
    Expires,
    Records,
    /// When on, every call traps — the only way to exercise the adapter's own `try_` wrappers.
    Trap,
}

#[contract]
pub struct MockReflector;

#[contractimpl]
impl MockReflector {
    pub fn __constructor(env: Env, resolution: u32, decimals: u32) {
        let s = env.storage().instance();
        s.set(&K::Res, &resolution);
        s.set(&K::Dec, &decimals);
        s.set(&K::Last, &0u64);
        s.set(&K::Expires, &None::<u64>);
        s.set(&K::Records, &Map::<u64, PriceData>::new(&env));
        s.set(&K::Trap, &false);
    }

    pub fn set_resolution(env: Env, v: u32) {
        env.storage().instance().set(&K::Res, &v);
    }
    pub fn set_decimals(env: Env, v: u32) {
        env.storage().instance().set(&K::Dec, &v);
    }
    pub fn set_last(env: Env, v: u64) {
        env.storage().instance().set(&K::Last, &v);
    }
    pub fn set_expires(env: Env, v: Option<u64>) {
        env.storage().instance().set(&K::Expires, &v);
    }
    pub fn set_trap(env: Env, on: bool) {
        env.storage().instance().set(&K::Trap, &on);
    }

    /// A record at a slot, reporting a timestamp that need not equal that slot — which is what
    /// makes the out-of-window case constructible at all.
    pub fn put(env: Env, at: u64, price: i128, reported_ts: u64) {
        let mut r: Map<u64, PriceData> = env.storage().instance().get(&K::Records).unwrap();
        r.set(
            at,
            PriceData {
                price,
                timestamp: reported_ts,
            },
        );
        env.storage().instance().set(&K::Records, &r);
    }

    pub fn remove(env: Env, at: u64) {
        let mut r: Map<u64, PriceData> = env.storage().instance().get(&K::Records).unwrap();
        r.remove(at);
        env.storage().instance().set(&K::Records, &r);
    }

    /// A gapless grid of `count` ticks ending at `end`, all at `price`, with `last_timestamp` set
    /// to match. Tests that want a sick feed start here and remove exactly what they are testing.
    pub fn fill(env: Env, end: u64, count: u32, price: i128) {
        let res: u32 = env.storage().instance().get(&K::Res).unwrap();
        let res = u64::from(res);
        let end = end - end % res;
        let mut r: Map<u64, PriceData> = env.storage().instance().get(&K::Records).unwrap();
        for i in 0..count {
            let t = end - u64::from(i) * res;
            r.set(
                t,
                PriceData {
                    price,
                    timestamp: t,
                },
            );
        }
        env.storage().instance().set(&K::Records, &r);
        env.storage().instance().set(&K::Last, &end);
    }

    fn guard(env: &Env) {
        if env.storage().instance().get(&K::Trap).unwrap_or(false) {
            panic!("MockReflector trap switch is on");
        }
    }

    // ---- the surface the adapter consumes ----------------------------------------------------

    pub fn resolution(env: Env) -> u32 {
        Self::guard(&env);
        env.storage().instance().get(&K::Res).unwrap()
    }
    pub fn decimals(env: Env) -> u32 {
        Self::guard(&env);
        env.storage().instance().get(&K::Dec).unwrap()
    }
    pub fn last_timestamp(env: Env) -> u64 {
        Self::guard(&env);
        env.storage().instance().get(&K::Last).unwrap()
    }
    pub fn expires(env: Env, _asset: Asset) -> Option<u64> {
        Self::guard(&env);
        env.storage().instance().get(&K::Expires).unwrap_or(None)
    }
    pub fn price(env: Env, _asset: Asset, timestamp: u64) -> Option<PriceData> {
        Self::guard(&env);
        let r: Map<u64, PriceData> = env.storage().instance().get(&K::Records).unwrap();
        r.get(timestamp)
    }
    pub fn lastprice(env: Env, _asset: Asset) -> Option<PriceData> {
        Self::guard(&env);
        let last: u64 = env.storage().instance().get(&K::Last).unwrap();
        let r: Map<u64, PriceData> = env.storage().instance().get(&K::Records).unwrap();
        r.get(last)
    }
}

// =================================================================================================
// Fixture
// =================================================================================================

const RES: u32 = 300;
const DEC: u32 = 14;
/// A multiple of the shipped tick, so no assertion below carries a snapping offset.
const NOW: u64 = 1_786_999_800;
/// 0.16 USD at `decimals = 14`.
const PX: i128 = 16_000_000_000_000;
const TW: u64 = 900;
const GW: u64 = 3_600;

struct F<'a> {
    env: Env,
    feed: MockReflectorClient<'a>,
    adapter: PriceSourceClient<'a>,
    adapter_id: Address,
}

fn setup() -> F<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let feed_id = env.register(MockReflector, (RES, DEC));
    let adapter_id = env.register(ReflectorAdapter, (feed_id.clone(), symbol_short!("XLM")));
    F {
        feed: MockReflectorClient::new(&env, &feed_id),
        adapter: PriceSourceClient::new(&env, &adapter_id),
        adapter_id,
        env,
    }
}

// =================================================================================================
// The happy path, and what "derived" means
// =================================================================================================

#[test]
fn a_healthy_feed_produces_both_medians_normalized_from_the_live_decimals() {
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    let ReadResult::Reading(r) = f.adapter.reading(&NOW, &TW, &GW) else {
        panic!("expected settlement-grade")
    };
    assert_eq!(
        r.short_twap, 1_600_000,
        "14 decimals normalized down to 1e7"
    );
    assert_eq!(r.guard_twap, 1_600_000);
    assert_eq!(r.newest_ts, NOW);
    assert_eq!(
        r.feed_decimals, DEC,
        "the scale travels with the price so the vault can pin it"
    );
}

#[test]
fn the_grid_is_derived_from_the_live_resolution_and_follows_it() {
    // O-14, and the whole of D-58 and D-64: no constant in this adapter survives a tick change.
    // The feed here answers only on the 60-second grid, so a read that still sampled the
    // 300-second one would find nothing at all.
    let f = setup();
    f.feed.set_resolution(&60);
    f.feed.fill(&NOW, &80, &PX);
    assert!(
        matches!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::Reading(_)),
        "a hardcoded 300 s grid would miss every point on a 60 s feed"
    );

    // And the reachable depth moves with it. At res = 60, R = 255*60 = 15 300 and
    // reach_limit = 15 300 - 3 600 = 11 700 — a fifth of what it is at the shipped tick.
    f.env.ledger().set_timestamp(NOW + 11_700);
    assert!(
        matches!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::Reading(_)),
        "at the limit"
    );
    f.env.ledger().set_timestamp(NOW + 11_701);
    assert_eq!(
        f.adapter.reading(&NOW, &TW, &GW),
        ReadResult::OutOfReach,
        "one second past it — a stale 20 h 15 m constant would have kept sampling"
    );
}

// =================================================================================================
// Reach — the difference between "no records" and "we waited too long"
// =================================================================================================

#[test]
fn an_aged_out_anchor_is_out_of_reach_and_never_unusable() {
    // O-12, the regression test for the eighteen-hour free option. The records are *present* here.
    // An implementation that sampled before checking reach would drop all seven — they are past
    // the cap and the feed refuses them — and return `Unusable`, which is the void branch: the
    // out-of-the-money bidder gets his whole premium back for having simply waited. Rule 3 runs
    // before any sampling, which is the only reason the answer is `OutOfReach` instead.
    let f = setup();
    // Twenty records, not two hundred and sixty. The adapter reads **seven points regardless of
    // how old the anchor is** — that constancy is what D-64's residual rests on — so depth of
    // history is irrelevant here; only the passage of `now` is. Filling 260 entries in one call
    // exceeds the host budget, which is the mock's problem and never the adapter's, and it is worth
    // saying which: this test would be measuring the fixture if it needed them.
    f.feed.fill(&NOW, &20, &PX);
    let reach_limit = 255 * u64::from(RES) - GW; // 72 900 (D-69)
    assert_eq!(reach_limit, 72_900);

    f.env.ledger().set_timestamp(NOW + reach_limit);
    assert!(matches!(
        f.adapter.reading(&NOW, &TW, &GW),
        ReadResult::Reading(_)
    ));
    f.env.ledger().set_timestamp(NOW + reach_limit + 1);
    assert_eq!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::OutOfReach);
}

#[test]
fn the_horizon_is_the_larger_of_now_and_the_feeds_own_last_timestamp() {
    // D-69's second half. Reflector's cap is measured from `last_timestamp`, and its own source
    // carries an explicit branch for that value running *ahead* of the ledger clock. Measured from
    // `now` alone, an anchor the feed will refuse looks reachable — the samples come back `None`,
    // the count collapses, and a healthy feed produces `Unusable`, i.e. a void. Taking the larger
    // of the two is never wrong in that direction.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    let reach_limit = 255 * u64::from(RES) - GW;

    f.env.ledger().set_timestamp(NOW + reach_limit);
    assert!(
        matches!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::Reading(_)),
        "now-based: inside"
    );

    // The feed now claims a newest record one second beyond the ledger clock.
    f.feed.set_last(&(NOW + reach_limit + 1));
    assert_eq!(
        f.adapter.reading(&NOW, &TW, &GW),
        ReadResult::OutOfReach,
        "the feed's own clock is what its cap is measured against"
    );
}

// =================================================================================================
// The routing rule — O-15, O-16: a healthy feed must never be annulled
// =================================================================================================

#[test]
fn every_live_configuration_fault_is_transient_and_never_unusable() {
    // O-16. Each of these is reachable on a **healthy** feed after a Reflector tick change, and
    // filing any of them as `Unusable` annuls the round and refunds the bidder in full. They are
    // facts about *now*: the records are intact, only our ability to derive a grid over them has
    // lapsed, and a feed that re-times itself can re-time itself back.
    let cases: &[(&str, u32, u64, u64)] = &[
        ("res = 0: no tick to snap to", 0, TW, GW),
        (
            "res = 451: the short window cannot hold three ticks",
            451,
            TW,
            GW,
        ),
        ("res = 451 isolated to the guard rule", 451, 1_000, 1_800),
        (
            "res = 14: guard_window >= R, so reach_limit would underflow",
            14,
            TW,
            GW,
        ),
    ];
    for &(why, res, tw, gw) in cases {
        let f = setup();
        f.feed.fill(&NOW, &20, &PX);
        f.feed.set_resolution(&res);
        assert!(f.adapter.try_reading(&NOW, &tw, &gw).is_err(), "{why}");
    }

    // The last one is rule 5's rather than rule 0's: a `decimals` large enough to floor every
    // price to zero is a fact about the feed's configuration, not about its records.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    f.feed.set_decimals(&40);
    assert!(
        f.adapter.try_reading(&NOW, &TW, &GW).is_err(),
        "a scale that zeroes every price"
    );
}

#[test]
fn a_configuration_fault_clears_and_the_round_settles_normally() {
    // The property `Transient` exists to preserve, and the half that makes O-16 more than an
    // assertion about an error code. `Unusable` would have been terminal; this is not.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    f.feed.set_resolution(&451);
    assert!(f.adapter.try_reading(&NOW, &TW, &GW).is_err());

    f.feed.set_resolution(&RES);
    assert!(matches!(
        f.adapter.reading(&NOW, &TW, &GW),
        ReadResult::Reading(_)
    ));
}

#[test]
fn a_failing_feed_call_is_transient_and_never_a_missing_record() {
    // The distinction this test exists for: a call that fails is a fact about **this ledger**, and
    // a record that is absent is a fact about **the window**. Reading the first as the second —
    // treating a failed `price()` as a `None` sample — would drop it into rule 2's count, and
    // enough of them produce `Unusable`, i.e. the void branch, on a feed that is merely
    // unreachable right now. So the call failure propagates instead.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    f.feed.set_trap(&true);
    assert!(
        f.adapter.try_reading(&NOW, &TW, &GW).is_err(),
        "trap must not become Unusable"
    );

    f.feed.set_trap(&false);
    assert!(matches!(
        f.adapter.reading(&NOW, &TW, &GW),
        ReadResult::Reading(_)
    ));
}

// =================================================================================================
// Filtering, normalization and the odd-set medians
// =================================================================================================

#[test]
fn a_single_missing_tick_in_the_short_window_is_unusable() {
    // D-65's cost, and it is a real cost: this used to settle. The measurement that made the trade
    // acceptable is in `deployments/environment-testnet.json` — 100 % tick completeness over
    // 29 h 45 m of the live feed, no gaps at all.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    f.feed.remove(&(NOW - 300));
    assert_eq!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::Unusable);
}

#[test]
fn four_valid_guard_samples_drop_the_furthest_and_match_feeding_those_three() {
    // O-4d. Requiring odd sets removes the tie-break question rather than answering it: there is no
    // even-count case left to round, in Rust or in the Python reference, so the byte-identical
    // vector diff has nothing to disagree about.
    let mut readings = [None, None];
    for (i, drop_extra) in [false, true].iter().enumerate() {
        let f = setup();
        f.feed.fill(&NOW, &20, &PX);
        // Distinct guard values so a median actually has to choose.
        f.feed.put(&(NOW - 900), &(PX * 2), &(NOW - 900));
        f.feed.put(&(NOW - 1_800), &(PX * 3), &(NOW - 1_800));
        f.feed.put(&(NOW - 2_700), &(PX * 4), &(NOW - 2_700));
        f.feed.put(&(NOW - 3_600), &(PX * 5), &(NOW - 3_600));
        f.feed.remove(&(NOW - 2_700)); // guard set {0, 1, 2, 4}×PX -> four values
        if *drop_extra {
            f.feed.remove(&(NOW - 3_600)); // and now three, the furthest gone
        }
        let ReadResult::Reading(r) = f.adapter.reading(&NOW, &TW, &GW) else {
            panic!("reading")
        };
        readings[i] = Some(r.guard_twap);
    }
    assert_eq!(
        readings[0], readings[1],
        "dropping the furthest == never having had it"
    );
}

#[test]
fn a_record_stamped_outside_its_window_is_dropped() {
    // O-4b. The feed's answer is evidence about the moment it *claims*, not about the slot we asked
    // for, and a settlement price must not rest on a record that says it belongs elsewhere.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    assert!(matches!(
        f.adapter.reading(&NOW, &TW, &GW),
        ReadResult::Reading(_)
    ));
    f.feed.put(&(NOW - 300), &PX, &(NOW + 300));
    assert_eq!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::Unusable);
}

#[test]
fn a_non_positive_record_is_dropped_as_a_record_fault() {
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    f.feed.put(&(NOW - 600), &0, &(NOW - 600));
    assert_eq!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::Unusable);
}

#[test]
fn one_price_that_normalizes_to_zero_is_an_ordinary_bad_print() {
    // An earlier draft escalated a *single* zeroing sample to a whole-read config fault, which
    // handed one malformed tick the power to push a round to `Unresolved` and burn an
    // in-the-money bidder's payout — the precise outlier sensitivity D-42 chose a median to remove.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    f.feed.put(&(NOW - 2_700), &1, &(NOW - 2_700)); // normalizes to 0 at 14 decimals
    assert!(
        matches!(f.adapter.reading(&NOW, &TW, &GW), ReadResult::Reading(_)),
        "dropped like any other bad print, not escalated"
    );
}

#[test]
fn normalization_follows_the_live_decimals_in_both_directions() {
    for (decimals, raw, expected) in [
        (14u32, PX, 1_600_000i128),
        (7, 1_600_000, 1_600_000),
        (4, 1_600, 1_600_000),
    ] {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(NOW);
        let feed_id = env.register(MockReflector, (RES, decimals));
        let feed = MockReflectorClient::new(&env, &feed_id);
        feed.fill(&NOW, &20, &raw);
        let adapter_id = env.register(ReflectorAdapter, (feed_id.clone(), symbol_short!("XLM")));
        let adapter = PriceSourceClient::new(&env, &adapter_id);
        let ReadResult::Reading(r) = adapter.reading(&NOW, &TW, &GW) else {
            panic!("reading")
        };
        assert_eq!(r.short_twap, expected, "decimals = {decimals}");
        assert_eq!(r.feed_decimals, decimals);
    }
}

// =================================================================================================
// spot_check
// =================================================================================================

#[test]
fn spot_check_refuses_a_scale_that_is_not_the_one_the_round_was_opened_under() {
    // O-4e. A rescaled tick compared against the round's strike accepts or rejects a bid on a price
    // wrong by a factor of ten.
    let f = setup();
    f.feed.fill(&NOW, &5, &PX);
    assert_eq!(f.adapter.spot_check(&600, &DEC), Some(1_600_000));
    assert_eq!(f.adapter.spot_check(&600, &(DEC + 1)), None);
    f.feed.set_decimals(&(DEC + 1));
    assert_eq!(
        f.adapter.spot_check(&600, &DEC),
        None,
        "detected from either side"
    );
}

#[test]
fn spot_check_tolerates_the_callers_budget_plus_exactly_one_feed_tick() {
    // The tick is added by the *adapter*, because resolution is a property of the feed and the
    // vault has no `resolution` field and must never grow one (D-58).
    let f = setup();
    f.feed.fill(&NOW, &5, &PX);
    f.env.ledger().set_timestamp(NOW + 600 + u64::from(RES));
    assert_eq!(f.adapter.spot_check(&600, &DEC), Some(1_600_000));
    f.env.ledger().set_timestamp(NOW + 600 + u64::from(RES) + 1);
    assert_eq!(f.adapter.spot_check(&600, &DEC), None);
}

#[test]
fn spot_check_answers_none_rather_than_failing_when_the_feed_does() {
    // Every failure here is `None`, which the vault routes to `OracleUnreachable` — never to
    // `InTheMoney`. The keeper counts those two separately, and only genuine no-bid epochs advance
    // the stop gate, so conflating them would corrupt the one measurement the project's own
    // continuation depends on.
    let f = setup();
    f.feed.fill(&NOW, &5, &PX);
    f.feed.set_trap(&true);
    assert_eq!(f.adapter.spot_check(&600, &DEC), None);
}

// =================================================================================================
// supports_round — answered from the live feed, not from a stored copy
// =================================================================================================

#[test]
fn supports_round_tracks_the_live_resolution() {
    // The same band `verify-environment.ts` computes independently from the live feed, and the same
    // one `price-source-api`'s unit tests assert: three derivations, one answer.
    let f = setup();
    let ask = |res: u32| {
        f.feed.set_resolution(&res);
        f.adapter
            .supports_round(&TW, &GW, &43_200, &7_200, &75_600, &0)
    };
    assert!(!ask(282));
    assert!(ask(283));
    assert!(ask(300));
    assert!(ask(310));
    assert!(!ask(311));
}

#[test]
fn condition_7_reads_the_feeds_own_expiry_and_only_when_a_span_is_given() {
    // O-13f. A sponsorship lapse *deletes records that existed at expiry*, so an anchored read
    // afterwards finds an empty window and returns `Unusable` — the void branch — on a feed that
    // was perfectly healthy when the option was written. `expires()` is public, so left unguarded
    // this is D-59's free option returning through a different door.
    let f = setup();
    let span: u64 = 604_800 + 75_600;
    let ask = |round_span: u64| {
        f.adapter
            .supports_round(&TW, &GW, &43_200, &7_200, &75_600, &round_span)
    };

    assert!(
        ask(0),
        "validate_params passes 0 and skips it, so a shortfall cannot block its repair"
    );
    assert!(!ask(span), "a None expiry is an unfunded feed");
    f.feed.set_expires(&Some(NOW + span));
    assert!(
        !ask(span),
        "an expiry exactly at the deadline is not strictly beyond it"
    );
    f.feed.set_expires(&Some(NOW + span + 1));
    assert!(ask(span));
    f.feed.set_expires(&Some(NOW + 43_200 + 1));
    assert!(
        !ask(span),
        "funded past the dead window but not past the round"
    );
}

#[test]
fn supports_round_returns_false_rather_than_trapping_when_the_feed_does() {
    // O-13e's adapter half. This is called from the vault's constructor: a trap escaping here
    // arrives as a host trap rather than `InvalidParams`, and the vault cannot be registered at
    // all. The vault wraps the call too — belt and braces, deliberately.
    let f = setup();
    f.feed.set_trap(&true);
    assert!(!f
        .adapter
        .supports_round(&TW, &GW, &43_200, &7_200, &75_600, &0));
}

// =================================================================================================
// The contract holds no power of its own
// =================================================================================================

#[test]
fn the_adapter_has_no_state_a_caller_can_change() {
    // The immutability rule, asserted where it can be: after every kind of call, the pinned feed
    // and asset are what the constructor set. The *exported surface* — no admin, no upgrade, no
    // setter — cannot be checked from inside a test and is asserted against the built wasm by the
    // deploy script (09-DEPLOYMENT §2 step 2), which is the only place it can be checked honestly.
    let f = setup();
    f.feed.fill(&NOW, &20, &PX);
    let _ = f.adapter.reading(&NOW, &TW, &GW);
    let _ = f.adapter.spot_check(&600, &DEC);
    let _ = f
        .adapter
        .supports_round(&TW, &GW, &43_200, &7_200, &75_600, &0);

    let (feed_stored, asset_stored) = f.env.as_contract(&f.adapter_id, || {
        let s = f.env.storage().instance();
        (
            s.get::<crate::Key, Address>(&crate::Key::Feed).unwrap(),
            s.get::<crate::Key, Symbol>(&crate::Key::Asset).unwrap(),
        )
    });
    assert_eq!(asset_stored, symbol_short!("XLM"));
    assert_eq!(
        MockReflectorClient::new(&f.env, &feed_stored).resolution(),
        RES
    );
}
