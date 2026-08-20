//! §2.7's unit inventory — the curve, `bid`, and I2.
//!
//! `06-TEST-PLAN.md` §2's auction entry is the list this implements, and
//! `DEV-PROTOCOL.md` §6 is the bar: **every guard has a test that drives it to
//! reject.** A guard with only a happy-path test is untested, and two of this
//! project's own gates shipped green because nothing had exercised the rejecting
//! direction.
//!
//! Two rules from §10 bind every rejection here, not just the fills: **a
//! rejection emits nothing**, asserted rather than assumed; and the events that
//! do fire carry §10's exact field set.
//!
//! Built on `test_common::open_round_manually`, which writes `State` directly
//! because `open_epoch` is DEV2's and lands with IP-2. Everything here is
//! re-run against the real opener when it exists — DEV1 recorded that caveat for
//! their own tests and it applies identically to mine.

extern crate std;

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{xdr, Address};

use crate::auction::premium_bps;
use crate::errors::Error;
use crate::test_common::{deploy_at, valid_params, Deployed};
use crate::types::{EpochParams, Phase, State, BPS};

// One XLM, and one share.
const XLM: i128 = 10_000_000;

// The mock is registered at 14 decimals (`test_common::deploy`), which is
// Reflector's live value. `spot_check` normalizes to 1e7 before returning, so a
// price fed at 14 decimals comes back as stroops-per-XLM and is directly
// comparable with `State.strike`.
const FEED_DECIMALS: u32 = 14;

fn at_feed_scale(stroops_1e7: i128) -> i128 {
    // 1e7 -> 1e14
    stroops_1e7 * 10_000_000
}

/// A live auction with a strike and a scale, which `open_round_manually` does not
/// set.
///
/// Deliberately a local helper rather than three more arguments on
/// `test_common`'s: that fixture is DEV1's and is called from four of their test
/// files, so widening its signature would churn all of them to serve one module.
struct Auction {
    f: Deployed,
    opened_at: u64,
    strike: i128,
}

/// A clock that is not zero, because the mock cannot tell a record stamped at 0
/// from no records at all — see `test_common::deploy_at`.
const NOW: u64 = 1_800_000_000;

fn live_auction(offered: i128, params: EpochParams) -> Auction {
    // `allowlist_expires_at = 0` leaves D-63's gate inert, which is what every test
    // that is not about the allowlist wants.
    build(deploy_at(NOW, 0), offered, params)
}

/// The same, with D-63's gate actually live for the length of the round.
fn live_auction_with_allowlist(offered: i128, params: EpochParams) -> Auction {
    build(deploy_at(NOW, NOW + 30 * 24 * 60 * 60), offered, params)
}

fn build(f: Deployed, offered: i128, params: EpochParams) -> Auction {
    // The clock is set by `deploy_at`, before registration — `deploy()`'s own path
    // is untouched, so none of DEV1's 116 committed snapshots move. That matters
    // beyond tidiness: 06-TEST-PLAN §8 commits snapshots so a behavioural diff is
    // visible in review, and churn of that size hides the next real change.
    // A depositor, so the vault has something to offer. Idle at genesis, so this
    // mints instantly.
    let depositor = f.user(offered);
    f.client().deposit(&depositor, &offered);

    let opened_at = f.env.ledger().timestamp();
    let auction_end = opened_at + params.auction_duration;
    f.open_round_manually(1, Phase::Auction, auction_end);

    // The strike is 3 % OTM of a 0.40 TWAP at the shipped `strike_bps_otm`; the
    // exact figure does not matter, only that spot can sit either side of it.
    let strike = 4_120_000; // 0.4120000

    f.env.as_contract(&f.vault, || {
        let mut st = crate::storage::get_state(&f.env).unwrap();
        st.params = params.clone();
        st.strike = strike;
        st.open_twap = 4_000_000;
        st.feed_decimals = FEED_DECIMALS;
        st.notional_offered = offered;
        st.locked_at_open = offered;
        crate::storage::set_state(&f.env, &st);
    });

    // A fresh tick just below the strike, so the ITM guard passes by default and
    // every test that is not about the guard does not have to think about it.
    set_spot(&f, strike - 1);

    Auction {
        f,
        opened_at,
        strike,
    }
}

fn allow(f: &Deployed, who: &Address) {
    f.env.as_contract(&f.vault, || {
        let config = crate::storage::get_config(&f.env).unwrap();
        let rent = crate::storage::Rent::effective(&f.env, &config);
        crate::storage::set_allowed(&f.env, rent, who, true);
    });
}

fn set_spot(f: &Deployed, spot_stroops: i128) {
    let mock = mock_price_source::MockPriceSourceClient::new(&f.env, &f.oracle);
    mock.set_price(&f.env.ledger().timestamp(), &at_feed_scale(spot_stroops));
}

impl Auction {
    fn bid(&self, who: &Address, notional: i128, max_bps: u32) -> Result<i128, Error> {
        self.f
            .client()
            .try_bid(who, &notional, &max_bps)
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    }

    fn bidder(&self, funded: i128) -> Address {
        self.f.user(funded)
    }

    fn state(&self) -> State {
        self.f.state()
    }

    /// Move to `opened_at + offset` and refresh the feed tick so staleness is
    /// never the thing under test by accident.
    fn at(&self, offset: u64) {
        self.f.env.ledger().set_timestamp(self.opened_at + offset);
        set_spot(&self.f, self.strike - 1);
    }
}

// -------------------------------------------------------------------------------
// §10 assertions on the raw XDR
//
// `events().all()` hands back `xdr::ContractEvent`, so a real ABI assertion has to
// go through `ScVal`. Worth the few lines rather than counting events: §10 is a
// **frozen** interface and a field renamed or dropped is exactly what an
// events-only indexer cannot recover from, while a length check passes through it.
// Reused by `claims.rs`'s three events.
// -------------------------------------------------------------------------------

fn event_parts(e: &xdr::ContractEvent) -> (std::vec::Vec<xdr::ScVal>, xdr::ScVal) {
    match &e.body {
        xdr::ContractEventBody::V0(v0) => (v0.topics.to_vec(), v0.data.clone()),
    }
}

fn expect_symbol(v: &xdr::ScVal, want: &str) {
    match v {
        xdr::ScVal::Symbol(s) => assert_eq!(
            std::str::from_utf8(s.0.as_slice()).unwrap(),
            want,
            "the event name and field names are ABI; a rename is a breaking change"
        ),
        other => panic!("expected a symbol, got {other:?}"),
    }
}

fn expect_u32(v: &xdr::ScVal, want: u32) {
    match v {
        xdr::ScVal::U32(n) => assert_eq!(*n, want),
        other => panic!("expected u32, got {other:?}"),
    }
}

/// The `i128` a stroop amount must be encoded as — never `u64`, never a float.
fn expect_i128(v: &xdr::ScVal, want: i128) {
    match v {
        xdr::ScVal::I128(parts) => {
            let got = ((parts.hi as i128) << 64) | (parts.lo as i128);
            assert_eq!(got, want);
        }
        other => panic!("expected i128, got {other:?}"),
    }
}

/// The data map's fields, checked by name and by value.
///
/// **In encoded order, which is sorted by field name and not §10's declaration
/// order.** `#[contractevent]` data is an `ScMap`, and an `ScMap` is ordered by
/// key — so the wire order for `bid_filled` is `notional`,
/// `notional_sold_after`, `premium`, `premium_bps`, while §10 lists them
/// declaration-first. Worth pinning rather than working around: an indexer reads
/// by key and does not care, but a test that assumed declaration order would fail
/// on correct code, and the next person would "fix" the event.
fn expect_data_fields(data: &xdr::ScVal, want: &[(&str, Field)]) {
    let entries = match data {
        xdr::ScVal::Map(Some(m)) => m.0.to_vec(),
        other => panic!("event data must be a map keyed by field name, got {other:?}"),
    };
    assert_eq!(entries.len(), want.len(), "§10 fixes the field count");
    for (entry, (name, expected)) in entries.iter().zip(want.iter()) {
        expect_symbol(&entry.key, name);
        match expected {
            Field::I128(v) => expect_i128(&entry.val, *v),
            Field::U32(v) => expect_u32(&entry.val, *v),
        }
    }
}

enum Field {
    I128(i128),
    U32(u32),
}

// =================================================================================================
// The curve — D-03, 05 §1
// =================================================================================================

fn curve_state(params: EpochParams, opened_at: u64, phase: Phase) -> State {
    let f = deploy_at(NOW, 0);
    let mut st = f
        .env
        .as_contract(&f.vault, || crate::storage::get_state(&f.env).unwrap());
    st.params = params.clone();
    st.opened_at = opened_at;
    st.auction_end = opened_at + params.auction_duration;
    st.phase = phase;
    st
}

#[test]
fn the_curve_starts_at_start_and_reaches_exactly_floor_at_auction_end() {
    let p = valid_params();
    let st = curve_state(p.clone(), 1_000, Phase::Auction);

    assert_eq!(premium_bps(&st, 1_000), p.premium_start_bps, "at t0");
    // 05 §1: "hits exactly `floor` at `auction_end`". It is computed here from
    // one second inside the window and from the endpoint separately, because the
    // endpoint itself is outside the window (see the next test) and the two
    // claims are different: the arithmetic reaches floor, the window excludes it.
    let one_before = premium_bps(&st, st.auction_end - 1);
    assert!(
        one_before >= p.premium_floor_bps && one_before <= p.premium_floor_bps + 5,
        "the last admissible second sits at or just above the floor, got {one_before}"
    );
}

#[test]
fn the_curve_is_monotonically_non_increasing_across_the_whole_window() {
    let p = valid_params();
    let st = curve_state(p.clone(), 1_000, Phase::Auction);
    let mut previous = u32::MAX;
    for t in 1_000..st.auction_end {
        let v = premium_bps(&st, t);
        assert!(v <= previous, "curve rose at t={t}: {v} > {previous}");
        assert!(
            v >= p.premium_floor_bps,
            "curve fell below the floor at t={t}"
        );
        assert!(v <= p.premium_start_bps, "curve rose above start at t={t}");
        previous = v;
    }
}

#[test]
fn the_curve_floors_the_subtracted_term_which_rounds_in_the_vaults_favour() {
    // §6's rounding table: `p = start − ⌊(start−floor)·e/d⌋`, so flooring what is
    // taken away makes `p` slightly *higher*. The other spelling,
    // `⌊start − (start−floor)·e/d⌋`, would hand the bp to the bidder. A duration
    // that does not divide the span is what makes the two disagree at all.
    let mut p = valid_params();
    p.premium_start_bps = 300;
    p.premium_floor_bps = 10;
    p.auction_duration = 7; // 290 / 7 is not an integer
    let st = curve_state(p, 0, Phase::Auction);

    // e=1: 290*1/7 = 41.43 -> floor 41 -> p = 259. The other form would give
    // floor(300 - 41.43) = 258.
    assert_eq!(premium_bps(&st, 1), 259);
}

#[test]
fn the_curve_reads_zero_outside_the_window_and_at_its_closing_instant() {
    let p = valid_params();
    let st = curve_state(p.clone(), 1_000, Phase::Auction);

    assert_eq!(premium_bps(&st, 999), 0, "before opened_at");
    assert_ne!(
        premium_bps(&st, st.auction_end - 1),
        0,
        "last admissible second"
    );

    // **The boundary the two spec clauses collide at.** §12 says the field is
    // "the curve evaluated at now; 0 outside the auction window"; 05 §1 says the
    // curve "hits exactly floor at auction_end"; §16 makes `bid` require
    // `now < auction_end` strictly. The window rule decides it: no bid is
    // admissible at that instant, so the answer is 0 and not `floor`.
    assert_eq!(premium_bps(&st, st.auction_end), 0, "at auction_end");
    assert_eq!(premium_bps(&st, st.auction_end + 1_000), 0, "well past it");

    // Sold out early: 05 §1 — "the decay curve stops mattering at that instant".
    let active = curve_state(valid_params(), 1_000, Phase::Active);
    assert_eq!(premium_bps(&active, 1_050), 0, "Active");
    let idle = curve_state(valid_params(), 1_000, Phase::Idle);
    assert_eq!(premium_bps(&idle, 1_050), 0, "Idle");
}

#[test]
fn the_curve_reads_the_snapshot_so_a_mid_auction_setter_cannot_move_a_live_bidders_terms() {
    // §15. The whole reason `premium_bps` takes `&State`: a signature accepting a
    // bare `&EpochParams` would let a caller pass `Config.params` and compile.
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(50);
    let before = premium_bps(&a.state(), a.f.env.ledger().timestamp());

    let mut changed = valid_params();
    changed.premium_start_bps = 900;
    changed.premium_floor_bps = 800;
    a.f.client().set_epoch_params(&changed);

    let after = premium_bps(&a.state(), a.f.env.ledger().timestamp());
    assert_eq!(before, after, "the live round's terms must not move");
}

// =================================================================================================
// `epoch().current_premium_bps` — the Phase-4 gate checkbox, DEV1's view and my curve
// =================================================================================================

#[test]
fn the_view_reports_the_curve_inside_the_window_and_zero_at_its_boundary() {
    let a = live_auction(1_000 * XLM, valid_params());

    for offset in [0u64, 1, 25, 50, 99] {
        a.at(offset);
        let now = a.f.env.ledger().timestamp();
        assert_eq!(
            a.f.client().epoch().current_premium_bps,
            premium_bps(&a.state(), now),
            "the view must call the curve, at offset {offset}"
        );
    }

    // The boundary, again through the view — this is the value a UI countdown
    // renders, and DEV3.md records this anchor being written backwards twice.
    a.at(valid_params().auction_duration);
    assert_eq!(
        a.f.client().epoch().current_premium_bps,
        0,
        "at auction_end"
    );
}

#[test]
fn the_view_does_not_move_when_the_template_changes_mid_auction() {
    // The identical assertion DEV1 already wrote for `next_open_at`, and the one
    // that catches a `views.rs` reading `Config.params`: the equality check above
    // passes at the moment it is taken even with the wrong copy.
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(50);
    let before = a.f.client().epoch().current_premium_bps;

    let mut changed = valid_params();
    changed.premium_start_bps = 900;
    changed.premium_floor_bps = 800;
    a.f.client().set_epoch_params(&changed);

    assert_eq!(a.f.client().epoch().current_premium_bps, before);
}

// =================================================================================================
// `bid` — the happy paths
// =================================================================================================

#[test]
fn a_fill_moves_the_counters_takes_the_premium_and_emits_bid_filled() {
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    let b = a.bidder(100 * XLM);
    let before = a.f.balance(&b);

    let filled = a.bid(&b, 400 * XLM, BPS as u32).unwrap();
    assert_eq!(filled, 400 * XLM);

    // Captured **immediately**, before any other invocation: `events().all()`
    // reports the last invocation's events rather than a running total (DEV1
    // found this), so a balance read between the bid and this assertion would
    // clear the log and the check would fail on correct code.
    // Scoped to the vault: the premium transfer makes the **SAC** emit its own
    // `transfer` event, so an unfiltered log holds two and neither is wrong. §10
    // is a claim about what the vault emits.
    let all = a.f.env.events().all();
    assert_eq!(
        all.events().len(),
        2,
        "the vault's event plus the SAC's transfer"
    );
    let emitted = all.filter_by_contract(&a.f.vault).events().to_vec();
    assert_eq!(
        emitted.len(),
        1,
        "the vault emits exactly one event, and it is bid_filled"
    );

    let st = a.state();
    let expected_premium = 400 * XLM * i128::from(valid_params().premium_start_bps) / BPS;
    assert_eq!(st.notional_sold, 400 * XLM);
    assert_eq!(st.premium_collected, expected_premium);
    assert_eq!(st.phase, Phase::Auction, "not sold out");
    assert_eq!(
        a.f.balance(&b),
        before - expected_premium,
        "premium taken exactly"
    );

    let fill = a.f.env.as_contract(&a.f.vault, || {
        crate::storage::get_fill(&a.f.env, 1, &b).unwrap()
    });
    assert_eq!(fill.notional, 400 * XLM);
    assert_eq!(fill.premium_paid, expected_premium);
    assert!(!fill.claimed);

    // §10's shape, asserted rather than counted: scenario 1 rebuilds the auction
    // from exactly these fields, and one left out cannot be added later.
    //
    // Three topics — the name, the round, the bidder — because a bidder's own
    // Claims page is built by filtering on the third, and without it the page
    // would have to fetch every fill in every round and discard other people's.
    let (topics, data) = event_parts(emitted.first().unwrap());

    // Three topics — the name, the round, the bidder. The third is why the Claims
    // page is a bounded read: a bidder's own page filters on it, and without it the
    // page would have to fetch every fill in every round and discard other
    // people's.
    assert_eq!(topics.len(), 3, "bid_filled carries three topics (§10)");
    expect_symbol(&topics[0], "bid_filled");
    expect_u32(&topics[1], 1);
    assert!(
        matches!(topics[2], xdr::ScVal::Address(_)),
        "the bidder is a topic, as an address"
    );

    expect_data_fields(
        &data,
        &[
            ("notional", Field::I128(400 * XLM)),
            // The running total **after** this fill, not the fill itself — both are
            // present so an indexer can detect a gap without replaying.
            ("notional_sold_after", Field::I128(400 * XLM)),
            ("premium", Field::I128(expected_premium)),
            ("premium_bps", Field::U32(valid_params().premium_start_bps)),
        ],
    );
}

#[test]
fn a_partial_fill_takes_what_is_left_and_the_final_sliver_may_be_below_min_fill() {
    // `min_fill` is 100 XLM. Offer 250, fill 200, leaving a 50-XLM remainder that
    // is below `min_fill` — the sliver exception is what lets the offer ever
    // fully fill.
    let a = live_auction(250 * XLM, valid_params());
    a.at(0);

    let first = a.bidder(100 * XLM);
    assert_eq!(a.bid(&first, 200 * XLM, BPS as u32).unwrap(), 200 * XLM);

    let second = a.bidder(100 * XLM);
    // Asks for more than remains and is filled with the remainder, which is
    // 50 XLM — under `min_fill`, and admissible because it exactly empties the
    // offer.
    assert_eq!(a.bid(&second, 500 * XLM, BPS as u32).unwrap(), 50 * XLM);

    let st = a.state();
    assert_eq!(st.notional_sold, 250 * XLM);
    assert_eq!(st.notional_sold, st.notional_offered);
    assert_eq!(st.phase, Phase::Active, "full subscription flips early");
}

#[test]
fn re_bids_accumulate_into_one_record_at_two_different_curve_points() {
    let a = live_auction(1_000 * XLM, valid_params());

    a.at(0);
    let b = a.bidder(200 * XLM);
    a.bid(&b, 100 * XLM, BPS as u32).unwrap();
    let p_first = premium_bps(&a.state(), a.f.env.ledger().timestamp());

    a.at(60);
    a.bid(&b, 100 * XLM, BPS as u32).unwrap();
    let p_second = premium_bps(&a.state(), a.f.env.ledger().timestamp());

    assert!(
        p_second < p_first,
        "the curve must have descended between the two"
    );

    let fill = a.f.env.as_contract(&a.f.vault, || {
        crate::storage::get_fill(&a.f.env, 1, &b).unwrap()
    });
    // One record, both fills, and the premiums are the two different rates —
    // which is exactly why a void refunds per fill and never pro-rata (D-51).
    assert_eq!(fill.notional, 200 * XLM);
    let expected = 100 * XLM * i128::from(p_first) / BPS + 100 * XLM * i128::from(p_second) / BPS;
    assert_eq!(fill.premium_paid, expected);
    assert!(!fill.claimed, "claimed stays false across a re-bid");
}

// =================================================================================================
// Every rejection, driven to fire — DEV-PROTOCOL §6
// =================================================================================================

fn assert_no_events(f: &Deployed, what: &str) {
    // §10: a rejection emits nothing. Asserted on every rejecting case, not just
    // the happy path.
    assert_eq!(
        f.env.events().all().events().len(),
        0,
        "{} must emit nothing",
        what
    );
}

#[test]
fn refuses_a_paused_zero_notional_bid_with_paused_and_not_invalid_amount() {
    // §16's canonical order made concrete, and the one assertion that proves the
    // order rather than merely the guards: both would fire, and only one may.
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    a.f.client().set_paused(&true);
    let b = a.bidder(100 * XLM);

    assert_eq!(a.bid(&b, 0, BPS as u32), Err(Error::Paused));
    assert_eq!(a.bid(&b, 100 * XLM, BPS as u32), Err(Error::Paused));
}

#[test]
fn refuses_the_vault_bidding_into_its_own_auction() {
    // §11. A SAC self-transfer succeeds while moving nothing, so without this a
    // "fill" would cost the bidder no premium at all.
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    let vault = a.f.vault.clone();
    assert_eq!(
        a.bid(&vault, 100 * XLM, BPS as u32),
        Err(Error::InvalidAddress)
    );
    assert_no_events(&a.f, "a self-bid");

    // The ordering DEV1 ruled on (F-6): the amount check comes first, so a
    // zero-notional self-bid answers `InvalidAmount` and not `InvalidAddress`.
    // Both guards would fire and exactly one may — the same shape as the paused
    // zero-notional case, one guard further down.
    assert_eq!(a.bid(&vault, 0, BPS as u32), Err(Error::InvalidAmount));

    // And pause still dominates both of them.
    a.f.client().set_paused(&true);
    assert_eq!(a.bid(&vault, 0, BPS as u32), Err(Error::Paused));
}

#[test]
fn refuses_a_non_positive_notional() {
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    let b = a.bidder(100 * XLM);
    assert_eq!(a.bid(&b, 0, BPS as u32), Err(Error::InvalidAmount));
    assert_eq!(a.bid(&b, -1, BPS as u32), Err(Error::InvalidAmount));
    assert_no_events(&a.f, "a zero-notional bid");
}

#[test]
fn refuses_a_bid_outside_the_auction_phase_and_at_or_past_auction_end() {
    let a = live_auction(1_000 * XLM, valid_params());
    let b = a.bidder(100 * XLM);

    // At `auction_end` exactly — strict inequality, and `AuctionClosed` (5) is
    // retired, so `WrongPhase` is the only answer a late caller can get.
    a.at(valid_params().auction_duration);
    assert_eq!(a.bid(&b, 100 * XLM, BPS as u32), Err(Error::WrongPhase));

    // And when the offer already sold out, so the phase is `Active`.
    let sold = live_auction(200 * XLM, valid_params());
    sold.at(0);
    let first = sold.bidder(100 * XLM);
    sold.bid(&first, 200 * XLM, BPS as u32).unwrap();
    assert_eq!(sold.state().phase, Phase::Active);
    let second = sold.bidder(100 * XLM);
    assert_eq!(
        sold.bid(&second, 100 * XLM, BPS as u32),
        Err(Error::WrongPhase)
    );
}

#[test]
fn refuses_an_unlisted_bidder_while_the_allowlist_is_live_and_admits_them_once_allowed() {
    // D-63, both directions. The gate ships enabled and expires on a timestamp no
    // setter can move — the admin can open early but can never stay closed.
    let a = live_auction_with_allowlist(1_000 * XLM, valid_params());
    a.at(0);
    let b = a.bidder(100 * XLM);

    assert_eq!(
        a.bid(&b, 100 * XLM, BPS as u32),
        Err(Error::AllowlistForbidden)
    );
    assert_no_events(&a.f, "an unlisted bid");

    // Allowed explicitly -> admitted. Written through `storage::set_allowed`
    // rather than the admin setter, because `set_allowed` lands in Phase 4 per
    // 00-ROADMAP's own split of the setters and does not exist yet. Same caveat
    // as `open_round_manually`: this cannot prove the setter produces this entry,
    // so the test is re-run against it when DEV1 lands it.
    allow(&a.f, &b);
    assert!(a.bid(&b, 100 * XLM, BPS as u32).is_ok());
}

#[test]
fn refuses_a_fill_above_the_bidders_own_slippage_guard() {
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    let b = a.bidder(100 * XLM);
    let now = a.f.env.ledger().timestamp();
    let p = premium_bps(&a.state(), now);

    assert_eq!(a.bid(&b, 100 * XLM, p - 1), Err(Error::PremiumAboveMax));
    assert_no_events(&a.f, "a slippage rejection");
    // Exactly at the limit is admissible — `premium_bps(now) <= max` (§4).
    assert!(a.bid(&b, 100 * XLM, p).is_ok());
}

#[test]
fn refuses_a_bid_when_spot_is_at_or_above_the_strike() {
    // **O-11.** The guard is `spot < strike`, so the boundary is inclusive on the
    // rejecting side: at exactly the strike the option is at the money and the
    // vault refuses. That pairs with settlement, where `spot <= strike` pays
    // nothing — both inclusive at the same point.
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    let b = a.bidder(100 * XLM);

    set_spot(&a.f, a.strike);
    assert_eq!(a.bid(&b, 100 * XLM, BPS as u32), Err(Error::InTheMoney));
    assert_no_events(&a.f, "an in-the-money bid");

    set_spot(&a.f, a.strike + 1_000);
    assert_eq!(a.bid(&b, 100 * XLM, BPS as u32), Err(Error::InTheMoney));

    set_spot(&a.f, a.strike - 1);
    assert!(
        a.bid(&b, 100 * XLM, BPS as u32).is_ok(),
        "one stroop below is admissible"
    );
}

#[test]
fn answers_oracle_unreachable_and_never_in_the_money_when_the_check_cannot_be_made() {
    // D-29's distinct codes, and the reason they are distinct: the keeper counts
    // them separately and only genuine no-bid epochs advance the D-34 stop gate,
    // so an outage recorded as "no demand" could end the project on bad data.
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    let b = a.bidder(100 * XLM);
    let mock = mock_price_source::MockPriceSourceClient::new(&a.f.env, &a.f.oracle);

    // A trapping adapter — a host trap, not an error return, which is what the
    // recoverable `try_` form has to catch (04-ORACLE §3b).
    mock.set_trap(&true);
    assert_eq!(
        a.bid(&b, 100 * XLM, BPS as u32),
        Err(Error::OracleUnreachable)
    );
    assert_no_events(&a.f, "an unreachable-oracle bid");
    mock.set_trap(&false);

    // **O-4e** — a `decimals` change mid-auction reaching `spot_check`. The round
    // pinned its scale at open; a changed scale makes the tick incomparable with
    // the strike, so the adapter returns `None` and the vault must read that as
    // unreachable rather than as an in-the-money price.
    mock.set_decimals(&(FEED_DECIMALS + 1));
    assert_eq!(
        a.bid(&b, 100 * XLM, BPS as u32),
        Err(Error::OracleUnreachable)
    );
    mock.set_decimals(&FEED_DECIMALS);

    // A stale tick — older than `max_staleness` plus the feed's own resolution.
    a.f.env.ledger().set_timestamp(a.opened_at + 1);
    mock.set_price(&(a.opened_at + 1), &at_feed_scale(a.strike - 1));
    a.f.env
        .ledger()
        .set_timestamp(a.opened_at + 1 + valid_params().max_staleness + 10);
    assert_eq!(
        a.bid(&b, 100 * XLM, BPS as u32),
        Err(Error::OracleUnreachable)
    );
}

/// **The zero-fill branch cannot be reached by any transaction, and this test now
/// proves that rather than covering it.**
///
/// Error 33 (`SoldOut`) was retired on 2026-08-19 — the first amendment to a signed
/// integration point — because §5 step 6 flips the phase to `Active` the instant the
/// offer fills and §16 checks the phase before `filled` is computed. A zero fill
/// needs `remaining == 0`, which is exactly the state the phase check has already
/// rejected. That made it ABI an integrator must handle and can never be handed,
/// the same shape D-60 retired 5, 23, 28, 55 and 56 for.
///
/// **The guard stayed.** `bid` still refuses a zero fill, folded into `WrongPhase`.
/// The reachability argument is what retires the *code*; it is not a licence to stop
/// checking, which is the gap `round_numbers`' fuzz target walked into on its first
/// run. The second half below is the evidence for the retirement: reaching the
/// branch takes `env.as_contract` writing the phase back, and no transaction can do
/// that.
#[test]
fn nothing_remains_of_the_offer_and_no_transaction_can_reach_the_zero_fill() {
    let a = live_auction(200 * XLM, valid_params());
    a.at(0);
    let first = a.bidder(100 * XLM);
    a.bid(&first, 200 * XLM, BPS as u32).unwrap();

    // The offer is gone, so §5 step 6 already flipped the phase and the next bid
    // meets the phase check first.
    let second = a.bidder(100 * XLM);
    assert_eq!(
        a.bid(&second, 100 * XLM, BPS as u32),
        Err(Error::WrongPhase)
    );

    // **Writing the phase back is the whole point of this half.** It takes
    // `as_contract` — a host escape no transaction has — and it is the only way to
    // stand in front of the zero-fill guard at all. If a future change ever makes
    // this state reachable through the public surface, the assertion above is what
    // breaks first, and this one still refuses the bid.
    a.f.env.as_contract(&a.f.vault, || {
        let mut st = crate::storage::get_state(&a.f.env).unwrap();
        st.phase = Phase::Auction;
        crate::storage::set_state(&a.f.env, &st);
    });
    assert_eq!(
        a.bid(&second, 100 * XLM, BPS as u32),
        Err(Error::WrongPhase),
        "the guard is kept and folded, not deleted with the code"
    );
    assert_no_events(&a.f, "a bid with nothing left to fill");
}

#[test]
fn refuses_a_dust_fill_unless_it_exactly_empties_the_offer() {
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    let b = a.bidder(100 * XLM);

    // `min_fill` is 100 XLM and 999 XLM remains, so a 1-XLM bid is dust rather
    // than a sliver.
    assert_eq!(a.bid(&b, XLM, BPS as u32), Err(Error::BelowMinFill));
    assert_no_events(&a.f, "a dust bid");
    assert!(
        a.bid(&b, 100 * XLM, BPS as u32).is_ok(),
        "exactly min_fill is admissible"
    );
}

#[test]
fn refuses_a_sliver_that_prices_to_nothing() {
    // 05 §1: "confirmed reachable: a 1-stroop sliver at the floor rounds to
    // premium 0, a free option." Constructed by offering a 1-stroop remainder,
    // which the sliver exception admits past `min_fill` — so `ZeroPremium` is the
    // guard that has to catch it, and it is the last one in the order.
    let mut p = valid_params();
    p.premium_floor_bps = 1;
    p.premium_start_bps = 1;
    let a = live_auction(100 * XLM + 1, p);
    a.at(0);

    let first = a.bidder(100 * XLM);
    a.bid(&first, 100 * XLM, BPS as u32).unwrap();

    // 1 stroop at 1 bp: ⌊1 × 1 / 10 000⌋ == 0.
    let second = a.bidder(100 * XLM);
    assert_eq!(a.bid(&second, 1, BPS as u32), Err(Error::ZeroPremium));
    assert_no_events(&a.f, "a zero-premium sliver");
}

// =================================================================================================
// I2 — DEV3's invariant
// =================================================================================================

#[test]
fn i2_holds_across_an_arbitrary_sequence_of_bids() {
    // `notional_sold <= notional_offered <= locked_at_open`. The property layer
    // proper is Phase 4's proptest suite; this is the deterministic sweep that
    // makes the invariant checked from the module's first day rather than from
    // the gate.
    let offered = 1_000 * XLM;
    let a = live_auction(offered, valid_params());

    let sizes = [100 * XLM, 250 * XLM, 700 * XLM, 1, 300 * XLM, 5_000 * XLM];
    for (i, size) in sizes.iter().enumerate() {
        a.at((i as u64) * 10);
        let b = a.bidder(1_000 * XLM);
        let _ = a.bid(&b, *size, BPS as u32);

        let st = a.state();
        assert!(
            st.notional_sold <= st.notional_offered,
            "I2 broken: sold {} > offered {}",
            st.notional_sold,
            st.notional_offered
        );
        assert!(
            st.notional_offered <= st.locked_at_open,
            "I2 broken: offered {} > locked_at_open {}",
            st.notional_offered,
            st.locked_at_open
        );
        assert!(st.premium_collected >= 0);
    }
}

#[test]
fn the_premium_transferred_equals_the_premium_recorded_for_every_fill() {
    // The inbound half of I1: what the contract says it collected is what arrived.
    let a = live_auction(1_000 * XLM, valid_params());
    let vault_before = a.f.balance(&a.f.vault);

    let mut total = 0i128;
    for (i, size) in [200 * XLM, 300 * XLM, 100 * XLM].iter().enumerate() {
        a.at((i as u64) * 20);
        let b = a.bidder(1_000 * XLM);
        let before = a.f.balance(&b);
        a.bid(&b, *size, BPS as u32).unwrap();
        total += before - a.f.balance(&b);
    }

    assert_eq!(a.state().premium_collected, total);
    assert_eq!(a.f.balance(&a.f.vault) - vault_before, total);
}

#[test]
fn a_bid_requires_the_bidders_authorization() {
    let a = live_auction(1_000 * XLM, valid_params());
    a.at(0);
    a.f.env.mock_auths(&[]);
    let b = Address::generate(&a.f.env);
    let r = a.f.client().try_bid(&b, &(100 * XLM), &(BPS as u32));
    assert!(r.is_err(), "an unauthorized bid must not succeed");
}

// -------------------------------------------------------------------------------
// D-84 — what the bidder authorizes, and what the bidder pays
//
// `bid` escrows a ceiling and refunds the difference, because the charge is a
// function of `now` and an authorization entry is signed against exact arguments
// one or two ledgers earlier. These tests assert the observable half of that: the
// account is out exactly the premium, the escrow is bounded by the curve's opening
// rate rather than by whatever the bidder passed, and a bidder funded for only the
// charge is refused. The failure D-84 describes cannot be reproduced in-process —
// `mock_all_auths` re-derives auth at apply time, which is precisely what a real
// wallet cannot do — so it was found on testnet and is pinned here by its fix.
// -------------------------------------------------------------------------------

#[test]
fn a_decayed_fill_charges_the_premium_and_refunds_the_rest_of_the_escrow() {
    let p = valid_params();
    let a = live_auction(1_000 * XLM, p.clone());
    // Halfway down the curve, so the escrow and the charge are genuinely different
    // numbers. At offset 0 they coincide and the refund leg would never run.
    a.at(p.auction_duration / 2);
    let b = a.bidder(100 * XLM);
    let before = a.f.balance(&b);

    let filled = a.bid(&b, 400 * XLM, BPS as u32).unwrap();
    let st = a.state();

    let escrow = filled * i128::from(p.premium_start_bps) / BPS;
    assert!(
        st.premium_collected < escrow,
        "the test is vacuous unless the curve has actually decayed: collected {} vs escrow {}",
        st.premium_collected,
        escrow
    );
    // The whole assertion, and it needs no second copy of the decay formula: the
    // account is out exactly what the vault says it took in.
    assert_eq!(
        a.f.balance(&b),
        before - st.premium_collected,
        "the escrow above the charge came back"
    );
}

#[test]
fn the_escrow_is_bounded_by_the_curve_and_not_by_what_the_bidder_passed() {
    let p = valid_params();
    let a = live_auction(1_000 * XLM, p.clone());
    a.at(0);
    // `BPS` is the idiom for "no slippage limit". Unclamped it would demand the
    // bidder escrow the entire notional; the curve descends from
    // `premium_start_bps`, so that is the most the auction can ever charge.
    let funded = 400 * XLM * i128::from(p.premium_start_bps) / BPS;
    let b = a.bidder(funded);
    assert_eq!(a.bid(&b, 400 * XLM, BPS as u32).unwrap(), 400 * XLM);
    assert_eq!(a.f.balance(&b), 0, "at offset 0 the charge IS the ceiling");
}

#[test]
fn a_bidder_funded_for_the_charge_but_not_the_ceiling_is_refused() {
    // The cost D-84 imposes, asserted rather than left to be discovered: the
    // account must HOLD the ceiling for the duration of the call even though it
    // only pays the charge. 02-CONTRACT-SPEC §5 says so in the same words.
    let p = valid_params();
    let a = live_auction(1_000 * XLM, p.clone());
    a.at(p.auction_duration / 2);

    let ceiling = 400 * XLM * i128::from(p.premium_start_bps) / BPS;
    let b = a.bidder(ceiling - 1);
    assert!(
        a.bid(&b, 400 * XLM, BPS as u32).is_err(),
        "one stroop short of the ceiling is short, even though the charge is lower"
    );

    // Non-vacuity: the same bid at the same instant succeeds with one more stroop,
    // so the refusal above is about the balance and not about anything else.
    let rich = a.bidder(ceiling);
    assert_eq!(a.bid(&rich, 400 * XLM, BPS as u32).unwrap(), 400 * XLM);
}
