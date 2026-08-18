#![no_std]
//! `ReflectorAdapter` — **DEV2's contract**; this is only the Phase-1 skeleton
//! DEV1 created so the workspace builds and CI has three crates to check.
//!
//! Implemented in Phase 3 against the live CEX & DEX XLM/USD feed (`04-ORACLE.md`,
//! D-48/D-58/D-64/D-65). It holds no power of its own: no admin, no upgrade, no
//! setters, asserted at deploy — which is what keeps the vault's `upgrade()` the
//! protocol's only trust concentration (`07-SECURITY.md` §2).

use soroban_sdk::{contract, contractimpl};

#[contract]
pub struct ReflectorAdapter;

#[contractimpl]
impl ReflectorAdapter {}
