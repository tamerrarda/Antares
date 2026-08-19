//! `03-STORAGE-TTL.md` §1–§4 driven to pass *and* to reject.
//!
//! The guards in this module are not `if` statements that return errors — they
//! are invariants about what the storage layer may leave behind: a clamp that
//! must hold whatever the network does to `max_ttl`, a deletion rule that must
//! fire at exactly zero, an expiry that must read as absent, and a cross-bump
//! that must keep a round alive for as long as anything claims against it. Each
//! is tested by constructing the state where it would fail.

#![allow(clippy::inconsistent_digit_grouping)]

use crate::storage::*;
use crate::types::*;
use soroban_sdk::{
    // `get_ttl` lives on the testutils storage traits, not on `Persistent` itself —
    // TTL is observable in tests and opaque to the contract, which is the right way
    // round: the contract may only ever extend a TTL, never branch on one.
    testutils::{storage::Persistent as _, Address as _, Ledger, LedgerInfo},
    Address,
    Env,
    String,
};

// ------------------------------------------------------------------ fixtures ---

fn params() -> EpochParams {
    EpochParams {
        epoch_duration: 604_800,
        auction_duration: 2_700,
        min_idle_gap: 14_400,
        strike_bps_otm: 300,
        premium_start_bps: 450,
        premium_floor_bps: 40,
        twap_window: 900,
        guard_window: 3_600,
        max_staleness: 600,
        max_deviation_bps: 100,
        oracle_dead_after: 43_200,
        settle_grace: 7_200,
        unresolved_after: 75_600,
        min_fill: 100_0000000,
        min_deposit: 10_0000000,
        settle_bounty_bps: 25,
    }
}

fn config(env: &Env, addr: &Address) -> Config {
    Config {
        admin: addr.clone(),
        pending_admin: None,
        asset: addr.clone(),
        oracle: addr.clone(),
        fee_recipient: addr.clone(),
        token_suffix: String::from_str(env, "-A"),
        fee_bps: 0,
        deposit_cap: 100_000_0000000,
        paused: false,
        allowlist_enabled: true,
        allowlist_expires_at: 2_592_000,
        params: params(),
        rent_threshold: 120_960,
        rent_extend_to: 518_400,
    }
}

fn round_record() -> Round {
    Round {
        outcome: RoundOutcome::Settled,
        pps: PRECISION,
        strike: 1_630_000,
        expiry: 1_000,
        notional_sold: 100_0000000,
        premium: 1_0000000,
        fee: 0,
        settled_spot: 1_600_000,
        payout_total: 0,
    }
}

/// A registered contract, so storage calls have somewhere to live.
fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    let id = env.register(crate::AntaresVault, ());
    let user = Address::generate(&env);
    (env, id, user)
}

// -------------------------------------------------------------- round trips ---

#[test]
fn every_key_round_trips() {
    let (env, id, user) = setup();
    let other = Address::generate(&env);

    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_config(&env, &cfg);
        assert_eq!(get_config(&env), Some(cfg.clone()));

        set_app_version(&env, 7);
        assert_eq!(get_app_version(&env), 7);

        set_shares(&env, rent, &user, 500);
        assert_eq!(get_shares(&env, &user), 500);

        set_allowance(&env, rent, &user, &other, 42, env.ledger().sequence() + 100);
        assert_eq!(get_allowance_amount(&env, &user, &other), 42);

        let pd = PendingDeposit {
            round: 3,
            amount: 10_0000000,
        };
        set_pending_deposit(&env, rent, &user, &pd);
        assert_eq!(get_pending_deposit(&env, &user), Some(pd));

        let pw = PendingWithdraw {
            round: 3,
            shares: 250,
        };
        set_pending_withdraw(&env, rent, &user, &pw);
        assert_eq!(get_pending_withdraw(&env, &user), Some(pw));

        let r = round_record();
        set_round(&env, rent, 3, &r);
        assert_eq!(get_round(&env, 3), Some(r));

        let fill = Fill {
            notional: 100_0000000,
            premium_paid: 1_0000000,
            claimed: false,
        };
        set_fill(&env, rent, 3, &other, &fill);
        assert_eq!(get_fill(&env, 3, &other), Some(fill));

        set_allowed(&env, rent, &other, true);
        assert!(is_allowed(&env, &other));
    });
}

/// `get_state` is exercised separately because `State` is the largest struct and
/// the one every later section reads on its hot path.
#[test]
fn state_round_trips() {
    let (env, id, user) = setup();
    env.as_contract(&id, || {
        let state = State {
            round: 1,
            phase: Phase::Auction,
            params: params(),
            fee_bps_snapshot: 0,
            opened_at: 10,
            auction_end: 20,
            expiry: 30,
            feed_decimals: 14,
            strike: 1_630_000,
            open_twap: 1_580_000,
            notional_offered: 1,
            notional_sold: 2,
            premium_collected: 3,
            locked_at_open: 4,
            shares_snapshot: 5,
            burned_this_round: 6,
            locked_assets: 7,
            shares_outstanding: 8,
            last_pps: PRECISION,
            last_settled_spot: 0,
            last_finalize_time: 9,
            pending_deposits_total: 10,
            withdraw_claimable_total: 11,
            bidder_claimable_total: 12,
            fee_claimable: 13,
        };
        set_state(&env, &state);
        assert_eq!(get_state(&env), Some(state));
        let _ = user;
    });
}

// -------------------------------------------------------------- the clamp -----

/// §2 rule 1's whole point. The stored `rent_extend_to` is valid when set and the
/// network lowers `max_ttl` afterwards; the clamp has to absorb that without the
/// bump becoming a host error, because this bump runs on the unpausable exit path.
#[test]
fn rent_is_clamped_when_the_network_lowers_the_ceiling() {
    let (env, id, user) = setup();

    env.ledger().set(LedgerInfo {
        max_entry_ttl: 1_000,
        min_persistent_entry_ttl: 16,
        min_temp_entry_ttl: 16,
        ..env.ledger().get()
    });

    env.as_contract(&id, || {
        let cfg = config(&env, &user); // extend_to 518 400, threshold 120 960
        let rent = Rent::effective(&env, &cfg);

        assert!(
            rent.extend_to <= env.storage().max_ttl(),
            "extend_to must never exceed the live ceiling"
        );
        assert!(
            rent.threshold <= rent.extend_to,
            "extend_ttl is invalid with extend_to < threshold"
        );
        // Against the live ceiling, never a literal: `max_ttl()` reports 999 for a
        // `max_entry_ttl` of 1 000 — the TTL is a count of ledgers *ahead*, so the
        // ceiling is exclusive. Hardcoding 1 000 here tested the SDK's arithmetic
        // rather than the clamp, and got it wrong.
        assert_eq!(rent.extend_to, env.storage().max_ttl());
        assert_eq!(rent.threshold, env.storage().max_ttl());

        // The bump itself must go through — this is the line that would brick
        // `claim_withdraw` unclamped.
        set_config(&env, &cfg);
        bump_instance(&env, rent);
        set_shares(&env, rent, &user, 100);
        set_pending_withdraw(
            &env,
            rent,
            &user,
            &PendingWithdraw {
                round: 1,
                shares: 100,
            },
        );
    });
}

/// The unclamped values are the ones a naive implementation would pass. Asserting
/// they are *above* the ceiling is what makes the test above about the clamp
/// rather than about two numbers that happened to be small enough.
#[test]
fn the_unclamped_values_would_have_exceeded_the_ceiling() {
    let (env, id, user) = setup();
    env.ledger().set(LedgerInfo {
        max_entry_ttl: 1_000,
        ..env.ledger().get()
    });
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        assert!(cfg.rent_extend_to > env.storage().max_ttl());
        assert!(cfg.rent_threshold > env.storage().max_ttl());
    });
}

// --------------------------------------------------- terminal deletion (§3) ---

#[test]
fn shares_are_removed_at_exactly_zero_and_not_before() {
    let (env, id, user) = setup();
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_shares(&env, rent, &user, 1);
        assert!(env
            .storage()
            .persistent()
            .has(&DataKey::Shares(user.clone())));

        set_shares(&env, rent, &user, 0);
        assert!(
            !env.storage()
                .persistent()
                .has(&DataKey::Shares(user.clone())),
            "a zero balance must be removed, not stored — rent paid on nothing"
        );
        assert_eq!(get_shares(&env, &user), 0, "and it still reads as zero");
    });
}

#[test]
fn a_zero_approval_deletes_the_allowance() {
    let (env, id, user) = setup();
    let spender = Address::generate(&env);
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);
        let until = env.ledger().sequence() + 500;

        set_allowance(&env, rent, &user, &spender, 100, until);
        assert!(get_allowance(&env, &user, &spender).is_some());

        set_allowance(&env, rent, &user, &spender, 0, until);
        assert!(get_allowance(&env, &user, &spender).is_none());
        assert_eq!(get_allowance_amount(&env, &user, &spender), 0);
    });
}

#[test]
fn pending_entries_are_removed_on_their_terminal_transition() {
    let (env, id, user) = setup();
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_pending_deposit(
            &env,
            rent,
            &user,
            &PendingDeposit {
                round: 1,
                amount: 5,
            },
        );
        remove_pending_deposit(&env, &user);
        assert!(get_pending_deposit(&env, &user).is_none());

        set_pending_withdraw(
            &env,
            rent,
            &user,
            &PendingWithdraw {
                round: 1,
                shares: 5,
            },
        );
        remove_pending_withdraw(&env, &user);
        assert!(get_pending_withdraw(&env, &user).is_none());
    });
}

/// I7's storage half: this module offers no way to delete a round or a fill.
/// Asserted by construction — the functions do not exist — and pinned here so a
/// later edit that adds one has to delete this test on purpose.
#[test]
fn rounds_and_fills_survive_every_operation_this_module_offers() {
    let (env, id, user) = setup();
    let bidder = Address::generate(&env);
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);
        let r = round_record();

        set_round(&env, rent, 4, &r);
        set_fill(
            &env,
            rent,
            4,
            &bidder,
            &Fill {
                notional: 1,
                premium_paid: 1,
                claimed: false,
            },
        );

        set_shares(&env, rent, &user, 0);
        remove_pending_deposit(&env, &user);
        remove_pending_withdraw(&env, &user);
        remove_allowance(&env, &user, &bidder);
        set_allowed(&env, rent, &bidder, false);

        assert_eq!(get_round(&env, 4), Some(r));
        assert!(get_fill(&env, 4, &bidder).is_some());
    });
}

// ------------------------------------------------- allowance expiry (§13) -----

#[test]
fn an_expired_allowance_reads_as_absent() {
    let (env, id, user) = setup();
    let spender = Address::generate(&env);
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);
        let now = env.ledger().sequence();

        set_allowance(&env, rent, &user, &spender, 77, now + 10);
        assert_eq!(get_allowance_amount(&env, &user, &spender), 77);

        env.ledger().set_sequence_number(now + 10);
        assert_eq!(
            get_allowance_amount(&env, &user, &spender),
            77,
            "live_until_ledger is inclusive"
        );

        env.ledger().set_sequence_number(now + 11);
        assert_eq!(
            get_allowance_amount(&env, &user, &spender),
            0,
            "past live_until_ledger it reads as zero, however much is stored"
        );
        assert!(
            get_allowance(&env, &user, &spender).is_some(),
            "and the raw entry is still there — expiry is a read rule, not a delete"
        );
    });
}

// ------------------------------------------ rule 3: the round cross-bump ------

/// Miss this and `Round(r)` archives while claims against it are outstanding,
/// turning I7's "always reachable" into "eventually restorable".
#[test]
fn touching_a_claim_bumps_the_round_it_is_computed_from() {
    let (env, id, user) = setup();
    let bidder = Address::generate(&env);

    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_round(&env, rent, 2, &round_record());
        set_pending_withdraw(
            &env,
            rent,
            &user,
            &PendingWithdraw {
                round: 2,
                shares: 9,
            },
        );
        set_fill(
            &env,
            rent,
            2,
            &bidder,
            &Fill {
                notional: 1,
                premium_paid: 1,
                claimed: false,
            },
        );

        // The decay has to carry the entry *below* `threshold_eff`, because
        // `extend_ttl` is a no-op while the remaining TTL is still above it — see
        // `a_bump_above_the_threshold_is_a_no_op`. At 518 400 / 120 960 that means
        // shedding more than 397 440 ledgers; 5 000 left it at 513 400 and the
        // first version of this test asserted a bump that correctly never happened.
        let decay = 400_000;
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + decay);

        let before = env.storage().persistent().get_ttl(&DataKey::Round(2));

        assert!(touch_pending_withdraw(&env, rent, &user).is_some());
        let after_pw = env.storage().persistent().get_ttl(&DataKey::Round(2));
        assert!(
            after_pw > before,
            "touching PendingWithdraw must bump Round: {before} -> {after_pw}"
        );

        env.ledger()
            .set_sequence_number(env.ledger().sequence() + decay);
        let before_fill = env.storage().persistent().get_ttl(&DataKey::Round(2));
        assert!(touch_fill(&env, rent, 2, &bidder).is_some());
        let after_fill = env.storage().persistent().get_ttl(&DataKey::Round(2));
        assert!(
            after_fill > before_fill,
            "touching Fill must bump Round: {before_fill} -> {after_fill}"
        );
    });
}

/// A claim whose round was never written must not trap. First-time users have no
/// `PendingWithdraw`, and a bump of an absent key is a host error.
#[test]
fn bumping_a_claim_whose_round_is_absent_does_not_trap() {
    let (env, id, user) = setup();
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_pending_withdraw(
            &env,
            rent,
            &user,
            &PendingWithdraw {
                round: 99,
                shares: 1,
            },
        );
        assert!(touch_pending_withdraw(&env, rent, &user).is_some());
        assert!(touch_fill(&env, rent, 99, &user).is_none());
    });
}

// ------------------------------------------------------- allowlist (rule 4) ---

#[test]
fn checking_the_allowlist_bumps_only_a_present_entry() {
    let (env, id, user) = setup();
    let stranger = Address::generate(&env);
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_allowed(&env, rent, &user, true);
        assert!(check_allowed(&env, rent, &user));

        // A stranger is not on the list, and checking must not create or bump one.
        assert!(!check_allowed(&env, rent, &stranger));
        assert!(!env
            .storage()
            .persistent()
            .has(&DataKey::Allowed(stranger.clone())));

        // Revoking removes rather than storing `false`.
        set_allowed(&env, rent, &user, false);
        assert!(!env
            .storage()
            .persistent()
            .has(&DataKey::Allowed(user.clone())));
        assert!(!check_allowed(&env, rent, &user));
    });
}

/// `extend_ttl` does nothing while the remaining TTL is still above the
/// threshold, and that is the point of having a threshold: rent is paid to push
/// an entry back up only when it has actually decayed. Pinned because it is
/// surprising in the other direction — a reader may assume every touch bumps,
/// and two tests in this file were written on that assumption and failed.
#[test]
fn a_bump_above_the_threshold_is_a_no_op() {
    let (env, id, user) = setup();
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_round(&env, rent, 1, &round_record());
        let fresh = env.storage().persistent().get_ttl(&DataKey::Round(1));
        assert_eq!(fresh, rent.extend_to);

        // Well short of the threshold.
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 1_000);
        bump_round(&env, rent, 1);
        assert_eq!(
            env.storage().persistent().get_ttl(&DataKey::Round(1)),
            rent.extend_to - 1_000,
            "still above the threshold, so the bump is correctly inert"
        );

        // Past it.
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + rent.extend_to - rent.threshold);
        bump_round(&env, rent, 1);
        assert_eq!(
            env.storage().persistent().get_ttl(&DataKey::Round(1)),
            rent.extend_to,
            "below the threshold, so the bump restores the full extend_to"
        );
    });
}

// -------------------------------------------------------- restore_position ----

/// §4: deterministic recovery. Every key the user owns, and every round those
/// keys reference, comes back with fresh TTL — and the result does not depend on
/// which of them happen to exist.
#[test]
fn restore_position_refreshes_every_key_a_user_owns() {
    let (env, id, user) = setup();
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_round(&env, rent, 1, &round_record());
        set_round(&env, rent, 2, &round_record());
        set_shares(&env, rent, &user, 100);
        set_pending_deposit(
            &env,
            rent,
            &user,
            &PendingDeposit {
                round: 1,
                amount: 5,
            },
        );
        set_pending_withdraw(
            &env,
            rent,
            &user,
            &PendingWithdraw {
                round: 2,
                shares: 5,
            },
        );

        let decay = 400_000; // past `threshold_eff` — see the note above
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + decay);

        let keys = [
            DataKey::Shares(user.clone()),
            DataKey::PendingDeposit(user.clone()),
            DataKey::PendingWithdraw(user.clone()),
            DataKey::Round(1),
            DataKey::Round(2),
        ];
        let before: [u32; 5] =
            core::array::from_fn(|i| env.storage().persistent().get_ttl(&keys[i]));

        restore_position_keys(&env, rent, &user);

        for (i, key) in keys.iter().enumerate() {
            let after = env.storage().persistent().get_ttl(key);
            assert!(
                after > before[i],
                "restore_position must refresh every key it touches; index {i} went {} -> {after}",
                before[i]
            );
        }
    });
}

/// A user with nothing stored is the ordinary case for a maintenance sweep over
/// every address ever seen in a deposit event. It must be a no-op, not a trap.
#[test]
fn restore_position_on_an_empty_user_is_a_no_op() {
    let (env, id, _user) = setup();
    let stranger = Address::generate(&env);
    env.as_contract(&id, || {
        let cfg = config(&env, &stranger);
        let rent = Rent::effective(&env, &cfg);
        restore_position_keys(&env, rent, &stranger);
    });
}

// ------------------------------------------------------------ no temporary ----

/// Every key this module writes is readable from **persistent** storage.
///
/// Note what this test does *not* do: it never calls `.temporary()`, not even to
/// assert absence. 03-STORAGE-TTL §1 states the rule as "the absence of any
/// `temporary()` call in the codebase", and CI greps the whole of `contracts/`
/// with no test exemption — a test that reached for it to prove it is unused
/// would be the only thing making the grep fail. It would also prove nothing the
/// assertions below do not: a key readable from persistent storage is not in
/// temporary storage, and one written only to temporary would fail here first.
#[test]
fn everything_this_module_writes_is_persistent() {
    let (env, id, user) = setup();
    env.as_contract(&id, || {
        let cfg = config(&env, &user);
        let rent = Rent::effective(&env, &cfg);

        set_shares(&env, rent, &user, 1);
        set_pending_deposit(
            &env,
            rent,
            &user,
            &PendingDeposit {
                round: 1,
                amount: 1,
            },
        );
        set_pending_withdraw(
            &env,
            rent,
            &user,
            &PendingWithdraw {
                round: 1,
                shares: 1,
            },
        );
        set_round(&env, rent, 1, &round_record());
        set_allowed(&env, rent, &user, true);

        for key in [
            DataKey::Shares(user.clone()),
            DataKey::PendingDeposit(user.clone()),
            DataKey::PendingWithdraw(user.clone()),
            DataKey::Round(1),
            DataKey::Allowed(user.clone()),
        ] {
            assert!(
                env.storage().persistent().has(&key),
                "every value-bearing key must be persistent"
            );
        }
    });
}
