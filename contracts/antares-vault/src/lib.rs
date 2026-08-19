#![no_std]
//! Antares vault — the epoch ledger.
//!
//! **State at IP-1:** the frozen type surface and the complete numbered error
//! enum. No behaviour yet — the storage layer, the constructor, the accounting
//! and SEP-41 land at IP-2, and the contract impl block stays empty until then
//! rather than growing a surface nobody has reviewed.
//!
//! Everything in `types` and `errors` is what the other two developers build
//! against from today. A change to a shared type or an error number is a
//! breaking change from here on: announce it, get both acknowledgements, then
//! land it (`DEV-PROTOCOL.md` §5).

use soroban_sdk::{contract, contractimpl};

pub mod admin;
pub mod auction;
pub mod errors;
pub mod events;
pub mod storage;
pub mod token;
pub mod types;
pub mod vault;
pub mod views;

#[cfg(test)]
mod test_accounting;

#[cfg(test)]
mod test_admin;

#[cfg(test)]
mod test_auction;

#[cfg(test)]
mod test_common;

#[cfg(test)]
mod test_storage;

#[cfg(test)]
mod test_token;

#[cfg(test)]
mod test_types;

#[cfg(test)]
mod test_views;

#[cfg(test)]
mod test_vault;

pub use errors::Error;
pub use types::{
    BidderPosition, Config, ConfigView, EpochInfo, EpochParams, Fill, PendingDeposit,
    PendingWithdraw, Phase, Position, Round, RoundOutcome, State, VoidReason, BPS, DEAD_SHARES,
    INITIAL_PPS, PRECISION,
};

#[contract]
pub struct AntaresVault;

#[contractimpl]
impl AntaresVault {}
