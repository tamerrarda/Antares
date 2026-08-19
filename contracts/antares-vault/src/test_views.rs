//! §12 — the read surface, tested against 06-TEST-PLAN §2's views block.
//!
//! The two assertions that carry the most weight are the least obvious ones: that
//! `epoch()` reports a lapse **before** anybody triggers it, and that **no view
//! bumps a TTL**. The first is what stops the keeper and the UI reimplementing
//! lazy finalization off-chain; the second is what stops a reader paying rent.

#![allow(clippy::inconsistent_digit_grouping)]

use crate::errors::Error;
use crate::storage::DataKey;
use crate::test_common::{deploy, valid_params, CAP};
use crate::types::*;
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger},
    Address,
};

const XLM: i128 = 1_0000000;

// ============================ the effective phase ==============================

/// The one that matters: a round past `auction_end` with no fills reads `Idle`
/// with `outcome_pending = true`, **before** anyone calls a mutating function.
#[test]
fn epoch_reports_a_lapse_before_anyone_triggers_it() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);

    let live = d.client().epoch();
    assert_eq!(live.phase, Phase::Auction);
    assert!(!live.outcome_pending);

    d.advance(200);

    let after = d.client().epoch();
    assert_eq!(
        after.phase,
        Phase::Idle,
        "the effective phase, not the stored one"
    );
    assert!(
        after.outcome_pending,
        "and it says a finalization is owed rather than pretending it happened"
    );

    // The store is untouched: the view computed, it did not write.
    assert_eq!(d.state().phase, Phase::Auction);
}

/// An auction that sold something is not a lapse — it reads `Active` and still
/// owes the oracle a close.
#[test]
fn epoch_reports_active_when_the_auction_sold_something() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.env.as_contract(&d.vault, || {
        let mut st = crate::storage::get_state(&d.env).unwrap();
        st.notional_sold = 50 * XLM;
        crate::storage::set_state(&d.env, &st);
    });

    d.advance(200);
    let e = d.client().epoch();
    assert_eq!(e.phase, Phase::Active);
    assert!(
        !e.outcome_pending,
        "nothing is owed lazily — Active to Settled is never lazy"
    );
}

// ======================== the parameter copy (§15) =============================

/// The view must read the **same** `min_idle_gap` the contract enforces, or it
/// disagrees with the contract after any `set_epoch_params`. Asserted the way
/// 06-TEST-PLAN asks: change the template mid-round and check the view does not
/// move.
#[test]
fn next_open_at_uses_the_copy_the_contract_enforces() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    let before = d.client().epoch().next_open_at;

    let mut p = valid_params();
    p.min_idle_gap = 2_400; // legal, and very different from the snapshot's 48
    d.client().set_epoch_params(&p);

    assert_eq!(
        d.client().epoch().next_open_at,
        before,
        "the live round's window belongs to the round that created it"
    );
}

/// Before round 1 there is no snapshot, so the template is what governs — and the
/// view has to say so rather than reading an empty `State.params`.
#[test]
fn before_the_first_round_the_template_governs() {
    let d = deploy();
    let e = d.client().epoch();
    assert_eq!(e.round, 0);
    assert_eq!(e.params, valid_params());
    assert_eq!(
        e.next_open_at,
        valid_params().min_idle_gap,
        "last_finalize_time is 0 at genesis, so the first open is not gated"
    );
    assert_eq!(e.void_available_at, 0, "no round is live");
}

// ============================== bidder_position ================================

/// A zeroed struct, **not** an error. The Claims page scans rounds looking for
/// money owed, so "no fill" is its ordinary answer; an error would make the
/// common case indistinguishable from a malformed call.
#[test]
fn bidder_position_is_zeroed_for_an_address_that_never_filled() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.advance(200);
    d.client().restore_position(&a); // finalize round 1

    let stranger = Address::generate(&d.env);
    let p = d.client().bidder_position(&1, &stranger);
    assert_eq!(p.notional, 0);
    assert_eq!(p.premium_paid, 0);
    assert!(!p.claimed);
    assert_eq!(p.claimable, 0);
}

#[test]
fn bidder_position_errors_only_for_a_round_that_never_existed() {
    let d = deploy();
    let stranger = Address::generate(&d.env);

    assert_eq!(
        d.client().try_bidder_position(&1, &stranger),
        Err(Ok(Error::RoundNotFound)),
        "round 1 has not been opened yet"
    );
    assert_eq!(
        d.client().try_bidder_position(&0, &stranger),
        Err(Ok(Error::RoundNotFound)),
        "and there is no round 0 — the first is 1"
    );
}

// ============================== price_per_share ================================

/// A live round has no price yet, so it reports `last_pps` rather than erroring —
/// erroring would make "not settled" indistinguishable from "does not exist".
#[test]
fn price_per_share_reports_the_last_price_during_a_live_round() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    assert_eq!(d.client().price_per_share(&1), INITIAL_PPS);
    assert_eq!(
        d.client().try_price_per_share(&2),
        Err(Ok(Error::RoundNotFound))
    );
}

#[test]
fn price_per_share_reports_the_recorded_price_of_a_finalized_round() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.advance(200);
    d.client().restore_position(&a);

    assert_eq!(
        d.client().price_per_share(&1),
        INITIAL_PPS,
        "a lapse leaves the price untouched, and the record says so"
    );
}

// ================================ 4626 shapes ==================================

/// External tooling reads this as TVL, so it is pinned rather than convenient:
/// capital actually backing shares, excluding pending deposits, claimable
/// balances and raw donations.
#[test]
fn total_assets_ignores_a_donation_and_the_pending_pool() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    assert_eq!(d.client().total_assets(), 100 * XLM);

    // Somebody sends XLM straight to the contract. It belongs to nobody.
    let donor = d.user(50 * XLM);
    soroban_sdk::token::TokenClient::new(&d.env, &d.asset).transfer(&donor, &d.vault, &(50 * XLM));
    assert_eq!(
        d.client().total_assets(),
        100 * XLM,
        "a donation is not TVL — it backs no shares"
    );

    // And a pending deposit is not either: it has taken no risk.
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);
    let b = d.user(1_000 * XLM);
    d.client().deposit(&b, &(30 * XLM));
    assert_eq!(d.client().total_assets(), 100 * XLM);
}

#[test]
fn convert_to_shares_is_indicative_and_survives_a_worthless_vault() {
    let d = deploy();
    assert_eq!(d.client().convert_to_shares(&(10 * XLM)), 10 * XLM);

    d.env.as_contract(&d.vault, || {
        let mut st = crate::storage::get_state(&d.env).unwrap();
        st.last_pps = 0;
        crate::storage::set_state(&d.env, &st);
    });
    assert_eq!(
        d.client().convert_to_shares(&(10 * XLM)),
        0,
        "no division by zero — the view answers rather than trapping"
    );
}

// ============================== deposit headroom ===============================

#[test]
fn deposit_headroom_tracks_the_cap_and_floors_at_zero() {
    let d = deploy();
    assert_eq!(d.client().config().deposit_headroom, CAP);

    let a = d.user(CAP);
    d.client().deposit(&a, &(CAP / 2));
    assert_eq!(d.client().config().deposit_headroom, CAP / 2);

    d.client().deposit(&a, &(CAP / 2));
    assert_eq!(d.client().config().deposit_headroom, 0);

    // Past the cap — reachable by lowering it, which is legal (§16).
    d.env.as_contract(&d.vault, || {
        let mut cfg = crate::storage::get_config(&d.env).unwrap();
        cfg.deposit_cap = CAP / 4;
        crate::storage::set_config(&d.env, &cfg);
    });
    assert_eq!(
        d.client().config().deposit_headroom,
        0,
        "floored, never negative"
    );
}

// ================================== position ===================================

#[test]
fn position_reports_both_pending_slots_and_their_state() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);
    d.client().request_withdraw(&a, &(20 * XLM), &false);
    let b = d.user(1_000 * XLM);
    d.client().deposit(&b, &(30 * XLM));

    let pa = d.client().position(&a);
    assert_eq!(pa.shares, 100 * XLM - DEAD_SHARES - 20 * XLM);
    assert_eq!(pa.pending_withdraw_shares, 20 * XLM);
    assert_eq!(pa.pending_withdraw_round, 1);
    assert_eq!(
        pa.withdraw_claimable, 0,
        "0 until that round finalizes — which is not the same as nothing owed"
    );

    let pb = d.client().position(&b);
    assert_eq!(pb.pending_deposit, 30 * XLM);
    assert_eq!(pb.pending_deposit_round, 1);
    assert!(
        !pb.pending_deposit_finalized,
        "the round is live, so it is not redeemable yet"
    );

    // Finalize, and both change meaning.
    d.advance(2_000);
    d.client().restore_position(&a);

    assert_eq!(d.client().position(&a).withdraw_claimable, 20 * XLM);
    assert!(
        d.client().position(&b).pending_deposit_finalized,
        "redeemable now — and still cancellable, which D-37 made true"
    );
}

// ============================ no view bumps a TTL ==============================

/// 03-STORAGE-TTL §2: views stay read-only. A reader must not pay rent, and a
/// view that bumped would also make `position()` a write in the eyes of
/// simulation.
#[test]
fn no_view_bumps_a_ttl() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.client().request_withdraw(&a, &(10 * XLM), &false);
    d.advance(200);
    d.client().restore_position(&a); // finalize, so a Round record exists

    let keys = [
        DataKey::Shares(a.clone()),
        DataKey::PendingWithdraw(a.clone()),
        DataKey::Round(1),
    ];
    let before: [u32; 3] = d.env.as_contract(&d.vault, || {
        core::array::from_fn(|i| d.env.storage().persistent().get_ttl(&keys[i]))
    });

    // Let time pass so a bump would be visible, then call every view.
    d.env
        .ledger()
        .set_sequence_number(d.env.ledger().sequence() + 1_000);

    d.client().epoch();
    d.client().position(&a);
    d.client().config();
    let _ = d.client().try_bidder_position(&1, &a);
    let _ = d.client().try_price_per_share(&1);
    d.client().total_assets();
    d.client().convert_to_shares(&XLM);

    let after: [u32; 3] = d.env.as_contract(&d.vault, || {
        core::array::from_fn(|i| d.env.storage().persistent().get_ttl(&keys[i]))
    });

    for i in 0..3 {
        assert_eq!(
            after[i],
            before[i] - 1_000,
            "key {i} was bumped by a view; TTL only decayed with the ledger"
        );
    }
}
