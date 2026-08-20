//! §2.4 and §2.5 — the epoch ledger, driven to reject as well as to pass.
//!
//! Two things about the shape of this file, both stated rather than left to be
//! discovered:
//!
//! **Live-round states are written directly.** `open_epoch` is DEV2's and lands
//! with IP-2. Until then `Auction` and `Active` are unreachable through the
//! public surface, and the paths that only exist during a live round — pending
//! deposits, queued withdrawals, the lapse — would go untested for a phase. Every
//! test that uses `open_round_manually` is therefore re-run against the real
//! opener at IP-2; what it proves today is the accounting, not the opening.
//!
//! **Every rejection asserts an empty event log.** §10 requires that a rejection
//! emits nothing, and nothing but a test enforces it — the contract cannot
//! observe its own revert.

#![allow(clippy::inconsistent_digit_grouping)]

use crate::errors::Error;
use crate::test_common::{deploy, valid_params, CAP};
use crate::types::*;
use mock_price_source::{MockPriceSourceClient, Mode};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    Address, Env,
};

const XLM: i128 = 1_0000000;

/// A rejecting call must leave the event log untouched (§10).
fn assert_no_events(env: &Env) {
    assert_eq!(
        env.events().all().events().len(),
        0,
        "a rejection emitted an event; §10 says rejections emit nothing"
    );
}

// =============================================================== deposit ========

#[test]
fn the_first_deposit_mints_dead_shares_out_of_its_own_amount() {
    let d = deploy();
    let user = d.user(1_000 * XLM);

    let minted = d.client().deposit(&user, &(100 * XLM));

    // D-36: the contract keeps 1 000 stroops, charged to this deposit, and they
    // have no burn path — which is why supply never returns to zero after
    // genesis and why `min_deposit > DEAD_SHARES` is a rule rather than a habit.
    assert_eq!(minted, 100 * XLM - DEAD_SHARES);
    let st = d.state();
    assert_eq!(st.shares_outstanding, 100 * XLM);
    assert_eq!(st.locked_assets, 100 * XLM);
    assert_eq!(d.balance(&d.vault), 100 * XLM, "the XLM actually moved");
    assert_eq!(d.balance(&user), 900 * XLM);
}

#[test]
fn a_later_idle_deposit_mints_at_the_current_price_and_pays_no_dead_shares() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let b = d.user(1_000 * XLM);

    d.client().deposit(&a, &(100 * XLM));
    let minted = d.client().deposit(&b, &(50 * XLM));

    assert_eq!(minted, 50 * XLM, "at INITIAL_PPS, one XLM is one share");
    assert_eq!(d.state().shares_outstanding, 150 * XLM);
}

#[test]
fn a_deposit_during_a_live_round_becomes_pending_and_is_never_offered() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);
    let b = d.user(1_000 * XLM);
    let minted = d.client().deposit(&b, &(50 * XLM));

    assert_eq!(minted, 0, "no shares are minted mid-round (D-18)");
    let st = d.state();
    assert_eq!(st.pending_deposits_total, 50 * XLM);
    assert_eq!(
        st.locked_assets,
        100 * XLM,
        "pending capital is not in locked_assets and takes none of the round's risk"
    );
    assert_eq!(st.shares_outstanding, 100 * XLM);
}

/// §16: a second deposit in the same live round accumulates rather than
/// replacing or rejecting.
#[test]
fn a_second_deposit_in_the_same_round_accumulates() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    let b = d.user(1_000 * XLM);
    d.client().deposit(&b, &(20 * XLM));
    d.client().deposit(&b, &(30 * XLM));

    assert_eq!(d.state().pending_deposits_total, 50 * XLM);
    let pending = d
        .env
        .as_contract(&d.vault, || crate::storage::get_pending_deposit(&d.env, &b));
    assert_eq!(pending.unwrap().amount, 50 * XLM);
}

#[test]
fn a_deposit_below_the_minimum_is_rejected_and_emits_nothing() {
    let d = deploy();
    let user = d.user(1_000 * XLM);
    let min = valid_params().min_deposit;

    assert_eq!(
        d.client().try_deposit(&user, &(min - 1)),
        Err(Ok(Error::BelowMinDeposit))
    );
    assert_no_events(&d.env);
    assert_eq!(d.balance(&user), 1_000 * XLM, "and no XLM moved");
}

#[test]
fn a_deposit_past_the_cap_is_rejected() {
    let d = deploy();
    let user = d.user(CAP + 100 * XLM);

    assert_eq!(
        d.client().try_deposit(&user, &(CAP + 1)),
        Err(Ok(Error::DepositCapExceeded))
    );
    assert_no_events(&d.env);

    d.client().deposit(&user, &CAP);
    let other = d.user(10 * XLM);
    assert_eq!(
        d.client().try_deposit(&other, &(10 * XLM)),
        Err(Ok(Error::DepositCapExceeded)),
        "the cap counts locked + pending, so a full vault refuses the next deposit"
    );
}

/// §11, and not cosmetic: a SAC self-transfer succeeds while moving nothing, so
/// without this the vault would mint shares against a transfer that never
/// happened.
#[test]
fn the_vault_may_not_deposit_into_itself() {
    let d = deploy();
    let vault = d.vault.clone();
    d.fund(&vault, 1_000 * XLM);

    assert_eq!(
        d.client().try_deposit(&vault, &(100 * XLM)),
        Err(Ok(Error::InvalidAddress))
    );
    assert_no_events(&d.env);
}

/// **Finalized, not settled.** A lapsed round also leaves a redeemable pending,
/// and `PendingDeposit(user)` is a single slot — the narrower word would let a
/// new deposit overwrite it and strand the old amount inside
/// `pending_deposits_total` forever.
#[test]
fn a_deposit_over_an_unredeemed_finalized_pending_is_rejected() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    let b = d.user(1_000 * XLM);
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.client().deposit(&b, &(20 * XLM));

    // Let the empty auction lapse, then open a second round.
    d.advance(200);
    d.client().restore_position(&a); // any touch absorbs the lapse
    d.open_round_manually(2, Phase::Auction, d.env.ledger().timestamp() + 100);

    assert_eq!(
        d.client().try_deposit(&b, &(20 * XLM)),
        Err(Ok(Error::UnredeemedPending))
    );
}

// ================================================================ cancel ========

/// The only instant exit that works during a live round, and it is safe because
/// that capital never backed an option — I4's own stated exception.
#[test]
fn a_pending_deposit_can_be_cancelled_during_a_live_round_for_the_exact_amount() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    let b = d.user(1_000 * XLM);
    d.client().deposit(&b, &(50 * XLM));
    assert_eq!(d.balance(&b), 950 * XLM);

    let returned = d.client().cancel_pending_deposit(&b);

    assert_eq!(returned, 50 * XLM, "exact, to the stroop");
    assert_eq!(d.balance(&b), 1_000 * XLM);
    assert_eq!(d.state().pending_deposits_total, 0);
}

#[test]
fn cancelling_without_a_pending_deposit_is_rejected() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    assert_eq!(
        d.client().try_cancel_pending_deposit(&a),
        Err(Ok(Error::NothingPending))
    );
    assert_no_events(&d.env);
}

// ================================================================ redeem ========

/// D-37: the conversion price is **today's**, not the one frozen when the
/// deposit was made. Converting at the old `pps[R]` broke I9 and handed the
/// depositor a free lookback option across rounds.
#[test]
fn a_pending_deposit_redeems_at_the_current_price() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    let b = d.user(1_000 * XLM);
    d.client().deposit(&b, &(50 * XLM));

    d.advance(200);
    d.client().restore_position(&a); // absorbs the lapse; phase returns to Idle
    assert_eq!(d.state().phase, Phase::Idle);

    let shares = d.client().redeem_shares(&b);
    assert_eq!(
        shares,
        50 * XLM,
        "at last_pps, which the lapse left unchanged"
    );
    let st = d.state();
    assert_eq!(st.pending_deposits_total, 0);
    assert_eq!(
        st.locked_assets,
        150 * XLM,
        "the capital joins the pool now"
    );
}

#[test]
fn redeeming_outside_the_idle_window_is_rejected() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);
    let b = d.user(1_000 * XLM);
    d.client().deposit(&b, &(50 * XLM));

    assert_eq!(d.client().try_redeem_shares(&b), Err(Ok(Error::WrongPhase)));
}

#[test]
fn redeeming_without_a_pending_deposit_is_rejected() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    assert_eq!(
        d.client().try_redeem_shares(&a),
        Err(Ok(Error::NothingPending))
    );
    assert_no_events(&d.env);
}

// ============================================================== withdraw ========

#[test]
fn an_idle_withdrawal_pays_instantly_at_the_last_price() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    let paid = d.client().request_withdraw(&a, &(40 * XLM), &true);

    assert_eq!(paid, 40 * XLM);
    assert_eq!(d.balance(&a), 940 * XLM);
    let st = d.state();
    assert_eq!(st.locked_assets, 60 * XLM);
    assert_eq!(st.shares_outstanding, 60 * XLM);
}

/// D-46: a user asking for an instant exit can never be silently converted into
/// a queued one by an `open_epoch` landing first.
#[test]
fn require_idle_refuses_to_queue() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    // The ledger starts at timestamp 0 in the test environment, so advance before
    // reaching for a moment in the past. `auction_end` is not read in `Active`
    // anyway — `lazy_finalize` returns early on the phase — but a test that only
    // works at t = 0 is a test that hides its assumptions.
    d.advance(1_000);
    d.open_round_manually(1, Phase::Active, d.env.ledger().timestamp() - 1);

    assert_eq!(
        d.client().try_request_withdraw(&a, &(10 * XLM), &true),
        Err(Ok(Error::WrongPhase))
    );

    // …and the same call without the flag queues rather than reverting.
    let paid = d.client().request_withdraw(&a, &(10 * XLM), &false);
    assert_eq!(paid, 0);
    assert_eq!(d.state().burned_this_round, 10 * XLM);
}

#[test]
fn a_withdrawal_larger_than_the_balance_is_rejected() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    assert_eq!(
        d.client().try_request_withdraw(&a, &(100 * XLM), &true),
        Err(Ok(Error::InsufficientShares)),
        "the depositor holds 100 XLM minus the dead shares, not 100"
    );
    assert_eq!(
        d.client().try_request_withdraw(&a, &0, &true),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        d.client().try_request_withdraw(&a, &-1, &true),
        Err(Ok(Error::InvalidAmount))
    );
}

/// §16's zero-value rule: burning shares for nothing is never a legitimate
/// instant operation — while the vault itself is worth something.
#[test]
fn an_instant_withdrawal_that_floors_to_zero_is_rejected() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    // Drive `last_pps` far below PRECISION so that a single share is worth less
    // than a stroop.
    d.env.as_contract(&d.vault, || {
        let mut st = crate::storage::get_state(&d.env).unwrap();
        st.last_pps = 1;
        crate::storage::set_state(&d.env, &st);
    });

    assert_eq!(
        d.client().try_request_withdraw(&a, &1, &true),
        Err(Ok(Error::InvalidAmount))
    );
    // The assertion this test was missing, and its absence is how a burn event
    // came to sit in a rejected call's snapshot for two blocks. §10 says a
    // rejection emits nothing, and only a test says it here.
    assert_no_events(&d.env);
}

/// The exception that keeps I8's promise literally true: at `last_pps == 0` the
/// reject would turn "your shares are worth nothing" into "you cannot remove
/// your shares".
#[test]
fn at_a_worthless_vault_an_instant_withdrawal_burns_and_pays_zero() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.env.as_contract(&d.vault, || {
        let mut st = crate::storage::get_state(&d.env).unwrap();
        st.last_pps = 0;
        crate::storage::set_state(&d.env, &st);
    });

    let paid = d.client().request_withdraw(&a, &(10 * XLM), &true);
    assert_eq!(paid, 0, "zero, and it succeeded");
    assert_eq!(
        d.state().shares_outstanding,
        100 * XLM - 10 * XLM,
        "the shares are gone, which is what the holder asked for"
    );

    // And minting is refused in the same state, rather than dividing by zero.
    let b = d.user(1_000 * XLM);
    assert_eq!(
        d.client().try_deposit(&b, &(50 * XLM)),
        Err(Ok(Error::VaultWorthless))
    );
}

#[test]
fn claiming_without_a_queued_withdrawal_is_rejected() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    assert_eq!(
        d.client().try_claim_withdraw(&a),
        Err(Ok(Error::NothingPending))
    );
    assert_no_events(&d.env);
}

// ==================================================== D-32, the regression =====

/// **The bug this shape exists to prevent.** The Lapsed branch originally skipped
/// the withdrawal-queue accounting that settle and void both perform, which is a
/// solvency bug rather than a style issue — so every outcome now goes through one
/// `finalize_round`.
///
/// Withdraw during the auction, let it lapse with no bids, then claim: the payout
/// must be correct and must not underflow.
#[test]
fn a_withdrawal_queued_into_a_lapsed_round_claims_correctly() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    let before = d.balance(&a);

    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    let queued = d.client().request_withdraw(&a, &(40 * XLM), &false);
    assert_eq!(queued, 0, "queued, not paid");

    let st = d.state();
    assert_eq!(st.burned_this_round, 40 * XLM);
    assert_eq!(st.shares_outstanding, 60 * XLM, "burned now, paid later");

    // No bids: the next touch of any kind absorbs the lapse.
    d.advance(200);
    d.client().restore_position(&a);

    let st = d.state();
    assert_eq!(st.phase, Phase::Idle);
    assert_eq!(
        st.withdraw_claimable_total,
        40 * XLM,
        "the lapse credited the queue — the exact line D-32 was missing"
    );
    assert_eq!(
        st.locked_assets,
        60 * XLM,
        "and took the same amount out of the pool"
    );

    let paid = d.client().claim_withdraw(&a);
    assert_eq!(
        paid,
        40 * XLM,
        "at the lapsed round's recorded pps, unchanged"
    );
    assert_eq!(d.balance(&a), before + 40 * XLM);
    assert_eq!(d.state().withdraw_claimable_total, 0);
}

/// 06-TEST-PLAN's direct statement of the same invariant: after finalization,
/// `withdraw_claimable_total` has risen by exactly the value of shares burned
/// during that round at that round's `pps`, and `locked_assets` has fallen by
/// the same.
#[test]
fn finalization_moves_exactly_the_burned_value_between_the_two_buckets() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.client().request_withdraw(&a, &(25 * XLM), &false);

    let before = d.state();
    d.advance(200);
    d.client().restore_position(&a);
    let after = d.state();

    let moved = 25 * XLM; // pps unchanged by a lapse
    assert_eq!(
        after.withdraw_claimable_total - before.withdraw_claimable_total,
        moved
    );
    assert_eq!(before.locked_assets - after.locked_assets, moved);
    assert_eq!(after.burned_this_round, 0, "reset with the round");
}

/// A second request in the same live round accumulates into the existing record
/// rather than replacing it — otherwise the first burn is lost (§16).
#[test]
fn two_requests_in_one_round_accumulate_rather_than_overwrite() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    d.client().request_withdraw(&a, &(10 * XLM), &false);
    d.client().request_withdraw(&a, &(15 * XLM), &false);

    let pending = d.env.as_contract(&d.vault, || {
        crate::storage::get_pending_withdraw(&d.env, &a)
    });
    assert_eq!(pending.unwrap().shares, 25 * XLM);
    assert_eq!(d.state().burned_this_round, 25 * XLM);
}

// ====================================================== the lapse itself ========

#[test]
fn an_empty_auction_lapses_on_the_next_touch_of_any_kind() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);

    d.advance(200);
    assert_eq!(
        d.state().phase,
        Phase::Auction,
        "still Auction until touched"
    );

    d.client().restore_position(&a);

    let st = d.state();
    assert_eq!(st.phase, Phase::Idle);
    let record = d
        .env
        .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1))
        .expect("the lapse wrote a Round record");
    assert_eq!(record.outcome, RoundOutcome::Lapsed);
    assert_eq!(
        record.pps, INITIAL_PPS,
        "a lapse leaves the price untouched"
    );
}

/// An auction that sold something is not a lapse: it becomes `Active` and waits
/// for the oracle. `Active → Settled/Voided` is never lazy.
#[test]
fn an_auction_with_fills_goes_active_rather_than_lapsing() {
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
    d.client().restore_position(&a);

    assert_eq!(d.state().phase, Phase::Active);
    assert!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1))
            .is_none(),
        "no Round record: the round has not finalized, it has only stopped selling"
    );
}

// ================================================================= pause ========

#[test]
fn pause_blocks_deposits_and_nothing_on_the_exit_path() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.env.as_contract(&d.vault, || {
        let mut cfg = crate::storage::get_config(&d.env).unwrap();
        cfg.paused = true;
        crate::storage::set_config(&d.env, &cfg);
    });

    assert_eq!(
        d.client().try_deposit(&a, &(10 * XLM)),
        Err(Ok(Error::Paused))
    );

    // I8: every one of these still works while paused.
    let paid = d.client().request_withdraw(&a, &(10 * XLM), &true);
    assert_eq!(paid, 10 * XLM, "the exit path cannot be paused");
    d.client().restore_position(&a);
}

// ============================================== the dead shares are inert =======

/// D-36's second half: the contract's own shares have no burn path and cannot be
/// moved, which is what makes the supply floor permanent.
#[test]
fn the_dead_shares_stay_where_they_are() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    let held = d
        .env
        .as_contract(&d.vault, || crate::storage::get_shares(&d.env, &d.vault));
    assert_eq!(held, DEAD_SHARES);

    // Every holder exits; the supply lands at DEAD_SHARES and never at zero.
    let all = d
        .env
        .as_contract(&d.vault, || crate::storage::get_shares(&d.env, &a));
    d.client().request_withdraw(&a, &all, &true);

    assert_eq!(
        d.state().shares_outstanding,
        DEAD_SHARES,
        "zero supply is unreachable after genesis, so tests assuming it are unconstructible"
    );
}

/// A vault nobody has ever deposited into is the one true zero-supply state.
#[test]
fn a_fresh_vault_has_no_shares_at_all() {
    let d = deploy();
    let st = d.state();
    assert_eq!(st.shares_outstanding, 0);
    assert_eq!(st.locked_assets, 0);
    assert_eq!(st.last_pps, INITIAL_PPS);
    let _ = Address::generate(&d.env);
}

// ================================== the clamp, on the real exit path ===========

/// The regression 03-STORAGE-TTL §2 announces and 06-TEST-PLAN's rent block asks
/// for: store a valid `rent_extend_to`, let the network lower `max_ttl` below it,
/// and assert **the unpausable exit path still succeeds**.
///
/// §2.2 could only test the helper, because the exit path did not exist yet. It
/// does now. `close_round` is DEV2's and joins this test at IP-2 — the two halves
/// present here are the two that are mine.
///
/// Unclamped, the bump at the end of these calls asks for more TTL than the
/// network allows; if the host rejects that ask, `claim_withdraw` bricks — with
/// `set_rent_params` bricked behind the same bump, so nobody could repair it.
#[test]
fn the_exit_path_survives_a_ceiling_lowered_after_the_fact() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    // Queue a withdrawal into a round, then let it lapse, so there is a real
    // claim to make afterwards.
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.client().request_withdraw(&a, &(30 * XLM), &false);
    d.advance(200);
    d.client().restore_position(&a);

    // The network lowers the ceiling far below the stored `rent_extend_to`.
    let stored = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap())
        .rent_extend_to;
    d.env.ledger().set_max_entry_ttl(stored / 10);
    assert!(
        d.env.as_contract(&d.vault, || d.env.storage().max_ttl()) < stored,
        "the premise: the stored value now exceeds what the network allows"
    );

    // Both halves of the exit path that are mine, while paused for good measure —
    // I8 says pause may never hold funds.
    d.env.as_contract(&d.vault, || {
        let mut cfg = crate::storage::get_config(&d.env).unwrap();
        cfg.paused = true;
        crate::storage::set_config(&d.env, &cfg);
    });

    let paid = d.client().claim_withdraw(&a);
    assert_eq!(paid, 30 * XLM);

    let left = d
        .env
        .as_contract(&d.vault, || crate::storage::get_shares(&d.env, &a));
    let out = d.client().request_withdraw(&a, &left, &true);
    assert_eq!(out, left, "and the instant path too");
}

// ====================== finalize_numbers — the extracted half =====================
//
// The differential layer's last gap. `settle_ref.py` has been undiffed since the
// second commit in this project because `wclaims` and `locked_after` lived inside
// `finalize_round` alongside its storage writes, and a replay harness cannot call
// the inside of an entry point. `claims_ref.withdraw_claims` was blocked behind it.
//
// These test the pure function directly. `finalize_round` calls it, so passing here
// and passing there are the same arithmetic rather than two copies that agree today.

use crate::vault::finalize_numbers;

#[test]
fn wclaims_floors_and_the_remainder_stays_with_the_vault() {
    // 3 shares at a price of 1.5 units: 4.5 floors to 4, and the half unit stays in
    // the pool rather than being conjured for the leaver. §6's direction.
    let pps = PRECISION * 3 / 2;
    let (wclaims, locked_after) = finalize_numbers(3, pps, 100).unwrap();
    assert_eq!(wclaims, 4, "floored, not rounded");
    assert_eq!(locked_after, 96);
    assert_eq!(
        wclaims + locked_after,
        100,
        "nothing is created or destroyed"
    );
}

#[test]
fn nothing_burned_leaves_the_pool_exactly_as_it_was() {
    let (wclaims, locked_after) = finalize_numbers(0, PRECISION, 12_345).unwrap();
    assert_eq!((wclaims, locked_after), (0, 12_345));
}

#[test]
fn the_multiply_is_checked() {
    assert_eq!(
        finalize_numbers(i128::MAX, i128::MAX, 0),
        Err(Error::InvalidAmount),
        "burned × pps must not wrap"
    );
}

#[test]
fn the_subtraction_is_checked() {
    // `assets_after` at the floor and a positive `wclaims`: the subtraction underflows
    // the type rather than merely going negative, and that is the case `checked_sub`
    // exists for.
    assert_eq!(
        finalize_numbers(1, PRECISION, i128::MIN),
        Err(Error::InvalidAmount)
    );
}

/// Ruled 2026-08-19: the guard belongs here, and the precedent is `round_numbers`
/// refusing five fields it cannot reach after a fuzz target found the gap that
/// "other code guarantees this" leaves. Unreachable through `close_round`, which
/// rejects `assets_R < 0` first — but this function is reachable from a replay
/// harness that does not honour its caller's domain, and what it returns is
/// `locked_assets`. This test is the inversion of the one that recorded the old
/// behaviour, name included.
#[test]
fn a_negative_locked_after_is_refused() {
    assert_eq!(
        finalize_numbers(10, PRECISION, 4),
        Err(Error::InvalidAmount),
        "wclaims 10 against assets_after 4 is not a 6-unit hole in the pool"
    );
}

/// The chain the reference spells out and this side relies on: with `burned ≤ S` and
/// `pps = ⌊assets_R × PRECISION / S⌋`, `locked_after` cannot go negative. Walked over
/// a spread of shapes rather than argued, because the argument is what the asymmetry
/// above turns on.
#[test]
fn the_chain_that_makes_the_guard_unnecessary_holds_across_shapes() {
    for &(assets_r, s) in &[
        (100i128, 3i128),
        (1, 1_000),
        (1_000_000, 7),
        (0, 5),
        (i64::MAX as i128, 1_000_000),
    ] {
        let pps = assets_r * PRECISION / s;
        for burned in [0, 1, s / 2, s] {
            let (wclaims, locked_after) = finalize_numbers(burned, pps, assets_r).unwrap();
            assert!(
                locked_after >= 0,
                "chain broken at assets_R={assets_r} S={s} burned={burned}: \
                 wclaims={wclaims} locked_after={locked_after}"
            );
        }
    }
}

// ======================= I6 in its D-66 form, constructed ========================
//
// 06-TEST-PLAN §3 names "the degenerate-`pps` test below" and no such test existed
// anywhere in the crate. The property suite now asserts I6 on every finalized
// round — measured at 28 rounds across a run — but **`i6_degenerate` came back 0**:
// the generator never reaches the state D-66 exists for, so the assertion was
// exercising its easy half. An invariant with a number beside it looks covered,
// and this is the second time that has been the finding.
//
// So the state is built rather than waited for. Degenerate means
// `assets_R × PRECISION < shares_snapshot` — the pool worth less than one stroop
// per PRECISION share-units — where `pps` floors to zero. `bid` is DEV3's, and a
// payout large enough to do this to a real pool needs one, so the fills are written
// to `State` directly, exactly as `test_settle.rs` does for the same reason.

#[test]
fn a_round_whose_pool_cannot_cover_one_stroop_per_share_finalizes_at_pps_zero() {
    let d = deploy();
    let user = d.user(1_000 * XLM);
    d.client().deposit(&user, &(100 * XLM));
    d.open_round_manually(1, Phase::Active, d.env.ledger().timestamp() + 100);

    // The smallest numbers that satisfy D-66's condition: 1 stroop of assets
    // against 2·PRECISION share-units.
    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.notional_sold = 1; // past the `notional_sold == 0` lapse branch
        s.premium_collected = 0;
        // `open_round_manually` leaves `strike` at genesis zero, and `round_numbers`
        // refuses a non-positive strike rather than trusting its caller — the exact
        // domain guard cited as precedent for `finalize_numbers`, catching a bad
        // fixture on its first use. Set to a real strike so the refusal under test
        // is D-66's and not a fixture's.
        s.strike = 100 * PRECISION;
        s.locked_assets = 1;
        s.locked_at_open = 1;
        s.shares_snapshot = 2 * PRECISION;
        crate::storage::set_state(&d.env, &s);
    });

    // Out of reach, past every window: the unresolved path, which is one of the two
    // that *computes* `pps` rather than carrying it.
    MockPriceSourceClient::new(&d.env, &d.oracle).set_mode(&Mode::ForceOutOfReach);
    d.advance(100_000);

    let outcome = d.client().close_round(&Address::generate(&d.env));
    assert_eq!(outcome, RoundOutcome::Unresolved, "the computed-pps path");

    let rec = d
        .env
        .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1))
        .expect("round 1 finalized");
    assert_eq!(rec.pps, 0, "1 × PRECISION / 2·PRECISION floors to zero");

    // **The half that makes D-66 a decision rather than an accident.** A `pps >= 1`
    // floor would credit `shares_snapshot × 1 / PRECISION = 2` stroops of withdrawal
    // claims against a pool holding 1 — `Σ claim_withdraw` exceeding what was
    // credited, which is I1. Where I6 and I1 conflict, solvency wins, and this is
    // the arithmetic that decides it rather than a sentence asserting it.
    let floor_pps = 1i128; // the `pps >= 1` clamp D-66 removed
    let promised_under_a_floor = (2 * PRECISION) * floor_pps / PRECISION;
    assert!(
        promised_under_a_floor > 1,
        "a pps floor would have promised {promised_under_a_floor} against 1 stroop"
    );

    let st = d.state();
    assert!(st.locked_assets >= 0, "and the pool never goes negative");
    assert_eq!(st.phase, Phase::Idle, "terminal either way (I10)");
}

// ============ what the mutation run found unasserted, not uncovered =============
//
// Four survivors here were paths a test walks through without pinning what happens
// on them. The distinction matters: line coverage says these are tested.

/// `instant` rides on the event and nowhere else, so nothing but the event can
/// pin it — which is why inverting it survived a run in which the path itself is
/// well covered. Off-chain that flag is the difference between "this depositor
/// holds shares now" and "they hold a pending claim", and an indexer has only the
/// event to tell them apart.
fn instant_flag(env: &Env) -> bool {
    use soroban_sdk::xdr::{ScMap, ScSymbol, ScVal};
    let all = env.events().all();
    let evs = all.events();
    for e in evs.iter() {
        let soroban_sdk::xdr::ContractEventBody::V0(v0) = &e.body;
        if let ScVal::Map(Some(ScMap(entries))) = &v0.data {
            for kv in entries.iter() {
                if let (ScVal::Symbol(ScSymbol(k)), ScVal::Bool(b)) = (&kv.key, &kv.val) {
                    if k.as_slice() == b"instant" {
                        return *b;
                    }
                }
            }
        }
    }
    panic!("no `deposited` event carried an `instant` field");
}

#[test]
fn the_deposited_event_says_which_path_the_deposit_took() {
    let d = deploy();
    let a = d.user(1_000 * XLM);

    d.client().deposit(&a, &(100 * XLM));
    assert!(
        instant_flag(&d.env),
        "an Idle deposit reports instant = true"
    );

    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    let b = d.user(1_000 * XLM);
    d.client().deposit(&b, &(50 * XLM));
    assert!(
        !instant_flag(&d.env),
        "a mid-round deposit mints nothing and must report instant = false"
    );
}

#[test]
fn a_queued_withdrawal_moves_no_money_and_says_nothing_about_a_transfer() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);

    let before = d.balance(&a);
    d.client().request_withdraw(&a, &(10 * XLM), &false);
    let emitted = d.env.events().all().events().len();

    // **The balance is the wrong assertion and my first attempt used it.** A
    // zero-amount SAC transfer moves nothing either, so a balance check cannot tell
    // the two arms apart — and the mutant survived the fix. What distinguishes them
    // is the *event*: a zero-amount call is a legal no-op that still publishes a
    // transfer for money that did not move, which is the false line 08-OFFCHAIN
    // says an indexer must never be handed. The code's own comment said so; I
    // asserted the balance anyway.
    assert_eq!(d.balance(&a), before, "a queued request pays nothing now");
    assert_eq!(
        emitted, 2,
        "two events — the share burn and the request. A third is the transfer of \
         nothing that should not have happened"
    );
}

#[test]
fn a_pending_withdraw_from_an_older_round_is_replaced_rather_than_accumulated() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    // Queue in round 1.
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.client().request_withdraw(&a, &(10 * XLM), &false);

    // Round 2, with round 1 never finalized, so the older record is still there and
    // is *not* claimable. The match guard `p.round == round` was replaced by `true`
    // and survived — no test had a pending withdraw from a different round, so
    // nothing observed the difference between replacing the record and adding to it.
    d.open_round_manually(2, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.client().request_withdraw(&a, &(20 * XLM), &false);

    let queued = d
        .env
        .as_contract(&d.vault, || {
            crate::storage::get_pending_withdraw(&d.env, &a)
        })
        .expect("a pending record");
    assert_eq!(
        queued.round, 2,
        "the record belongs to the round that wrote it"
    );
    assert_eq!(
        queued.shares,
        20 * XLM,
        "a request from a different round replaces rather than accumulating — 30 here \
         would credit the user for shares round 2 never snapshotted"
    );
}

#[test]
fn an_empty_auction_lapses_at_exactly_its_end_not_a_second_later() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    let end = d.env.ledger().timestamp() + 100;
    d.open_round_manually(1, Phase::Auction, end);

    // Exactly `auction_end`, not past it. `<` widened to `<=` survived because no
    // test stood on this instant — and the boundary is the same one §4 fixes for
    // `bid`: a bid *at* `auction_end` is late, which is only coherent if the lapse
    // is available at that same instant.
    d.env.ledger().set_timestamp(end);
    d.client().deposit(&a, &(10 * XLM));

    assert_eq!(
        d.state().phase,
        Phase::Idle,
        "the empty auction lapsed at its end"
    );
    assert_eq!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1))
            .map(|r| r.outcome),
        Some(RoundOutcome::Lapsed)
    );
}

#[test]
fn a_claim_worth_nothing_succeeds_and_moves_no_money() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);
    d.client().request_withdraw(&a, &(10 * XLM), &false);

    // Finalize the round at a price of zero — the state D-66 deliberately allows —
    // so the queued shares are worth nothing when they are claimed.
    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.phase = Phase::Idle;
        s.last_pps = 0;
        crate::storage::set_state(&d.env, &s);
        crate::storage::set_round(
            &d.env,
            crate::storage::Rent {
                threshold: 100,
                extend_to: 200,
            },
            1,
            &Round {
                outcome: RoundOutcome::Unresolved,
                pps: 0,
                strike: 1,
                expiry: 1,
                notional_sold: 0,
                premium: 0,
                fee: 0,
                settled_spot: 0,
                payout_total: 0,
            },
        );
    });

    let before = d.balance(&a);
    d.client().claim_withdraw(&a);
    let emitted = d.env.events().all().events().len();

    // Same correction as above, and the same mistake made twice: the balance is
    // identical under both arms, so only the event count separates a claim worth
    // nothing from a transfer of nothing.
    assert_eq!(d.balance(&a), before, "nothing moved");
    assert_eq!(
        emitted, 1,
        "one event — the claim. A transfer of zero would be a second"
    );
}

/// **I8, from the sequence a fuzz run produced — and it proves the contract right
/// rather than wrong.**
///
/// `fuzz_call_sequence` reported an I8 violation on this two-call sequence:
///
/// ```text
/// ops = [Deposit { who, amount }, RequestWithdraw { who, part: 23 }]
/// pause injected at index 0, i.e. before the deposit
/// ```
///
/// The withdrawal succeeded unpaused and failed paused, which looks exactly like
/// pause standing between someone and their money. It is not. **Pause legitimately
/// blocks `deposit`** — it is a deposit-side control — so in the paused run the
/// depositor never acquired shares, and a request for 23 % of nothing is refused
/// for having nothing to refuse. I8 is a claim about funds the contract *already
/// owes*; nothing was owed.
///
/// The harness's cross-run comparison is what is wrong, not the vault: it asserts
/// that any I8-set call succeeding unpaused must succeed paused, without accounting
/// for the state a legitimately-blocked deposit never created. Reported to DEV3,
/// whose file it is. **This test pins the behaviour the harness meant to check**:
/// with shares actually held, pause does not stand in the way.
#[test]
fn pause_does_not_block_a_withdrawal_of_shares_already_held() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.client().set_paused(&true);

    // Deposits are refused — that is the control working.
    assert_eq!(
        d.client().try_deposit(&a, &(10 * XLM)),
        Err(Ok(Error::Paused))
    );

    // The exit is not. This is I8: the money is already owed, and no admin switch
    // may stand between the holder and it.
    let before = d.balance(&a);
    let out = d.client().request_withdraw(&a, &(23 * XLM), &false);
    assert!(out > 0, "the paused vault still paid the exit");
    assert_eq!(d.balance(&a), before + out);
}

#[test]
fn a_withdrawal_of_nothing_is_refused_whether_or_not_the_vault_is_paused() {
    let d = deploy();
    let a = d.user(1_000 * XLM);

    // The other half of the same finding: with no shares, the refusal is identical
    // paused and unpaused. That symmetry is what shows the fuzz report was about
    // the missing deposit and not about the pause.
    let unpaused = d.client().try_request_withdraw(&a, &0, &false);
    d.client().set_paused(&true);
    let paused = d.client().try_request_withdraw(&a, &0, &false);
    assert_eq!(
        unpaused, paused,
        "pause changes nothing when nothing is owed"
    );
    assert!(unpaused.is_err());
}
