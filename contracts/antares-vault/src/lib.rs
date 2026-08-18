#![no_std]
//! Antares vault — the epoch ledger.
//!
//! Phase 1 skeleton, deliberately empty. The type surface and the complete
//! numbered error enum land at **IP-1** (`02-CONTRACT-SPEC.md` §2–§3) and the
//! accounting at **IP-2**. Nothing is declared here in the meantime: an
//! interface invented ahead of the freeze is an interface nobody reviewed, and
//! after IP-1 a change to a shared type is a breaking change for all three
//! developers (`DEV-PROTOCOL.md` §5).

use soroban_sdk::{contract, contractimpl};

#[contract]
pub struct AntaresVault;

#[contractimpl]
impl AntaresVault {}
