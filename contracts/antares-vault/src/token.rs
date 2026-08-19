//! The SEP-41 share token — `02-CONTRACT-SPEC.md` §13, surface per §4.
//!
//! Hand-rolled, with no external contract library (D-24). The cost of that is
//! accepted knowingly: SEP-41 correctness is entirely our test surface, and we
//! rather than a library maintainer track the spec's changes — the 2026-08
//! `MuxedAddress` transfer among them.
//!
//! Three rules shape this file, and none of them is a style preference:
//!
//! **`lazy_finalize` does not run here** (§16). A token transfer must not carry
//! epoch-finalization cost or emit epoch events; someone moving shares between
//! two wallets is not interacting with the protocol.
//!
//! **Every path rejects the contract's own address as `from`.** That is what
//! makes `DEAD_SHARES` unburnable and unmovable, which is half of D-36's
//! inflation defence — the other half being that every mint must produce at least
//! one share.
//!
//! **A burn raises `pps` for everyone else.** `shares_outstanding` drops and the
//! pool does not, and this deliberately does *not* touch `burned_this_round`,
//! which tracks withdrawal-queue exits only. So a mid-round burn leaves that
//! holder's capital in the pool but **not in this round's `pps`** — the
//! denominator is `shares_snapshot`, taken at open, which still counts the burned
//! shares. The donation is distributed from the next round onward.

use soroban_sdk::{contractimpl, Address, Env, MuxedAddress, String};

use crate::errors::Error;
use crate::events::{Approve, Burn, Mint, Transfer, TransferMuxed};
use crate::storage::{self, Rent};
use crate::types::Config;
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

/// Seven, matching XLM. Shares are denominated in the same units as the asset
/// behind them, so a wallet showing both does not have to rescale.
pub const DECIMALS: u32 = 7;

const NAME: &str = "Antares XLM Vault Share";
const SYMBOL_BASE: &[u8] = b"aXLM";

/// `Config` and the clamped rent, without the epoch machinery.
///
/// Deliberately not `vault::enter`: that runs `lazy_finalize` and the pause
/// check, and §16 says a SEP-41 call does neither.
fn token_ctx(env: &Env) -> (Config, Rent) {
    let config = storage::get_config(env).expect("Config: unrepresentable after __constructor");
    let rent = Rent::effective(env, &config);
    (config, rent)
}

/// The contract's own shares are inert: they cannot be spent, moved or burned by
/// anyone, including the contract.
fn reject_self(env: &Env, from: &Address) -> Result<(), Error> {
    if *from == env.current_contract_address() {
        return Err(Error::InvalidAddress);
    }
    Ok(())
}

/// Move shares between two balances. Reads once and writes once per side, so a
/// self-transfer cannot double-credit.
fn move_shares(
    env: &Env,
    rent: Rent,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Result<(), Error> {
    if from == to {
        // Legal, and a no-op by §13. Reading both sides and writing both back
        // would credit the second write over the first.
        return Ok(());
    }
    let from_balance = storage::get_shares(env, from)
        .checked_sub(amount)
        .ok_or(Error::InsufficientBalance)?;
    if from_balance < 0 {
        return Err(Error::InsufficientBalance);
    }
    let to_balance = storage::get_shares(env, to)
        .checked_add(amount)
        .ok_or(Error::InvalidAmount)?;

    storage::set_shares(env, rent, from, from_balance);
    storage::set_shares(env, rent, to, to_balance);
    Ok(())
}

/// Spend an allowance, or fail with the SEP-41 code rather than a panic.
fn spend_allowance(
    env: &Env,
    rent: Rent,
    from: &Address,
    spender: &Address,
    amount: i128,
) -> Result<(), Error> {
    let current = storage::get_allowance_amount(env, from, spender);
    let left = current
        .checked_sub(amount)
        .ok_or(Error::InsufficientAllowance)?;
    if left < 0 {
        return Err(Error::InsufficientAllowance);
    }
    // The entry's own expiry is preserved: spending part of an allowance does not
    // extend the authorization it encodes.
    let live_until = storage::get_allowance(env, from, spender)
        .map(|a| a.live_until_ledger)
        .unwrap_or(0);
    storage::set_allowance(env, rent, from, spender, left, live_until);
    Ok(())
}

/// Reduce supply. Used by `burn` and `burn_from`; never by the vault's own
/// accounting, which burns through `request_withdraw`.
fn burn_shares(env: &Env, rent: Rent, from: &Address, amount: i128) -> Result<(), Error> {
    let balance = storage::get_shares(env, from)
        .checked_sub(amount)
        .ok_or(Error::InsufficientBalance)?;
    if balance < 0 {
        return Err(Error::InsufficientBalance);
    }
    storage::set_shares(env, rent, from, balance);

    let mut state = storage::get_state(env).expect("State: unrepresentable after __constructor");
    state.shares_outstanding = state
        .shares_outstanding
        .checked_sub(amount)
        .ok_or(Error::InvalidAmount)?;
    storage::set_state(env, &state);
    Ok(())
}

/// Emitted by the vault's own mints, which have no minter address — shares are
/// minted by the contract, never by an account, so §10's `mint` topic carries the
/// recipient only.
pub fn emit_mint(env: &Env, to: &Address, amount: i128) {
    Mint {
        to: to.clone(),
        amount,
    }
    .publish(env);
}

/// Emitted by the vault's own burns on the withdrawal path.
pub fn emit_burn(env: &Env, from: &Address, amount: i128) {
    Burn {
        from: from.clone(),
        amount,
    }
    .publish(env);
}

#[contractimpl]
impl AntaresVault {
    /// How many shares `spender` may still move on `from`'s behalf.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        storage::get_allowance_amount(&env, &from, &spender)
    }

    /// Authorize `spender` for `amount` until `live_until_ledger`.
    ///
    /// `amount == 0` deletes the allowance and the ledger argument is ignored.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        live_until_ledger: u32,
    ) -> Result<(), Error> {
        from.require_auth();
        reject_self(&env, &from)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let (config, rent) = token_ctx(&env);

        if amount > 0 {
            // An allowance that is already expired authorizes nothing, and one
            // beyond the network's ceiling cannot be stored at all.
            if live_until_ledger < env.ledger().sequence() {
                return Err(Error::InvalidAmount);
            }
            let horizon = env
                .ledger()
                .sequence()
                .checked_add(env.storage().max_ttl())
                .ok_or(Error::InvalidAmount)?;
            if live_until_ledger > horizon {
                return Err(Error::InvalidAmount);
            }
        }

        storage::set_allowance(&env, rent, &from, &spender, amount, live_until_ledger);
        storage::bump_instance(&env, rent);
        let _ = config;

        Approve {
            from,
            spender,
            amount,
            live_until_ledger,
        }
        .publish(&env);
        Ok(())
    }

    /// Share balance. Zero for an address that has never held any.
    pub fn balance(env: Env, id: Address) -> i128 {
        storage::get_shares(&env, &id)
    }

    /// Move shares. The destination may be muxed; the balance is keyed by the
    /// underlying address either way, and the multiplexing id rides in the event.
    ///
    /// Storing per-muxed-address balances would create an unbounded key space and
    /// break I5.
    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) -> Result<(), Error> {
        from.require_auth();
        reject_self(&env, &from)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let (_, rent) = token_ctx(&env);

        let to_address = to.address();
        reject_self(&env, &to_address)?;
        move_shares(&env, rent, &from, &to_address, amount)?;
        storage::bump_instance(&env, rent);

        // Two structs rather than one, decided here per §10 and selected on
        // whether the destination carried a multiplexing id. One
        // `#[contractevent]` cannot produce two data formats, and the SAC's
        // shapes are two: a bare `i128`, or the amount alongside `to_muxed_id`.
        match to.id() {
            None => Transfer {
                from,
                to: to_address,
                amount,
            }
            .publish(&env),
            Some(id) => TransferMuxed {
                from,
                to: to_address,
                amount,
                to_muxed_id: id,
            }
            .publish(&env),
        }
        Ok(())
    }

    /// Move shares on someone's behalf, against an allowance.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        spender.require_auth();
        reject_self(&env, &from)?;
        reject_self(&env, &to)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let (_, rent) = token_ctx(&env);

        spend_allowance(&env, rent, &from, &spender, amount)?;
        move_shares(&env, rent, &from, &to, amount)?;
        storage::bump_instance(&env, rent);

        Transfer { from, to, amount }.publish(&env);
        Ok(())
    }

    /// Destroy your own shares. Permitted in any phase.
    ///
    /// This donates the holder's claim to everyone else: supply drops, the pool
    /// does not, and `pps` rises for the remaining holders from the next round on.
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        reject_self(&env, &from)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let (_, rent) = token_ctx(&env);

        burn_shares(&env, rent, &from, amount)?;
        storage::bump_instance(&env, rent);

        Burn { from, amount }.publish(&env);
        Ok(())
    }

    /// Destroy someone's shares against an allowance.
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) -> Result<(), Error> {
        spender.require_auth();
        reject_self(&env, &from)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let (_, rent) = token_ctx(&env);

        spend_allowance(&env, rent, &from, &spender, amount)?;
        burn_shares(&env, rent, &from, amount)?;
        storage::bump_instance(&env, rent);

        Burn { from, amount }.publish(&env);
        Ok(())
    }

    /// Seven, matching XLM.
    pub fn decimals(_env: Env) -> u32 {
        DECIMALS
    }

    /// The share token's display name.
    pub fn name(env: Env) -> String {
        String::from_str(&env, NAME)
    }

    /// `aXLM`, plus this instance's suffix.
    ///
    /// Five concurrent vaults issue five non-interchangeable tokens, and showing
    /// them all as `aXLM` in a wallet is not a cosmetic problem — it is a way for
    /// someone to believe they hold something they do not (D-52).
    pub fn symbol(env: Env) -> Result<String, Error> {
        let config =
            storage::get_config(&env).expect("Config: unrepresentable after __constructor");

        // `token_suffix.len() ≤ 4` is a constructor rule, so eight bytes is the
        // whole space this can occupy.
        let mut buf = [0u8; 8];
        buf.get_mut(..SYMBOL_BASE.len())
            .ok_or(Error::InvalidParams)?
            .copy_from_slice(SYMBOL_BASE);

        let suffix_len =
            usize::try_from(config.token_suffix.len()).map_err(|_| Error::InvalidParams)?;
        let end = SYMBOL_BASE
            .len()
            .checked_add(suffix_len)
            .ok_or(Error::InvalidParams)?;
        let tail = buf
            .get_mut(SYMBOL_BASE.len()..end)
            .ok_or(Error::InvalidParams)?;
        config.token_suffix.copy_into_slice(tail);

        let bytes = buf.get(..end).ok_or(Error::InvalidParams)?;
        Ok(String::from_bytes(&env, bytes))
    }
}
