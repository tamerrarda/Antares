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
