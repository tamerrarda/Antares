#![no_std]
//! `MockPriceSource` — **DEV2's contract**; this is only the Phase-1 skeleton
//! DEV1 created so the workspace builds and CI has three crates to check.
//!
//! It is the first real code in the project (`00-ROADMAP.md` Phase 2 ordering
//! note): the vault's `__constructor` calls `supports_round`, so without a mock
//! whose `resolution()`, `decimals()`, `price()`, `prices()` and `expires()` are
//! settable per test, the vault cannot be registered in a test at all.

use soroban_sdk::{contract, contractimpl};

#[contract]
pub struct MockPriceSource;

#[contractimpl]
impl MockPriceSource {}
