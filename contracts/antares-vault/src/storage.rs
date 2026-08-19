//! Storage keys, the clamped TTL policy, and the terminal-deletion rule —
//! `03-STORAGE-TTL.md` §1–§3.
//!
//! Three rules shape this module, and each of them is load-bearing rather than
//! hygiene:
//!
//! **1. Nothing value-bearing is ever `temporary()`.** A temporary entry that
//! expires is deleted permanently — a user who cannot reach their funds, with no
//! restore path. Persistent archival only ever *delays* a claim. CI greps for the
//! call; this module simply never makes it.
//!
//! **2. Every TTL argument is clamped to the live ceiling, on every call.**
//! `extend_to_eff = min(rent_extend_to, max_ttl())`, `threshold_eff =
//! min(rent_threshold, extend_to_eff)`. Set-time validation checks
//! `rent_extend_to` against `max_ttl` *as of then*, and the network can lower
//! `max_ttl` by protocol vote afterwards. This bump runs at the end of every
//! mutating call **including the unpausable exit path**, so an unclamped ask
//! would brick `claim_withdraw` and `close_round` — precisely what I8 forbids —
//! with `set_rent_params` bricked behind the same bump. One `min()` per argument
//! makes that failure impossible *whichever way the host treats an over-ceiling
//! ask*, so nothing here rests on pinning that behaviour.
//!
//! **3. Touching a claim touches the round it is computed from** (§2 rule 3).
//! `PendingWithdraw(u)` and `Fill(r,b)` both bump `Round(r)`. Miss it and the
//! round record archives while claims against it are still outstanding, which
//! turns I7's "always reachable" into "eventually restorable".

use soroban_sdk::{contracttype, Address, Env};

use crate::types::{Config, Fill, PendingDeposit, PendingWithdraw, Round, State};

// The key space. A single typed enum is what makes key collision unrepresentable
// rather than merely avoided (07-SECURITY §3).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    // -- instance: global, hot, bounded; lives and dies with the contract --
    Config,
    State,
    AppVersion,
    // -- persistent: user- or round-scoped, value-bearing, restorable --
    Shares(Address),
    Allowance(Address, Address),
    PendingDeposit(Address),
    PendingWithdraw(Address),
    Round(u32),
    // `(round, bidder)`.
    Fill(u32, Address),
    // Bidder allowlist.
    Allowed(Address),
}

// The value behind `DataKey::Allowance`.
//
// **Not in `02-CONTRACT-SPEC.md` §2, deliberately and worth stating:** §2 freezes
// the types other people compile against, and this is not one of them. No view
// returns it, no event carries it, and SEP-41's `allowance()` returns a bare
// `i128`. Its two fields come from §13's semantics — an amount, and the ledger
// past which the authorization is void — so the shape is fixed by the spec even
// though the struct is ours.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowanceValue {
    pub amount: i128,
    pub live_until_ledger: u32,
}

// The clamped rent values for one invocation.
//
// Computed once per call and threaded through, rather than re-derived at each
// bump: `max_ttl()` is a host call, and one source of truth per invocation is
// also what stops a later edit from clamping some bumps and not others.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rent {
    pub threshold: u32,
    pub extend_to: u32,
}

impl Rent {
    // §2 rules 1–2. Both arguments clamped; `threshold ≤ extend_to` holds by
    // construction, which is also what `extend_ttl` requires of its arguments.
    pub fn effective(env: &Env, config: &Config) -> Rent {
        let ceiling = env.storage().max_ttl();
        let extend_to = min_u32(config.rent_extend_to, ceiling);
        Rent {
            threshold: min_u32(config.rent_threshold, extend_to),
            extend_to,
        }
    }
}

fn min_u32(a: u32, b: u32) -> u32 {
    if a < b {
        a
    } else {
        b
    }
}

// ----------------------------------------------------------------- instance ---

pub fn get_config(env: &Env) -> Option<Config> {
    env.storage().instance().get(&DataKey::Config)
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_state(env: &Env) -> Option<State> {
    env.storage().instance().get(&DataKey::State)
}

pub fn set_state(env: &Env, state: &State) {
    env.storage().instance().set(&DataKey::State, state);
}

pub fn get_app_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::AppVersion)
        .unwrap_or(0)
}

pub fn set_app_version(env: &Env, version: u32) {
    env.storage().instance().set(&DataKey::AppVersion, &version);
}

// §2 rule 1. One call covers `Config`, `State` and `AppVersion` — and the
// contract **code** entry too, which `instance().extend_ttl()` extends with its
// own independent threshold check, so the wasm needs no separate maintenance.
pub fn bump_instance(env: &Env, rent: Rent) {
    env.storage()
        .instance()
        .extend_ttl(rent.threshold, rent.extend_to);
}

// --------------------------------------------------------------- persistent ---

fn bump(env: &Env, rent: Rent, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, rent.threshold, rent.extend_to);
}

// Bump a persistent key only if it exists. `extend_ttl` on an absent key traps,
// and several callers legitimately touch a key that may never have been written
// — a first-time depositor has no `PendingWithdraw`.
fn bump_if_present(env: &Env, rent: Rent, key: &DataKey) {
    if env.storage().persistent().has(key) {
        bump(env, rent, key);
    }
}

// -- shares --

pub fn get_shares(env: &Env, user: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Shares(user.clone()))
        .unwrap_or(0)
}

// §3's terminal-deletion rule: a zero balance is `remove`d rather than stored.
// Leaving an emptied entry behind is rent paid on nothing, and TTL a restore
// path would still have to service.
pub fn set_shares(env: &Env, rent: Rent, user: &Address, amount: i128) {
    let key = DataKey::Shares(user.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
        bump(env, rent, &key);
    }
}

// -- allowance --

// Returns the stored entry without interpreting expiry. Callers that want
// SEP-41's "an expired allowance reads as 0 and is treated as absent" use
// [`get_allowance_amount`].
pub fn get_allowance(env: &Env, owner: &Address, spender: &Address) -> Option<AllowanceValue> {
    env.storage()
        .persistent()
        .get(&DataKey::Allowance(owner.clone(), spender.clone()))
}

// §13: an expired allowance reads as 0 and is treated as absent.
pub fn get_allowance_amount(env: &Env, owner: &Address, spender: &Address) -> i128 {
    match get_allowance(env, owner, spender) {
        Some(a) if a.live_until_ledger >= env.ledger().sequence() => a.amount,
        _ => 0,
    }
}

// §13's allowance bump: `clamp(min(extend_to_eff, live_until − current),
// threshold_eff, extend_to_eff)`, so the entry never outlives the authorization
// it encodes.
//
// The inner `min` can fall **below** the threshold, and `extend_ttl` is not
// valid with `extend_to < threshold`; an allowance already inside its last
// `threshold_eff` ledgers is therefore left alone rather than bumped, which is
// what §13 says and what keeps this from being a host error on a live path.
pub fn set_allowance(
    env: &Env,
    rent: Rent,
    owner: &Address,
    spender: &Address,
    amount: i128,
    live_until_ledger: u32,
) {
    let key = DataKey::Allowance(owner.clone(), spender.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
        return;
    }

    env.storage().persistent().set(
        &key,
        &AllowanceValue {
            amount,
            live_until_ledger,
        },
    );

    let remaining = live_until_ledger.saturating_sub(env.ledger().sequence());
    let target = min_u32(rent.extend_to, remaining);
    if target >= rent.threshold {
        env.storage()
            .persistent()
            .extend_ttl(&key, rent.threshold, target);
    }
}

pub fn remove_allowance(env: &Env, owner: &Address, spender: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Allowance(owner.clone(), spender.clone()));
}

// -- pending deposit --

pub fn get_pending_deposit(env: &Env, user: &Address) -> Option<PendingDeposit> {
    env.storage()
        .persistent()
        .get(&DataKey::PendingDeposit(user.clone()))
}

pub fn set_pending_deposit(env: &Env, rent: Rent, user: &Address, pending: &PendingDeposit) {
    let key = DataKey::PendingDeposit(user.clone());
    env.storage().persistent().set(&key, pending);
    bump(env, rent, &key);
}

// §3: removed after redeem or cancel.
pub fn remove_pending_deposit(env: &Env, user: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingDeposit(user.clone()));
}

// -- pending withdraw --

pub fn get_pending_withdraw(env: &Env, user: &Address) -> Option<PendingWithdraw> {
    env.storage()
        .persistent()
        .get(&DataKey::PendingWithdraw(user.clone()))
}

// §2 rule 3: writing the claim also bumps the round it will be computed from.
pub fn set_pending_withdraw(env: &Env, rent: Rent, user: &Address, pending: &PendingWithdraw) {
    let key = DataKey::PendingWithdraw(user.clone());
    env.storage().persistent().set(&key, pending);
    bump(env, rent, &key);
    bump_if_present(env, rent, &DataKey::Round(pending.round));
}

// §2 rule 3 on the read path. A claim that is merely *read* still keeps its
// round alive, because the read is what precedes the claim.
pub fn touch_pending_withdraw(env: &Env, rent: Rent, user: &Address) -> Option<PendingWithdraw> {
    let pending = get_pending_withdraw(env, user)?;
    bump(env, rent, &DataKey::PendingWithdraw(user.clone()));
    bump_if_present(env, rent, &DataKey::Round(pending.round));
    Some(pending)
}

// §3: removed after claim.
pub fn remove_pending_withdraw(env: &Env, user: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingWithdraw(user.clone()));
}

// -- rounds --

pub fn get_round(env: &Env, round: u32) -> Option<Round> {
    env.storage().persistent().get(&DataKey::Round(round))
}

// `Round(r)` is **never** deleted (I7) and, once written, never rewritten. This
// function does not enforce single-write — the caller does, at the one place a
// round is finalized — but nothing here offers a delete.
pub fn set_round(env: &Env, rent: Rent, round: u32, record: &Round) {
    let key = DataKey::Round(round);
    env.storage().persistent().set(&key, record);
    bump(env, rent, &key);
}

pub fn bump_round(env: &Env, rent: Rent, round: u32) {
    bump_if_present(env, rent, &DataKey::Round(round));
}

// -- fills --

pub fn get_fill(env: &Env, round: u32, bidder: &Address) -> Option<Fill> {
    env.storage()
        .persistent()
        .get(&DataKey::Fill(round, bidder.clone()))
}

// §2 rule 3 again: a fill is claimed against its round's record.
// §3: `Fill(r,b)` is never deleted — it backs a claim that may arrive
// arbitrarily late.
pub fn set_fill(env: &Env, rent: Rent, round: u32, bidder: &Address, fill: &Fill) {
    let key = DataKey::Fill(round, bidder.clone());
    env.storage().persistent().set(&key, fill);
    bump(env, rent, &key);
    bump_if_present(env, rent, &DataKey::Round(round));
}

pub fn touch_fill(env: &Env, rent: Rent, round: u32, bidder: &Address) -> Option<Fill> {
    let fill = get_fill(env, round, bidder)?;
    bump(env, rent, &DataKey::Fill(round, bidder.clone()));
    bump_if_present(env, rent, &DataKey::Round(round));
    Some(fill)
}

// -- allowlist --

pub fn is_allowed(env: &Env, bidder: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Allowed(bidder.clone()))
        .unwrap_or(false)
}

// §2 rule 4: allowlist entries bump when `bid` checks them.
pub fn check_allowed(env: &Env, rent: Rent, bidder: &Address) -> bool {
    let key = DataKey::Allowed(bidder.clone());
    let allowed = env.storage().persistent().get(&key).unwrap_or(false);
    if allowed {
        bump(env, rent, &key);
    }
    allowed
}

pub fn set_allowed(env: &Env, rent: Rent, bidder: &Address, allowed: bool) {
    let key = DataKey::Allowed(bidder.clone());
    if allowed {
        env.storage().persistent().set(&key, &true);
        bump(env, rent, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

// ------------------------------------------------------------------ restore ---

// The storage half of `restore_position(user)` — `03-STORAGE-TTL.md` §4.
//
// Touches and re-bumps the user's three keys and any `Round` they reference.
// Archived entries return through Protocol 23's auto-restore list, which
// simulation populates; live ones simply get fresh TTL.
//
// On I8's unpausable list, which is why it takes the **clamped** rent like
// everything else: a raw over-ceiling bump here would brick the recovery path
// this exists to be.
pub fn restore_position_keys(env: &Env, rent: Rent, user: &Address) {
    bump_if_present(env, rent, &DataKey::Shares(user.clone()));

    if let Some(pending) = get_pending_deposit(env, user) {
        bump(env, rent, &DataKey::PendingDeposit(user.clone()));
        bump_if_present(env, rent, &DataKey::Round(pending.round));
    }

    if let Some(pending) = get_pending_withdraw(env, user) {
        bump(env, rent, &DataKey::PendingWithdraw(user.clone()));
        bump_if_present(env, rent, &DataKey::Round(pending.round));
    }
}
