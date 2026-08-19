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

use soroban_sdk::{contractimpl, Address, Env};

use crate::errors::Error;
use crate::events::{
    AllowedChanged, AllowlistToggled, FeeChanged, FeeRecipientChanged, ParamsChanged, Paused,
    Unpaused,
};
use crate::storage;
use crate::types::EpochParams;
use crate::vault::{enter, validate_params};
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
}

/// 2 000 bps — 20 % of premium (D-39, §16). Ships at 0.
pub const MAX_FEE_BPS: u32 = 2_000;
