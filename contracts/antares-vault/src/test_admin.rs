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

// ============================== the allowlist ==================================
//
// Phase 3 rather than Phase 5, because DEV3's `bid` allowlist tests need them and
// so does 06-TEST-PLAN's D-63 case: **re-enabling the allowlist after
// `allowlist_expires_at` must be inert**, and that is a rule you cannot test
// without a setter that tries.
//
// **D-63's rule has two halves and they are in two files.** The half here is that
// the call stays *legal* past the expiry rather than being rejected — §4 chose
// that deliberately, because code refusing a call that already does nothing is
// the worse trade and would invite the reading that the gate is still live. The
// other half is that `bid` ignores the flag past the expiry, and that lives with
// `bid`. **DEV3: the second assertion is yours, and neither half is the rule on
// its own** — mine could pass with a gate that never expired, and yours could
// pass with a setter that refused.

#[test]
fn the_allowlist_toggles_and_each_direction_is_its_own_event() {
    let d = deploy();

    d.client().set_allowlist_enabled(&false);
    let off = d.env.events().all().events().to_vec();
    assert!(
        !d.env
            .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap())
            .allowlist_enabled
    );

    d.client().set_allowlist_enabled(&true);
    let on = d.env.events().all().events().to_vec();
    assert_ne!(off, on, "the two directions must be distinguishable");
}

/// D-63, this side of it: past the expiry the setter is **inert, not forbidden**.
/// The gate that can end this project cannot be frozen by inaction, and it also
/// cannot be re-closed by an admin who changed their mind.
#[test]
fn re_enabling_the_allowlist_after_the_expiry_is_legal_and_changes_nothing_that_matters() {
    let d = deploy();
    let expiry = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap())
        .allowlist_expires_at;

    d.client().set_allowlist_enabled(&false);
    d.advance(expiry + 1_000);

    // Legal. It writes the flag and says so, and there is no error for it.
    d.client().set_allowlist_enabled(&true);
    let cfg = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    assert!(cfg.allowlist_enabled, "the flag is set");
    assert!(
        d.env.ledger().timestamp() > cfg.allowlist_expires_at,
        "and the expiry has passed, so `bid` reads the gate as open regardless — \
         which is DEV3's assertion to make, not one this file can reach"
    );

    // The third leg — that nothing can move the expiry back — is **not asserted
    // here, because it is not assertable here.** It is the absence of a setter,
    // and a test cannot observe a function that was never written. My first draft
    // did try: a `SURFACE_HAS_EXPIRY_SETTER: bool = false` const and an assert
    // that it was false. That is a test that cannot fail, which is this project's
    // signature bug wearing my own initials. The real invariant is that
    // `allowlist_expires_at` is written once, in `__constructor`, and that *is*
    // checkable — CI's `write-once-fields` job greps for any other assignment and
    // fails on it. If you are reading this because that job fired, D-63 is what
    // it is defending.
}

#[test]
fn a_bidder_is_added_and_revoking_removes_the_entry_rather_than_storing_false() {
    let d = deploy();
    let bidder = soroban_sdk::Address::generate(&d.env);

    d.client().set_allowed(&bidder, &true);
    assert!(d
        .env
        .as_contract(&d.vault, || crate::storage::is_allowed(&d.env, &bidder)));

    d.client().set_allowed(&bidder, &false);
    assert!(!d
        .env
        .as_contract(&d.vault, || crate::storage::is_allowed(&d.env, &bidder)));
    assert!(
        !d.env.as_contract(&d.vault, || d
            .env
            .storage()
            .persistent()
            .has(&crate::storage::DataKey::Allowed(bidder.clone()))),
        "revoked and never-allowed are one state, so they cost the same rent and \
         cannot disagree"
    );
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn a_non_admin_cannot_toggle_the_allowlist() {
    let d = deploy();
    d.env.set_auths(&[]);
    d.client().set_allowlist_enabled(&false);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn a_non_admin_cannot_allow_a_bidder() {
    let d = deploy();
    let bidder = soroban_sdk::Address::generate(&d.env);
    d.env.set_auths(&[]);
    d.client().set_allowed(&bidder, &true);
}

// ===================== Phase 5 — the rest of the admin surface ==================
//
// Six entry points and six events, and one gate item that cannot be met here.
//
// **`upgrade`'s happy path is not tested natively and that is a limitation, not an
// omission.** `update_current_contract_wasm` needs a hash the host has actually
// seen, so a native test would have to `include_bytes!` a built wasm — which does
// not exist on a clean `cargo test`, and cannot be guarded by a feature because
// D-50 bans conditional compilation outside `#[cfg(test)]`. 06-TEST-PLAN §7.5
// already assigns the real drill to testnet: deploy v-current, state in place,
// upgrade to a marker build, migrate. **DEV1.md's Phase-5 gate asks for "state
// preserved across an upgrade from a committed snapshot" and that wording cannot be
// satisfied in this crate** — raised rather than faked with a test that swaps
// nothing and asserts nothing moved.

fn other(d: &crate::test_common::Deployed) -> soroban_sdk::Address {
    soroban_sdk::Address::generate(&d.env)
}

#[test]
fn every_admin_entry_point_rejects_a_non_admin() {
    // One list, driven twice: the point is not that each rejects, it is that
    // **none of them was forgotten**. A setter added without a line here is a
    // setter whose auth nobody checked, which is how an admin surface grows a hole.
    let names: &[&str] = &[
        "set_epoch_params",
        "set_paused",
        "set_fee_bps",
        "set_fee_recipient",
        "set_allowlist_enabled",
        "set_allowed",
        "set_deposit_cap",
        "set_rent_params",
        "transfer_admin",
        "upgrade",
        "migrate",
    ];
    assert_eq!(
        names.len(),
        11,
        "eleven admin-authorised entry points; `accept_admin` is the twelfth and is \
         authorised by the *pending* admin, so it is tested separately below"
    );

    for name in names {
        let d = deploy();
        d.env.set_auths(&[]);
        let a = other(&d);
        let r = match *name {
            "set_epoch_params" => d.client().try_set_epoch_params(&valid_params()).is_err(),
            "set_paused" => d.client().try_set_paused(&true).is_err(),
            "set_fee_bps" => d.client().try_set_fee_bps(&10).is_err(),
            "set_fee_recipient" => d.client().try_set_fee_recipient(&a).is_err(),
            "set_allowlist_enabled" => d.client().try_set_allowlist_enabled(&false).is_err(),
            "set_allowed" => d.client().try_set_allowed(&a, &true).is_err(),
            "set_deposit_cap" => d.client().try_set_deposit_cap(&(1_000 * XLM)).is_err(),
            "set_rent_params" => d.client().try_set_rent_params(&100, &200).is_err(),
            "transfer_admin" => d.client().try_transfer_admin(&a).is_err(),
            "upgrade" => d
                .client()
                .try_upgrade(&soroban_sdk::BytesN::from_array(&d.env, &[7u8; 32]))
                .is_err(),
            "migrate" => d.client().try_migrate(&2).is_err(),
            _ => unreachable!(),
        };
        assert!(r, "{name} accepted a call with no admin authorisation");
    }
}

#[test]
fn the_deposit_cap_may_sit_below_the_current_total_but_never_below_min_deposit() {
    let d = deploy();
    let user = d.user(1_000 * XLM);
    d.client().deposit(&user, &(100 * XLM));

    // Below what is already in: legal, and it blocks new deposits without touching
    // a stroop of the old ones — which is the whole reason a cap is not a limit.
    // 50 XLM: below the 100 already deposited, and still above `min_deposit`. The
    // first draft used 1 XLM and was refused — correctly, since that is below
    // `min_deposit` too, and the two conditions are separate rules that a single
    // badly-chosen number conflates.
    d.client().set_deposit_cap(&(50 * XLM));
    assert_eq!(
        d.state().locked_assets,
        100 * XLM,
        "nothing was clawed back"
    );

    // Zero is uncapped, not closed (§16).
    d.client().set_deposit_cap(&0);

    // Non-zero below `min_deposit` is the state where every deposit is at once too
    // small and too large. The pair lives in two structs behind two setters, so the
    // constructor's rule has to be re-asserted here or it holds only on day one.
    let min = valid_params().min_deposit;

    // **The accepted bound, and it was unpinned until DEV2's mutation run said so.**
    // `admin.rs`'s `<` widened to `<=` survived: both existing assertions below sit
    // *under* the boundary, so nothing observed that `cap == min_deposit` is legal.
    // The code's own comment says a non-zero cap must **clear** `min_deposit`, and
    // clearing includes reaching — a vault that accepts exactly one minimum deposit
    // and no more is legitimate, and the mutant made it unconfigurable.
    //
    // This is my own finding from `vault.rs` repeating in my own module, from the
    // other side: there the unpinned value was the largest accepted, here it is the
    // smallest. **Assertion written and run by DEV2, who reverted it on the
    // ownership line and left it copy-pasteable in the standup.**
    assert_eq!(
        d.client().try_set_deposit_cap(&min),
        Ok(Ok(())),
        "a cap of exactly min_deposit is admissible; `<` is the bound and `<=` would \
         forbid the smallest vault that can take a deposit at all"
    );

    assert_eq!(
        d.client().try_set_deposit_cap(&(min - 1)),
        Err(Ok(Error::InvalidParams))
    );
    assert_eq!(
        d.client().try_set_deposit_cap(&-1),
        Err(Ok(Error::InvalidParams))
    );
}

#[test]
fn rent_params_are_validated_the_same_way_the_constructor_validates_them() {
    let d = deploy();
    let ceiling = d.env.as_contract(&d.vault, || d.env.storage().max_ttl());

    d.client().set_rent_params(&100, &200);
    let cfg = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    assert_eq!((cfg.rent_threshold, cfg.rent_extend_to), (100, 200));

    for (t, e, why) in [
        (0u32, 200u32, "a zero threshold never triggers a bump"),
        (200, 200, "threshold == extend_to leaves no window"),
        (300, 200, "threshold above the window is unorderable"),
        (
            100,
            ceiling + 1,
            "above the live ceiling bricks every mutating call",
        ),
    ] {
        assert_eq!(
            d.client().try_set_rent_params(&t, &e),
            Err(Ok(Error::InvalidParams)),
            "{why}"
        );
    }
}

#[test]
fn the_admin_transfer_takes_two_steps_and_the_second_one_is_the_feature() {
    let d = deploy();
    let heir = other(&d);

    d.client().transfer_admin(&heir);
    let cfg = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    assert_eq!(
        cfg.pending_admin,
        Some(heir.clone()),
        "recorded, not applied"
    );
    assert_ne!(cfg.admin, heir, "and the role has not moved yet");

    // A change of mind overwrites rather than needing a third call to undo.
    let heir2 = other(&d);
    d.client().transfer_admin(&heir2);
    assert_eq!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap())
            .pending_admin,
        Some(heir2.clone())
    );

    d.client().accept_admin();
    let cfg = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    assert_eq!(cfg.admin, heir2, "the role moved on acceptance");
    assert_eq!(cfg.pending_admin, None, "and the pending slot is cleared");
}

#[test]
fn accepting_a_transfer_that_was_never_started_says_so() {
    let d = deploy();
    // `NoPendingAdmin`, not `Unauthorized`: the caller may well hold a key, and the
    // accurate answer is that there is nothing to accept.
    assert_eq!(
        d.client().try_accept_admin(),
        Err(Ok(Error::NoPendingAdmin))
    );
}

#[test]
fn the_contract_cannot_be_nominated_as_its_own_admin() {
    let d = deploy();
    // §11. It is the one address that could accept and then be unable to act.
    assert_eq!(
        d.client().try_transfer_admin(&d.vault),
        Err(Ok(Error::InvalidAddress))
    );
}

#[test]
fn migrate_rejects_every_version_because_v1_defines_no_target() {
    let d = deploy();
    let before = d
        .env
        .as_contract(&d.vault, || crate::storage::get_app_version(&d.env));

    // Wrong target: the order guard, which is also the idempotence guard.
    assert_eq!(
        d.client().try_migrate(&(before + 2)),
        Err(Ok(Error::MigrationOrder))
    );
    assert_eq!(
        d.client().try_migrate(&before),
        Err(Ok(Error::MigrationOrder))
    );

    // Right target, and still an error: returning `Ok` would advance the schema
    // version to a shape nobody wrote a migration for (§14).
    assert_eq!(
        d.client().try_migrate(&(before + 1)),
        Err(Ok(Error::MigrationOrder))
    );

    assert_eq!(
        d.env
            .as_contract(&d.vault, || crate::storage::get_app_version(&d.env)),
        before,
        "no path through migrate may move the schema version in v1"
    );
}

#[test]
fn the_config_view_reports_the_accrued_fee() {
    let d = deploy();
    // The Phase-5 addition, and the reason it could not wait: after §12 freezes, a
    // non-zero fee would be readable only from `fee_accrued`, which leaves the RPC
    // window in about seven days.
    assert_eq!(d.client().config().fee_claimable, 0);

    d.env.as_contract(&d.vault, || {
        let mut s = crate::storage::get_state(&d.env).unwrap();
        s.fee_claimable = 42;
        crate::storage::set_state(&d.env, &s);
    });
    assert_eq!(d.client().config().fee_claimable, 42);
}
// ============================ upgrade, for real ================================
//
// **I said this could not be tested natively and I was wrong.** The claim was that
// `update_current_contract_wasm` needs a hash the host has seen, so a test would
// have to `include_bytes!` a built wasm that does not exist on a clean
// `cargo test`. The first half is true; the second does not follow. The host
// validates one thing before accepting an upload — a `contractenvmetav0` custom
// section carrying an interface version — and that is thirty bytes a test can
// build. Nothing here reads the filesystem and nothing depends on a build step.
//
// The version is declared as protocol 21 with `pre_release: 0` deliberately: the
// host accepts an interface **older** than the ledger's as long as its pre-release
// is zero, so this stays valid as protocols rise rather than needing a bump.

fn upgradeable_wasm(env: &soroban_sdk::Env) -> soroban_sdk::Bytes {
    use soroban_sdk::xdr::{Limits, ScEnvMetaEntry, ScEnvMetaEntryInterfaceVersion, WriteXdr};
    let meta = ScEnvMetaEntry::ScEnvMetaKindInterfaceVersion(ScEnvMetaEntryInterfaceVersion {
        protocol: 21,
        pre_release: 0,
    });
    let xdr = meta.to_xdr(Limits::none()).unwrap();
    let name: &[u8] = b"contractenvmetav0";

    // `\0asm` + version 1, then one custom section: id 0, length, name, payload.
    let mut w =
        soroban_sdk::Bytes::from_array(env, &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    w.push_back(0x00);
    w.push_back((1 + name.len() + xdr.len()) as u8);
    w.push_back(name.len() as u8);
    w.append(&soroban_sdk::Bytes::from_slice(env, name));
    w.append(&soroban_sdk::Bytes::from_slice(env, &xdr));
    w
}

/// **The assertion the gate actually names, and the one worth building first.**
///
/// Happy path and idempotence are properties of the entry point. *State
/// preservation is a property of the storage schema* — which is the thing an
/// upgrade can break and the thing `migrate` exists to repair. Until this ran,
/// D-13's upgradeability claim rested on the code compiling.
///
/// Three storage classes are checked because an upgrade could plausibly affect
/// them differently: instance (`Config`, `State`, `AppVersion`), persistent
/// per-key (`Round`), and the share ledger.
#[test]
fn a_position_a_round_and_the_app_version_all_survive_an_upgrade() {
    let d = deploy();
    let user = d.user(1_000 * XLM);
    d.client().deposit(&user, &(100 * XLM));

    // A finalized round, written directly: how it got there is not what is under
    // test, and `Round` is the per-key persistent class an instance-storage
    // migration would not touch.
    let record = Round {
        outcome: RoundOutcome::Lapsed,
        pps: PRECISION,
        strike: 42,
        expiry: 7,
        notional_sold: 0,
        premium: 0,
        fee: 0,
        settled_spot: 0,
        payout_total: 0,
    };
    d.env.as_contract(&d.vault, || {
        let rent = crate::storage::Rent {
            threshold: 100,
            extend_to: 200,
        };
        crate::storage::set_round(&d.env, rent, 1, &record);
        crate::storage::set_app_version(&d.env, 1);
    });

    let before_config = d
        .env
        .as_contract(&d.vault, || crate::storage::get_config(&d.env).unwrap());
    let before_state = d.state();
    let before_shares = d
        .env
        .as_contract(&d.vault, || crate::storage::get_shares(&d.env, &user));
    let before_version = d
        .env
        .as_contract(&d.vault, || crate::storage::get_app_version(&d.env));

    let hash = d
        .env
        .deployer()
        .upload_contract_wasm(upgradeable_wasm(&d.env));
    d.client().upgrade(&hash);

    // Read through the host rather than through the contract: the code has been
    // replaced, so the vault's own views are gone. Storage is what the claim is
    // about, and storage is what is read.
    d.env.as_contract(&d.vault, || {
        assert_eq!(
            crate::storage::get_config(&d.env).unwrap(),
            before_config,
            "Config did not survive the swap"
        );
        assert_eq!(
            crate::storage::get_state(&d.env).unwrap(),
            before_state,
            "State did not survive the swap"
        );
        assert_eq!(
            crate::storage::get_round(&d.env, 1),
            Some(record),
            "a finalized round is immutable (I7) and an upgrade is not an exception"
        );
        assert_eq!(
            crate::storage::get_shares(&d.env, &user),
            before_shares,
            "the depositor's position did not survive"
        );
        assert_eq!(
            crate::storage::get_app_version(&d.env),
            before_version,
            "`upgrade` must not move the schema version — only `migrate` does (§14)"
        );
    });
    assert!(
        before_shares > 0,
        "the position must be non-trivial to prove anything"
    );
}

/// **The swap is real, and this is the assertion that proves it.**
///
/// I set out to write an idempotence test — upgrade twice with the same hash — and
/// it failed, for a reason worth keeping rather than papering over: **after the
/// first upgrade the contract's code *is* the new wasm**, which exports nothing, so
/// the second call cannot reach `upgrade` at all. `upgrade` therefore has no
/// idempotence to test across a real swap; the second call runs different code by
/// definition. The gate's idempotence belongs to `migrate`, whose order guard is
/// exactly that and is driven in three directions below.
///
/// What the failure exposed is better than what it replaced. Nothing else here
/// proves the code was actually replaced rather than the call being a silent no-op
/// — and a no-op `upgrade` that returned `Ok` and emitted `upgraded` would pass
/// every other test in this file.
#[test]
#[should_panic]
fn upgrade_really_replaces_the_code_so_the_old_surface_is_gone() {
    let d = deploy();
    let hash = d
        .env
        .deployer()
        .upload_contract_wasm(upgradeable_wasm(&d.env));

    d.client().upgrade(&hash);
    // The storage survived — the test above proves that. The *code* did not, and
    // reaching for any entry point now is what demonstrates the swap happened.
    let _ = d.client().config();
}

#[test]
#[should_panic]
fn upgrading_to_a_hash_nobody_uploaded_fails() {
    let d = deploy();
    // The failure path. A typo'd hash must not silently succeed and leave the
    // contract pointing at nothing.
    d.client()
        .upgrade(&soroban_sdk::BytesN::from_array(&d.env, &[9u8; 32]));
}
