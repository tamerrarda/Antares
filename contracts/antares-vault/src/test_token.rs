//! §2.6 — the SEP-41 surface, and D-36's other half.
//!
//! The inflation regression could only be half-written in §2.4: the dead-shares
//! half needed no `burn`, and the attacker half does. It is here.

#![allow(clippy::inconsistent_digit_grouping)]

extern crate std;

use crate::errors::Error;
use crate::test_common::deploy;
use crate::types::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    Address, String,
};

const XLM: i128 = 1_0000000;

// ================================ metadata =====================================

#[test]
fn the_token_identifies_itself_per_instance() {
    let d = deploy();
    assert_eq!(
        d.client().decimals(),
        7,
        "matching XLM, so nothing rescales"
    );
    assert_eq!(
        d.client().name(),
        String::from_str(&d.env, "Antares XLM Vault Share")
    );
    assert_eq!(
        d.client().symbol(),
        String::from_str(&d.env, "aXLM-A"),
        "five concurrent vaults must not all display as aXLM (D-52)"
    );
}

// ================================ transfer =====================================

#[test]
fn shares_move_and_the_supply_does_not() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let b = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));
    let before = d.state().shares_outstanding;

    d.client().transfer(&a, &b, &(10 * XLM));

    assert_eq!(d.client().balance(&b), 10 * XLM);
    assert_eq!(d.client().balance(&a), 100 * XLM - DEAD_SHARES - 10 * XLM);
    assert_eq!(
        d.state().shares_outstanding,
        before,
        "a transfer moves a claim; it does not create or destroy one"
    );
}

/// §13: legal, and a no-op. The implementation reads once and writes once per
/// side, so it cannot double-credit.
#[test]
fn a_self_transfer_does_not_double_credit() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    let before = d.client().balance(&a);

    d.client().transfer(&a, &a, &(10 * XLM));

    assert_eq!(d.client().balance(&a), before);
}

/// §13: zero is a legal no-op for transfer, burn and approve, matching SAC
/// behaviour that wallets already assume. Negative is `InvalidAmount`.
#[test]
fn zero_is_legal_and_negative_is_not() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let b = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));

    d.client().transfer(&a, &b, &0);
    d.client().burn(&a, &0);
    d.client().approve(&a, &b, &0, &0);

    assert_eq!(
        d.client().try_transfer(&a, &b, &-1),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(d.client().try_burn(&a, &-1), Err(Ok(Error::InvalidAmount)));
    assert_eq!(
        d.client().try_approve(&a, &b, &-1, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn transferring_more_than_held_is_an_error_and_never_a_panic() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let b = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));

    assert_eq!(
        d.client().try_transfer(&a, &b, &(200 * XLM)),
        Err(Ok(Error::InsufficientBalance))
    );
}

/// The muxed destination credits the **underlying** address — storing
/// per-muxed-address balances would create an unbounded key space and break I5 —
/// and the multiplexing id rides in the event instead.
#[test]
fn a_muxed_destination_credits_the_underlying_address() {
    use soroban_sdk::testutils::MuxedAddress as _;
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    let muxed = soroban_sdk::MuxedAddress::generate(&d.env);
    let base = muxed.address();
    let muxed = soroban_sdk::MuxedAddress::new(&muxed, 7u64);

    d.client().transfer(&a, &muxed, &(5 * XLM));
    // Captured immediately: `events().all()` reports the **last invocation's**
    // events, so a `balance()` read in between would clear the view.
    let emitted = d.env.events().all().events().len();

    assert_eq!(d.client().balance(&base), 5 * XLM);
    assert_eq!(
        emitted, 1,
        "one transfer event, whatever shape the destination had"
    );
}

/// One `#[contractevent]` cannot produce two data formats, so the plain and muxed
/// destinations emit different structs under the **same** topic — the decision
/// §10 assigns to this phase.
#[test]
fn the_muxed_and_plain_transfer_events_differ_in_data_but_not_in_topic() {
    use soroban_sdk::testutils::MuxedAddress as _;
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    let plain = Address::generate(&d.env);
    d.client().transfer(&a, &plain, &XLM);
    let plain_event = d.env.events().all().events().to_vec();

    let muxed = soroban_sdk::MuxedAddress::generate(&d.env);
    let muxed = soroban_sdk::MuxedAddress::new(&muxed, 9u64);
    d.client().transfer(&a, &muxed, &XLM);
    let muxed_event = d.env.events().all().events().to_vec();

    assert_ne!(
        plain_event, muxed_event,
        "the muxed form must carry to_muxed_id; if these matched, the id was dropped"
    );
}

// =============================== allowances ====================================

#[test]
fn an_allowance_is_spent_down_and_refused_when_exhausted() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let spender = Address::generate(&d.env);
    let to = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));

    let until = d.env.ledger().sequence() + 1_000;
    d.client().approve(&a, &spender, &(20 * XLM), &until);
    assert_eq!(d.client().allowance(&a, &spender), 20 * XLM);

    d.client().transfer_from(&spender, &a, &to, &(15 * XLM));
    assert_eq!(d.client().allowance(&a, &spender), 5 * XLM);
    assert_eq!(d.client().balance(&to), 15 * XLM);

    assert_eq!(
        d.client().try_transfer_from(&spender, &a, &to, &(10 * XLM)),
        Err(Ok(Error::InsufficientAllowance))
    );
}

#[test]
fn an_expired_allowance_authorizes_nothing() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let spender = Address::generate(&d.env);
    let to = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));

    let until = d.env.ledger().sequence() + 10;
    d.client().approve(&a, &spender, &(20 * XLM), &until);

    d.env.ledger().set_sequence_number(until + 1);
    assert_eq!(d.client().allowance(&a, &spender), 0);
    assert_eq!(
        d.client().try_transfer_from(&spender, &a, &to, &XLM),
        Err(Ok(Error::InsufficientAllowance))
    );
}

#[test]
fn an_approval_in_the_past_or_past_the_ceiling_is_refused() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let spender = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));

    d.env.ledger().set_sequence_number(500);
    assert_eq!(
        d.client().try_approve(&a, &spender, &XLM, &499),
        Err(Ok(Error::InvalidAmount)),
        "an allowance that is already expired authorizes nothing"
    );

    let ceiling = d.env.as_contract(&d.vault, || d.env.storage().max_ttl());
    assert_eq!(
        d.client()
            .try_approve(&a, &spender, &XLM, &(500 + ceiling + 1)),
        Err(Ok(Error::InvalidAmount)),
        "and one beyond the network's ceiling cannot be stored at all"
    );
}

/// §13: `amount == 0` deletes the allowance, and the ledger argument is ignored.
#[test]
fn a_zero_approval_deletes_rather_than_stores() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let spender = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));

    d.client()
        .approve(&a, &spender, &(5 * XLM), &(d.env.ledger().sequence() + 100));
    d.client().approve(&a, &spender, &0, &0);

    assert_eq!(d.client().allowance(&a, &spender), 0);
    assert!(d
        .env
        .as_contract(&d.vault, || crate::storage::get_allowance(
            &d.env, &a, &spender
        ))
        .is_none());
}

// ================================== burn =======================================

#[test]
fn burning_lowers_the_supply_and_leaves_the_pool_alone() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    let before = d.state();

    d.client().burn(&a, &(10 * XLM));

    let after = d.state();
    assert_eq!(
        after.shares_outstanding,
        before.shares_outstanding - 10 * XLM
    );
    assert_eq!(
        after.locked_assets, before.locked_assets,
        "the pool is untouched — which is what raises pps for everyone else"
    );
    assert_eq!(
        after.burned_this_round, before.burned_this_round,
        "and it is not a withdrawal-queue exit, so burned_this_round does not move"
    );
}

#[test]
fn burn_from_spends_the_allowance() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let spender = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));

    let until = d.env.ledger().sequence() + 1_000;
    d.client().approve(&a, &spender, &(20 * XLM), &until);
    d.client().burn_from(&spender, &a, &(20 * XLM));

    assert_eq!(d.client().allowance(&a, &spender), 0);
    assert_eq!(
        d.client().try_burn_from(&spender, &a, &XLM),
        Err(Ok(Error::InsufficientAllowance))
    );
}

// =============== D-36's other half: the dead shares are unreachable ============

/// The contract's own shares have **no burn path and no transfer path**, by
/// anyone. That is half of D-36's inflation defence; the other half is that every
/// mint must produce at least one share.
#[test]
fn nobody_can_move_or_burn_the_contracts_own_shares() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let vault = d.vault.clone();
    d.client().deposit(&a, &(100 * XLM));

    assert_eq!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_shares(&d.env, &vault)),
        DEAD_SHARES
    );

    assert_eq!(
        d.client().try_burn(&vault, &DEAD_SHARES),
        Err(Ok(Error::InvalidAddress))
    );
    assert_eq!(
        d.client().try_transfer(&vault, &a, &DEAD_SHARES),
        Err(Ok(Error::InvalidAddress))
    );
    assert_eq!(
        d.client().try_approve(&vault, &a, &DEAD_SHARES, &1_000),
        Err(Ok(Error::InvalidAddress))
    );
    assert_eq!(
        d.client().try_transfer_from(&a, &vault, &a, &DEAD_SHARES),
        Err(Ok(Error::InvalidAddress))
    );

    // Nor can they be received, which would make the balance ambiguous.
    assert_eq!(
        d.client().try_transfer(&a, &vault, &XLM),
        Err(Ok(Error::InvalidAddress))
    );
}

/// **The inflation regression, completed.** 06-TEST-PLAN's form: deposit, burn
/// the attacker's *own entire balance* — the most supply anyone can remove, since
/// the contract's shares have no burn path — then assert supply never fell below
/// `DEAD_SHARES`, and that a subsequent small deposit either mints at least one
/// share or is rejected `ZeroShares`, **never absorbed silently**.
#[test]
fn the_inflation_attack_cannot_drive_the_supply_to_dust() {
    let d = deploy();
    let attacker = d.user(1_000 * XLM);
    d.client().deposit(&attacker, &(100 * XLM));

    let own = d.client().balance(&attacker);
    d.client().burn(&attacker, &own);

    let after = d.state();
    assert_eq!(
        after.shares_outstanding, DEAD_SHARES,
        "the floor holds: the most anyone can remove is their own balance"
    );
    assert_eq!(
        after.locked_assets,
        100 * XLM,
        "and the whole pool now backs 1 000 stroops of dead shares"
    );

    // pps is now enormous, so a small deposit rounds to zero shares. It must be
    // refused rather than absorbed — the attacker's whole gain would be the
    // difference.
    let victim = d.user(1_000 * XLM);
    let min = d.state().params.min_deposit;
    match d.client().try_deposit(&victim, &min) {
        Err(Ok(Error::ZeroShares)) => {}
        Ok(Ok(minted)) => assert!(
            minted >= 1,
            "a deposit must mint at least one share or be rejected, never be absorbed"
        ),
        other => panic!("unexpected: {other:?}"),
    }
}

// ================================ no lazy finalize =============================

/// §16: a token transfer must not carry epoch-finalization cost or emit epoch
/// events. Someone moving shares between two wallets is not interacting with the
/// protocol.
#[test]
fn a_token_call_does_not_finalize_a_lapsed_round() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    let b = Address::generate(&d.env);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 100);

    d.advance(200); // the auction is over and empty; any *vault* call would lapse it

    d.client().transfer(&a, &b, &XLM);

    assert_eq!(
        d.state().phase,
        Phase::Auction,
        "the token surface leaves the epoch alone"
    );
    assert!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_round(&d.env, 1))
            .is_none(),
        "and wrote no Round record"
    );
}

// ==================================== events ===================================

/// Every `mint` amount in the last invocation's stream, in order.
///
/// `Mint` is `data_format = "single-value"`, so the amount is the payload itself
/// rather than a field in a map — which is why this reads the value directly.
fn mint_amounts(env: &soroban_sdk::Env) -> std::vec::Vec<i128> {
    use soroban_sdk::xdr::{Int128Parts, ScSymbol, ScVal};
    let all = env.events().all();
    let evs = all.events();
    let mut out = std::vec::Vec::new();
    for e in evs.iter() {
        let soroban_sdk::xdr::ContractEventBody::V0(v0) = &e.body;
        let is_mint = v0
            .topics
            .first()
            .is_some_and(|t| matches!(t, ScVal::Symbol(ScSymbol(n)) if n.as_slice() == b"mint"));
        if is_mint {
            if let ScVal::I128(Int128Parts { hi, lo }) = &v0.data {
                out.push(((*hi as i128) << 64) | (*lo as i128));
            }
        }
    }
    out
}

/// §10: every mint and burn emits **both** its SEP-41 event and the vault event —
/// the SEP-41 stream is the token view, the vault stream is the protocol view.
#[test]
fn a_deposit_emits_both_streams() {
    let d = deploy();
    let a = d.user(1_000 * XLM);

    d.client().deposit(&a, &(100 * XLM));

    assert_eq!(
        d.env.events().all().events().len(),
        4,
        "two mints and `deposited` from us, plus the asset's own transfer — the XLM \
         really moved, and the SAC says so in its own stream. **Four, not three:** the \
         first deposit also mints the dead shares, and §13 says every mint emits."
    );

    // **The assertion that matters, and the one whose absence hid the defect.** An
    // indexer reading only the token stream reconstructs supply by summing mints.
    // Before the dead-share mint was emitted, that sum came out `DEAD_SHARES` short
    // of `shares_outstanding` — permanently, from the vault's first transaction —
    // and the only way to close it was to hard-code a constant no event confirms.
    // A count alone would not have caught it: three events was the *right* count for
    // a stream that was wrong.
    // Captured **once**, before anything else reads through the host: `events().all()`
    // reports the last invocation's events, and `d.state()` is an invocation. This
    // file's own header records that trap and I walked into it writing this test.
    let mints = mint_amounts(&d.env);
    assert_eq!(mints.len(), 2, "the depositor's, and the vault's");
    assert_eq!(
        mints.iter().sum::<i128>(),
        d.state().shares_outstanding,
        "the token stream's mints must sum to the supply they created"
    );
}

#[test]
fn an_instant_withdrawal_emits_the_burn_and_both_vault_events() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.client().request_withdraw(&a, &(10 * XLM), &true);

    assert_eq!(
        d.env.events().all().events().len(),
        4,
        "burn, withdraw_requested and withdraw_claimed from us, plus the asset's \
         transfer back out"
    );
}
