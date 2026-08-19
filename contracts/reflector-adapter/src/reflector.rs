//! The Reflector surface this adapter consumes, and nothing more.
//!
//! Declared here rather than imported, because Reflector publishes no Rust crate we could pin and
//! `04-ORACLE.md` §1's rule forbids this crate a dependency carrying a `#[contract]` anyway. The
//! shapes are the ones that matter for XDR compatibility: a `#[contracttype]` enum discriminates
//! on the **variant name** and a struct on its **field names**, so those must match Reflector's
//! source exactly; declaration order does not.
//!
//! **Only the six functions this adapter calls are declared.** A client trait is not a description
//! of the callee — it is a list of what we invoke, and every extra line is surface we would have to
//! keep true without ever exercising it. `prices()` is deliberately absent: D-48 measured it
//! collapsing at 20 records, which is why this adapter is built on point queries at all.
//!
//! **Units are seconds, asserted rather than assumed** (D-49, `scripts/verify-environment.ts` E-5).
//! Reflector stores milliseconds internally and divides on the way out of every accessor —
//! `resolution()`, `last_timestamp()`, `expires()` and `PriceData.timestamp` are all seconds, and
//! `price()` takes seconds. Measured against the live testnet feed 2026-08-19: `last_timestamp`
//! sat 207 s from the ledger clock, not 10⁹ s from it.

use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol};

// Reflector's asset identifier.
//
// XLM is `Other(symbol!("XLM"))` on the CEX & DEX feed — **not** `Stellar(Address)`, which was an
// open implementation question closed by a single live call (D-48). `Stellar` is declared because
// the enum must round-trip Reflector's XDR, not because this adapter ever constructs one.
/// Reflector's asset identifier. XLM on the CEX & DEX feed is `Other("XLM")`.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

// One price record at the feed's own `decimals()` scale.
/// One Reflector record: the price at the feed's own `decimals()` scale, and its timestamp
/// in seconds.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

// The six calls this adapter makes. Every one of them is invoked through the generated `try_`
// method: `04-ORACLE.md` §3b requires the adapter to be written so it does not trap, and a bare
// call to a feed that has changed its interface or been archived would trap us in turn.
#[contractclient(name = "ReflectorClient")]
pub trait Reflector {
    // Tick period in **seconds**. Read live on every call — the whole grid derives from it, and a
    // stale copy is what D-58 and D-64 each removed once.
    fn resolution(env: Env) -> u32;

    // Price precision. Configuration, not a constant (D-28) — the adapter normalizes against the
    // live value and reports it on every reading so the vault can pin it per round (D-68).
    fn decimals(env: Env) -> u32;

    // Newest record timestamp, in seconds. This is the quantity Reflector's own record cap is
    // measured against, so it is what the reach check compares to (D-69).
    fn last_timestamp(env: Env) -> u64;

    // The record at a tick, or `None` — which means either "no record" or "beyond the cap", and
    // the adapter must not confuse the two. Rule 3 rejects an out-of-reach anchor **before** any
    // sampling, precisely so that a `None` reaching rule 2 is always a statement about records.
    fn price(env: Env, asset: Asset, timestamp: u64) -> Option<PriceData>;

    // Freshest tick, for the bid guard only. Never settlement-grade.
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;

    // The feed's sponsorship expiry, in seconds. `None` is an unsponsored feed (§5), which
    // `supports_round` condition 7 treats as false.
    fn expires(env: Env, asset: Asset) -> Option<u64>;
}
