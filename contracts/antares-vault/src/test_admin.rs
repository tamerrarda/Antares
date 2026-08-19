//! §2.5b — the two setters this phase's own gate cannot be met without.
//!
//! The centrepiece is the gate's own requirement: **`supports_round`'s five
//! independently violable conditions driven to `false` through `set_epoch_params`
//! on a live vault**, one case each. Conditions 0 and 5 are excluded for two
//! different reasons — 5 is implied by 4 and can never be the sole cause of a
//! rejection, and 0 cannot be violated alone either. 04-ORACLE §2 records both as
//! redundant precisely so nobody reads them as coverage.
//!
//! Every case below keeps the vault's own §1 rules satisfied and violates exactly
//! one oracle condition, so the rejection is attributable. At the mock's default
//! `resolution() = 1` the reachable depth is 255 (D-69), which is what fixes the
//! arithmetic in each case.

#![allow(clippy::inconsistent_digit_grouping)]

use crate::errors::Error;
use crate::test_common::{deploy, valid_params};
use crate::types::*;
use soroban_sdk::testutils::{Address as _, Events as _};

const XLM: i128 = 1_0000000;

// ============================== the five conditions ============================

/// Condition 1: the windows must hold three and five distinct ticks —
/// `twap_window ≥ 2·res`, `guard_window ≥ 4·res`.
#[test]
fn condition_1_too_few_ticks_in_the_short_window() {
    let d = deploy();
    let mut p = valid_params();
    p.twap_window = 1; // below 2·res, while still leaving guard_window > twap_window
    assert_eq!(
        d.client().try_set_epoch_params(&p),
        Err(Ok(Error::InvalidParams))
    );
}

/// Condition 2: the **realized spans**, not the arguments. `guard_window >
/// twap_window` holds here and the spans still invert, which is the whole point
/// — the floors truncate the guard by up to `4·res` and the short by only
/// `2·res`, so the breaker can end up comparing two equal windows.
#[test]
fn condition_2_the_realized_spans_invert_while_the_arguments_look_fine() {
    let d = deploy();
    let mut p = valid_params();
    p.twap_window = 10; // short_step 5, short_span 10
    p.guard_window = 11; // guard_step 2, guard_span 8 — inverted, and 11 > 10
    assert!(
        p.guard_window > p.twap_window,
        "the vault's own rule is satisfied; only the realized spans fail"
    );
    assert_eq!(
        d.client().try_set_epoch_params(&p),
        Err(Ok(Error::InvalidParams))
    );
}

/// Condition 3: the evidence-free fallback must fire **strictly** after the
/// adapter gives up. At exactly `reach_limit` the two disagree for one second,
/// and that second is the property D-64 exists to guarantee.
#[test]
fn condition_3_the_fallback_does_not_fire_strictly_after_the_adapter_gives_up() {
    let d = deploy();
    let mut p = valid_params();
    p.unresolved_after = 235; // == reach_limit = 255 − guard_window(20)
    assert_eq!(
        d.client().try_set_epoch_params(&p),
        Err(Ok(Error::InvalidParams))
    );

    p.unresolved_after = 236;
    assert_eq!(d.client().try_set_epoch_params(&p), Ok(Ok(())));
}

/// Condition 4: `oracle_dead_after + guard_window + settle_grace < R`. This is
/// what bounds `guard_window < R` and therefore makes `reach_limit`'s
/// subtraction safe.
#[test]
fn condition_4_the_windows_do_not_fit_inside_the_reachable_depth() {
    let d = deploy();
    let mut p = valid_params();
    p.oracle_dead_after = 200;
    p.guard_window = 40;
    p.settle_grace = 20; // 200 + 40 + 20 = 260 ≥ 255
    p.unresolved_after = 240; // still above oracle_dead_after, so §1 is satisfied
    assert_eq!(
        d.client().try_set_epoch_params(&p),
        Err(Ok(Error::InvalidParams))
    );
}

/// Condition 6: the ceiling. Without it `unresolved_after` had a floor and no
/// roof, so this setter could push the oracle-free terminal path out until it
/// never fired — an admin disabling the one path that does not depend on the
/// oracle.
#[test]
fn condition_6_the_fallback_is_pushed_past_its_ceiling() {
    let d = deploy();
    let mut p = valid_params();
    p.unresolved_after = 246; // ceiling = reach_limit(235) + settle_grace(10)
    assert_eq!(
        d.client().try_set_epoch_params(&p),
        Err(Ok(Error::InvalidParams))
    );

    p.unresolved_after = 245;
    assert_eq!(d.client().try_set_epoch_params(&p), Ok(Ok(())));
}

/// All five, on a vault with a **live round** — which is the form the phase gate
/// asks for, and a different code path from the constructor's: the setter reads
/// the live feed at call time, long after the parameters were first validated.
#[test]
fn the_five_conditions_reject_on_a_live_vault_too() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    type Case = (&'static str, fn(&mut EpochParams));
    let cases: [Case; 5] = [
        ("1", |p| p.twap_window = 1),
        ("2", |p| {
            p.twap_window = 10;
            p.guard_window = 11;
        }),
        ("3", |p| p.unresolved_after = 235),
        ("4", |p| {
            p.oracle_dead_after = 200;
            p.guard_window = 40;
            p.settle_grace = 20;
        }),
        ("6", |p| p.unresolved_after = 246),
    ];

    for (name, mutate) in cases {
        let mut p = valid_params();
        mutate(&mut p);
        assert_eq!(
            d.client().try_set_epoch_params(&p),
            Err(Ok(Error::InvalidParams)),
            "condition {name} must reject through the setter on a live vault"
        );
    }

    assert_eq!(
        d.state().phase,
        Phase::Auction,
        "and none of them disturbed the live round"
    );
}

// ================================ next epoch only ==============================

/// §15: `Config.params` is the template for the next epoch, `State.params` is the
/// snapshot governing the live one. An admin who could shorten `min_idle_gap` and
/// open immediately would erase the guaranteed exit window (D-33).
#[test]
fn a_parameter_change_does_not_reach_the_live_round() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    let snapshot_before = d.state().params.clone();

    let mut p = valid_params();
    p.min_idle_gap = 2_400; // legal: ≥ epoch_duration / 50
    d.client().set_epoch_params(&p);

    assert_eq!(
        d.state().params,
        snapshot_before,
        "the live round's snapshot is untouched"
    );
    let cfg = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    assert_eq!(cfg.params.min_idle_gap, 2_400, "the template did change");
}

#[test]
fn setting_parameters_emits_the_whole_new_struct() {
    let d = deploy();
    let mut p = valid_params();
    p.max_staleness = 45;
    d.client().set_epoch_params(&p);

    assert_eq!(
        d.env.events().all().events().len(),
        1,
        "one event, carrying the whole new struct — an events-only indexer has no \
         prior copy to apply a delta to"
    );
}

// ===================================== pause ===================================

/// The guard needs a way to be switched on, or it has no rejecting test — which
/// is exactly why this setter is in Phase 2 rather than Phase 5.
#[test]
fn pause_blocks_exactly_what_it_should_and_unpause_restores_it() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));

    d.client().set_paused(&true);
    assert!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap())
            .paused
    );

    assert_eq!(
        d.client().try_deposit(&a, &(10 * XLM)),
        Err(Ok(Error::Paused))
    );

    // I8: nothing on the exit path notices.
    let paid = d.client().request_withdraw(&a, &(10 * XLM), &true);
    assert_eq!(paid, 10 * XLM);
    d.client().restore_position(&a);

    d.client().set_paused(&false);
    let minted = d.client().deposit(&a, &(10 * XLM));
    assert!(minted > 0, "and deposits work again");
}

#[test]
fn pausing_and_unpausing_emit_different_events() {
    let d = deploy();

    // `events().all()` reports the last invocation's events, not a running total —
    // which is also what makes the empty-log assertions on rejecting calls mean
    // what they say.
    d.client().set_paused(&true);
    let paused = d.env.events().all().events().to_vec();
    assert_eq!(paused.len(), 1);

    d.client().set_paused(&false);
    let unpaused = d.env.events().all().events().to_vec();
    assert_eq!(unpaused.len(), 1);

    assert_ne!(
        paused, unpaused,
        "two topics, not one event with a flag — an indexer filtering for 'paused' \
         must not have to read the data to discover it was the unpause"
    );
}

// ====================================== auth ===================================

/// Authorization failures surface as Soroban auth errors, never as a contract
/// error code (§3). Tested by removing the mocked auth rather than by asserting
/// an error variant that does not exist.
#[test]
#[should_panic(expected = "Unauthorized")]
fn a_non_admin_cannot_change_the_parameters() {
    let d = deploy();
    d.env.set_auths(&[]);
    d.client().set_epoch_params(&valid_params());
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn a_non_admin_cannot_pause() {
    let d = deploy();
    d.env.set_auths(&[]);
    d.client().set_paused(&true);
}

// ============================ the two fee setters ==============================
//
// Landed in Phase 2 rather than Phases 4 and 5, for the reason the roadmap gives
// for `set_epoch_params`: a gate that needs a later phase's code is not a gate,
// and one level down, **a test that needs a later phase's code is not a test.**
// DEV2's D-39 case changes the fee mid-round and asserts settlement uses the
// snapshot; without the real setter it would have to write `Config` directly and
// would then not be testing the setter's own promise not to touch the snapshot.

#[test]
fn the_fee_is_capped_at_twenty_percent() {
    let d = deploy();
    assert_eq!(
        d.client().try_set_fee_bps(&2_001),
        Err(Ok(Error::InvalidParams))
    );
    assert_eq!(
        d.client().try_set_fee_bps(&2_000),
        Ok(Ok(())),
        "the cap itself is admissible"
    );
    assert_eq!(
        d.client().try_set_fee_bps(&0),
        Ok(Ok(())),
        "and it ships at zero"
    );
}

/// D-39's own promise, asserted on the setter rather than on settlement: changing
/// the fee mid-round must not reach the round a bidder already paid into.
#[test]
fn a_fee_change_does_not_reach_the_live_rounds_snapshot() {
    let d = deploy();
    let a = d.user(1_000 * XLM);
    d.client().deposit(&a, &(100 * XLM));
    d.open_round_manually(1, Phase::Auction, d.env.ledger().timestamp() + 1_000);

    let snapshot_before = d.state().fee_bps_snapshot;
    d.client().set_fee_bps(&500);

    assert_eq!(
        d.state().fee_bps_snapshot,
        snapshot_before,
        "settlement reads the snapshot, and the setter must not be able to move it"
    );
    let cfg = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    assert_eq!(cfg.fee_bps, 500, "the template did change");
}

#[test]
fn the_fee_recipient_may_not_be_the_vault_itself() {
    let d = deploy();
    let vault = d.vault.clone();
    assert_eq!(
        d.client().try_set_fee_recipient(&vault),
        Err(Ok(Error::InvalidAddress)),
        "claim_fee would then be a transfer to self — it succeeds while moving nothing, \
         and the counter would already be decremented"
    );
}

/// Repointing the fee is not a payment: an accrued fee belongs to the protocol,
/// not to whoever happened to be named when it accrued.
#[test]
fn repointing_the_fee_moves_no_money() {
    let d = deploy();
    let next = soroban_sdk::Address::generate(&d.env);

    d.env.as_contract(&d.vault, || {
        let mut st = crate::storage::get_state(&d.env).unwrap();
        st.fee_claimable = 7 * XLM;
        crate::storage::set_state(&d.env, &st);
    });

    d.client().set_fee_recipient(&next);

    assert_eq!(
        d.state().fee_claimable,
        7 * XLM,
        "the accrual is untouched by the pointer moving"
    );
    let cfg = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    assert_eq!(cfg.fee_recipient, next);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn a_non_admin_cannot_change_the_fee() {
    let d = deploy();
    d.env.set_auths(&[]);
    d.client().set_fee_bps(&100);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn a_non_admin_cannot_repoint_the_fee() {
    let d = deploy();
    let next = soroban_sdk::Address::generate(&d.env);
    d.env.set_auths(&[]);
    d.client().set_fee_recipient(&next);
}
