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

use soroban_sdk::{contractimpl, Env};

use crate::errors::Error;
use crate::events::{ParamsChanged, Paused, Unpaused};
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
}
