//! The admin surface — `02-CONTRACT-SPEC.md` §4.
//!
//! Only two setters live here in Phase 2, and the split is forced by this phase's
//! own gate rather than by taste. `set_epoch_params` is needed because the gate
//! requires driving `supports_round`'s conditions 1, 2, 3, 4 and 6 to `false`
//! **through a setter on a live vault**, which cannot be done if the setter does
//! not exist; `set_paused` is needed because the pause check sits in §16's
//! canonical order on every mutating function written in this phase, and a guard
//! with no way to switch it on is a guard with no rejecting test.
//!
//! `validate_params` is deliberately **not** here. It is what bounds
//! `set_epoch_params`, so it lives in `vault.rs` and carries that module's
//! 0-MISSED mutation bar rather than admin's ≤5 % (06-TEST-PLAN §6).
//!
//! What the admin can never do — move user funds, mint shares, alter a finalized
//! `Round`, settle at a chosen price, or block the unpausable set — is structural
//! here rather than policy: no such code path exists in this file or any other.

use soroban_sdk::{contractimpl, Address, BytesN, Env};

use crate::errors::Error;
use crate::events::{
    AdminChanged, AdminTransferStarted, AllowedChanged, AllowlistToggled, CapChanged, FeeChanged,
    FeeRecipientChanged, Migrated, ParamsChanged, Paused, RentParamsChanged, Unpaused, Upgraded,
};
use crate::storage;
use crate::types::EpochParams;
use crate::vault::{enter, validate_params, validate_rent};
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

#[contractimpl]
impl AntaresVault {
    /// Replace the parameters for the **next** epoch. The live round is untouched.
    pub fn set_epoch_params(env: Env, params: EpochParams) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        // The same validation the constructor runs, against the same live feed —
        // and with `round_span = 0`, so condition 7 is skipped. Sponsorship is a
        // liveness fact that must not block a parameter repair: checking the
        // feed's runway here would stop an admin lowering `unresolved_after` to
        // recover from exactly the shortfall that triggered it (D-68).
        validate_params(&env, &ctx.config.oracle, &params, ctx.config.deposit_cap)?;

        // `Config.params` only. `State.params` is the snapshot governing the live
        // round and is written at `open_epoch` — §15's whole point is that a
        // change cannot reach a round somebody has already committed money to.
        ctx.config.params = params.clone();
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        ParamsChanged { params }.publish(&env);
        Ok(())
    }

    /// Stop new risk entering. Never stops anything leaving (I8).
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        ctx.config.paused = paused;
        let by = ctx.config.admin.clone();
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        // Two events rather than one with a flag, because §10 makes them two
        // topics: an indexer filtering for "the vault was paused" should not have
        // to read the data to find out it was the unpause.
        if paused {
            Paused { by }.publish(&env);
        } else {
            Unpaused { by }.publish(&env);
        }
        Ok(())
    }

    /// Set the protocol fee, in basis points of premium. Takes effect next epoch.
    pub fn set_fee_bps(env: Env, bps: u32) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        // Capped at 20 % by validation (D-39, §16). An unbounded fee setter is an
        // admin power over money already committed — the same shape as the
        // uncapped bounty D-51 removed, and refused for the same reason.
        if bps > MAX_FEE_BPS {
            return Err(Error::InvalidParams);
        }

        // `Config` only. Settlement reads `State.fee_bps_snapshot`, taken at open,
        // so this cannot reach a round a bidder has already paid into — which is
        // the whole of D-39 and the thing its test asserts.
        let old = ctx.config.fee_bps;
        ctx.config.fee_bps = bps;
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        FeeChanged { old, new: bps }.publish(&env);
        Ok(())
    }

    /// Point the accrued fee at a different address. Moves no money.
    pub fn set_fee_recipient(env: Env, recipient: Address) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        // §11. The contract's own address would make `claim_fee` a transfer to
        // self — which succeeds while moving nothing, and would strand the
        // accrued fee with the counter already decremented.
        if recipient == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }

        // Deliberately does not touch `fee_claimable`: an accrued fee belongs to
        // the protocol, not to whoever happened to be named when it accrued, and
        // moving the pointer is not a payment.
        let old = ctx.config.fee_recipient.clone();
        ctx.config.fee_recipient = recipient.clone();
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        FeeRecipientChanged {
            old,
            new: recipient,
        }
        .publish(&env);
        Ok(())
    }

    // Inert past `allowlist_expires_at`, and by construction rather than by a
    // check. `bid` gates on `allowlist_enabled && now < allowlist_expires_at`, so
    // once the timestamp passes there is nothing this setter can do to close the
    // vault again — which is what makes the permissionless path a property rather
    // than an operational promise (D-63). §4 keeps the call *legal* past the
    // expiry rather than rejecting it: code to refuse a call that already does
    // nothing is the worse trade, and it would invite the reading that the gate is
    // still live.
    //
    // The reasoning is a `//` and the doc line is one line, per D-70 — which I
    // wrote and then broke here on the first function after it. The eight-line
    // `///` this replaces cost 516 bytes of the 1 021 this setter measured.
    /// Turn the bidder allowlist on or off. Inert once the expiry has passed.
    pub fn set_allowlist_enabled(env: Env, enabled: bool) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        ctx.config.allowlist_enabled = enabled;
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        AllowlistToggled { enabled }.publish(&env);
        Ok(())
    }

    // Writes `Allowed(bidder)`, which `bid` reads and bumps on check (03-STORAGE-TTL
    // §2 rule 4). Revoking removes the entry rather than storing `false`, so a
    // never-allowed bidder and a revoked one are the same state and cost the same
    // rent — there is no third answer for the allowlist to disagree with itself
    // about.
    //
    // No §11 address check: `bid` already refuses the contract's own address, so
    // allowlisting it would be inert, and a second guard for an unreachable case
    // is surface without a rejection behind it.
    /// Add or remove one bidder from the allowlist. Inert once the expiry has passed.
    pub fn set_allowed(env: Env, bidder: Address, allowed: bool) -> Result<(), Error> {
        // Not `mut`: this is the one setter that writes no `Config` field. The
        // allowlist is per-bidder persistent state, which is why revoking can
        // remove the entry rather than having to store a negative.
        let ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        storage::set_allowed(&env, ctx.rent, &bidder, allowed);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        AllowedChanged { bidder, allowed }.publish(&env);
        Ok(())
    }

    // Below the current total is legal: it blocks new deposits without touching a
    // stroop of what is already in. `cap == 0` is legal too and means uncapped
    // (§16) — which is why the floor below is conditional rather than absolute.
    //
    // **A non-zero cap must clear `min_deposit`, and that is the whole reason this
    // is not a one-line setter.** The pair lives in two structs behind two setters,
    // so without this check `set_deposit_cap` and `set_epoch_params` can be walked
    // into a state where every deposit is at once too small and too large — the
    // constructor applies the identical rule, and a rule enforced at the door but
    // not at the setter is enforced nowhere after day one.
    /// Set the deposit cap. Zero means uncapped; below the current total is legal.
    pub fn set_deposit_cap(env: Env, cap: i128) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        if cap < 0 || (cap != 0 && cap < ctx.config.params.min_deposit) {
            return Err(Error::InvalidParams);
        }

        let old = ctx.config.deposit_cap;
        ctx.config.deposit_cap = cap;
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        CapChanged { old, new: cap }.publish(&env);
        Ok(())
    }

    // `validate_rent` is the same function the constructor calls, and calling it
    // here is the point rather than tidiness: `extend_to` above the live ceiling
    // makes **every** mutating call fail at its own final bump — the unpausable
    // exit included, so an unchecked value here bricks exactly what I8 promises
    // cannot be bricked (03-STORAGE-TTL §2).
    //
    // The set-time check is hygiene, not the defence. The ceiling can be lowered by
    // protocol vote after this returns, so the load-bearing guard stays the per-call
    // clamp in `Rent::effective`. Two layers because one of them can go stale.
    //
    // The new values take effect from the **next** call, not this one: `ctx.rent`
    // was read before the write and this call's own bump uses it. That is the same
    // shape as `set_epoch_params` taking effect next epoch, and it means a call can
    // never be priced under a rule it did not start under.
    /// Set the rent threshold and extension window. Takes effect from the next call.
    pub fn set_rent_params(env: Env, threshold: u32, extend_to: u32) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();
        validate_rent(&env, threshold, extend_to)?;

        let old_threshold = ctx.config.rent_threshold;
        let old_extend_to = ctx.config.rent_extend_to;
        ctx.config.rent_threshold = threshold;
        ctx.config.rent_extend_to = extend_to;
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        RentParamsChanged {
            old_threshold,
            new_threshold: threshold,
            old_extend_to,
            new_extend_to: extend_to,
        }
        .publish(&env);
        Ok(())
    }

    // **Two steps, and the second one is the whole feature.** A one-step
    // `set_admin` hands the role to whatever address was typed; a typo is
    // unrecoverable and takes every setter, `upgrade` and `migrate` with it. Here
    // the new admin has to prove they hold the key by calling `accept_admin`, so
    // an address nobody controls simply never completes.
    //
    // Overwriting a prior pending is deliberate: the admin changing their mind must
    // not need a third call to undo the second, and a pending transfer confers
    // nothing until accepted.
    //
    // §11's rule binds here — the contract's own address as `pending_admin` is
    // refused. It is the one address that could accept and then be unable to act.
    /// Nominate a new admin. They must call `accept_admin` before anything changes.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        if new_admin == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }

        let current = ctx.config.admin.clone();
        ctx.config.pending_admin = Some(new_admin.clone());
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        AdminTransferStarted {
            current,
            pending: new_admin,
        }
        .publish(&env);
        Ok(())
    }

    // Authorised by the **pending** admin, not the current one — that asymmetry is
    // what makes the two-step mean anything. `NoPendingAdmin` rather than
    // `Unauthorized` when there is nothing to accept: the caller may well hold a
    // key, and telling them the transfer does not exist is the accurate answer.
    /// Complete a pending admin transfer. Called by the incoming admin.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let mut ctx = enter(&env, false)?;
        let Some(pending) = ctx.config.pending_admin.clone() else {
            return Err(Error::NoPendingAdmin);
        };
        pending.require_auth();

        let old = ctx.config.admin.clone();
        ctx.config.admin = pending.clone();
        ctx.config.pending_admin = None;
        storage::set_config(&env, &ctx.config);
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        AdminChanged { old, new: pending }.publish(&env);
        Ok(())
    }

    // **No phase gate here, and that is deliberate.** `deploy.ts` refuses to run an
    // upgrade unless the vault is Idle (09-DEPLOYMENT §4) — a policy, enforced where
    // policy belongs. Putting it on-chain would make the contract unupgradeable
    // exactly when a live round is the thing that needs fixing, which is the state
    // an upgrade is most likely to be for.
    //
    // **`AppVersion` does not move.** Code and schema are separate versions and only
    // `migrate` advances the schema, so the event carries the version *before* any
    // migration — that pairing is what lets a reader order a code change against a
    // schema change afterwards.
    /// Replace the contract code. Does not migrate storage; see `migrate`.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        let app_version = storage::get_app_version(&env);
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        storage::set_state(&env, &ctx.state);
        storage::bump_instance(&env, ctx.rent);

        Upgraded {
            wasm_hash: new_wasm_hash,
            app_version,
        }
        .publish(&env);
        Ok(())
    }

    // **v1 defines no target, so every call fails, and that is the correct
    // behaviour rather than a stub.** A `migrate` that returned `Ok` here would
    // advance `AppVersion` to a schema that does not exist — claiming a data
    // transformation nobody wrote. §14 is explicit: calling it is an error, not a
    // no-op.
    //
    // The order check is written now rather than added with the first real target,
    // because **it is itself the idempotence guard**: `to_version == app + 1` means
    // a second call with the same argument fails, and a guard bolted on later is one
    // that was missing for a release. When v2 lands, the body slots in after this
    // check and the two errors below separate — wrong target, versus a target this
    // build cannot reach.
    /// Advance the storage schema. v1 has no target, so this always rejects.
    pub fn migrate(env: Env, to_version: u32) -> Result<(), Error> {
        let ctx = enter(&env, false)?;
        ctx.config.admin.require_auth();

        let from_version = storage::get_app_version(&env);
        if to_version != from_version.saturating_add(1) {
            return Err(Error::MigrationOrder);
        }

        // Where the migration body goes. Until one exists there is nothing this
        // call can honestly do, and `Migrated` stays unpublished rather than
        // announcing a schema change that did not happen.
        let _ = Migrated {
            from_version,
            to_version,
        };
        Err(Error::MigrationOrder)
    }
}

/// 2 000 bps — 20 % of premium (D-39, §16). Ships at 0.
pub const MAX_FEE_BPS: u32 = 2_000;
