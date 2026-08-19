//! The vault's share of §10's **frozen event ABI**.
//!
//! Events here are a public interface, not logging: the web UI and any indexer
//! reconstruct state from them, and integration scenario 1 rebuilds the whole
//! vault from events alone. **A field left out now cannot be added later.**
//!
//! Two rules bind every event in the contract, not just these:
//! - the four finalization events all carry `wclaims` (the indexer half of D-32's
//!   regression, and easy to omit because no on-chain assertion needs it);
//! - **a rejection emits nothing** — every rejecting test asserts an empty log,
//!   not just the happy path.
//!
//! What is a topic and what is data is part of the ABI, because RPC `getEvents`
//! filters on topics only. The rule §10 uses: the event name, plus exactly the
//! fields someone needs to *filter* by — the round, and the address whose page it
//! belongs to. Everything else is data, which is free to read once you have the
//! event and does not consume a topic slot.
//!
//! `#[contractevent]` takes the first topic from the struct name in snake_case,
//! so `DepositCancelled` is `"deposit_cancelled"`. That is checked by test, not
//! by eye: the name is ABI and a rename is a breaking change.

use soroban_sdk::{contractevent, Address, String};

use crate::types::EpochParams;

// Emitted once, by the constructor, and **only** there.
//
// It carries the full starting configuration flat, because an events-only
// indexer has no other way to learn it — §10 spells the fields out rather than
// saying "a snapshot of `Config`", since "a full snapshot" is not a schema and
// `#[contractevent]` needs concrete fields.
//
// `pending_admin` is absent by construction (it is `None` at genesis, and
// `admin_transfer_started` carries it thereafter); `app_version` is present and
// is not a `Config` field.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Initialized {
    pub admin: Address,
    pub asset: Address,
    pub oracle: Address,
    pub fee_recipient: Address,
    pub token_suffix: String,
    pub deposit_cap: i128,
    pub rent_threshold: u32,
    pub rent_extend_to: u32,
    pub allowlist_expires_at: u64,
    pub params: EpochParams,
    pub fee_bps: u32,
    pub paused: bool,
    pub allowlist_enabled: bool,
    pub app_version: u32,
}

// `instant` distinguishes an Idle mint from a pending deposit; `shares_minted`
// is 0 in the pending case.
//
// Ordering matters and is ABI too: an instant Idle deposit that auto-redeems an
// older pending emits `pending_redeemed` **first**, then this.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deposited {
    #[topic]
    pub user: Address,
    pub round: u32,
    pub amount: i128,
    pub shares_minted: i128,
    pub instant: bool,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositCancelled {
    #[topic]
    pub user: Address,
    pub round: u32,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRedeemed {
    #[topic]
    pub user: Address,
    pub round: u32,
    pub amount: i128,
    pub shares: i128,
    pub pps: i128,
}

// An instant Idle withdrawal emits this **and** `WithdrawClaimed` in the same
// transaction, both with `round = State.round` — the last opened round, already
// finalized, and the one whose `pps` was used.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawRequested {
    #[topic]
    pub user: Address,
    pub round: u32,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawClaimed {
    #[topic]
    pub user: Address,
    pub round: u32,
    pub shares: i128,
    pub amount: i128,
}

// No data fields — the address is the whole message, and it is a topic so the
// keeper's monthly sweep can filter its own work.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionRestored {
    #[topic]
    pub user: Address,
}

// The lapse. **Mine rather than DEV2's**, and the rule is *which call path
// arrives*: `finalize_round` emits all four outcome events, but the lapse comes
// through `lazy_finalize` in `vault.rs` while `settled`, `epoch_voided` and
// `epoch_unresolved` arrive through `close_round` in `settle.rs`.
//
// `wclaims` is here because **all four finalization events carry it** — the
// indexer half of D-32's regression, and the field most easily left out, since
// no on-chain assertion needs it.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochLapsed {
    #[topic]
    pub round: u32,
    pub notional_offered: i128,
    pub pps: i128,
    pub wclaims: i128,
}

// **DEV2's**, in DEV1's file: §10's event ABI is split by the module that *emits*, and
// `epoch_opened` is emitted by `open_epoch` in `epoch.rs` (DEV-PROTOCOL §3). Added here rather
// than in a second events module so that §10 stays one file, and flagged in STANDUP.
//
// It carries every input the decay curve needs — `opened_at` is the origin `bid` measures from,
// and `premium_start_bps`/`premium_floor_bps` are the band — so the reference bidder and the UI
// can evaluate `premium_bps(t)` from events alone, with no view call. `open_twap` is the number
// the strike was derived from, which makes the derivation auditable rather than merely
// reproducible.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochOpened {
    #[topic]
    pub round: u32,
    pub strike: i128,
    pub expiry: u64,
    pub opened_at: u64,
    pub auction_end: u64,
    pub notional_offered: i128,
    pub open_twap: i128,
    pub premium_start_bps: u32,
    pub premium_floor_bps: u32,
}
