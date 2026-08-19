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

// `open_epoch`: opening a round is a guarded read plus `supports_round`, so it is the oracle seam
// rather than the accounting (DEV-PROTOCOL §3). DEV2's file.
pub mod epoch;
pub mod errors;
pub mod events;
// The vault's side of the oracle seam: the anchored guard ladder and the four-way GuardOutcome
// (04-ORACLE §3). DEV2's file, declared here by them — the live branch ships with `open_epoch`.
pub mod oracle;
// `close_round`: the single terminal entry point, and the clock path that resolves a round with no
// oracle call at all (D-61, D-64). DEV2's file.
pub mod settle;
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
mod test_epoch;

#[cfg(test)]
mod test_oracle;

#[cfg(test)]
mod test_settle;

#[cfg(test)]
mod test_storage;

#[cfg(test)]
mod test_token;

#[cfg(test)]
mod test_types;

#[cfg(test)]
mod test_vectors;

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
