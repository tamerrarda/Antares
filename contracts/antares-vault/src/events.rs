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

use crate::types::{EpochParams, VoidReason};

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

// -------------------------------------------------------------------------------
// DEV3's share of §10 — `bid_filled` here; `payout_claimed`, `refund_claimed` and
// `fee_claimed` land with `claims.rs`.
//
// DEV-PROTOCOL §3 splits §10 **by the module that emits**, not by one owner, so
// these four are DEV3's inside a file DEV1 created. Flagged rather than assumed:
// `events.rs` is in nobody's column of the ownership map, and by the split's own
// logic it is shared by construction.
// -------------------------------------------------------------------------------

// Three topics, and the third is why the Claims page works at all.
//
// §10's rule for choosing topics is the event name plus exactly the fields
// someone needs to *filter* by. `bidder` is a topic because a bidder's own page
// is built by filtering on it — without it the Claims page would have to fetch
// every fill in every round and discard other people's, which is the difference
// between a bounded read and scanning the chain.
//
// `notional` is this fill's amount, not the running total; `notional_sold_after`
// is the total *after* it. Both are present because scenario 1 reconstructs the
// auction from events alone: the running total lets an indexer detect a gap
// without replaying, and the per-fill amount is what a bidder's receipt needs.
//
// `premium_bps` is the curve value this fill was struck at. Two bidders on a
// descending curve pay different rates, so a refund is per-fill and exact (D-51)
// and there is no pro-rata arithmetic anywhere — this field is what makes that
// auditable off-chain.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidFilled {
    #[topic]
    pub round: u32,
    #[topic]
    pub bidder: Address,
    pub notional: i128,
    pub premium_bps: u32,
    pub premium: i128,
    pub notional_sold_after: i128,
}

// The whole new struct, not a diff. An events-only indexer has no prior copy to
// apply a delta to, and §10 fixes the shape as a full `EpochParams`.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParamsChanged {
    pub params: EpochParams,
}

// `by` rather than nothing: pause is the one admin power participants watch, and
// an indexer that cannot say who used it cannot report it.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paused {
    pub by: Address,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unpaused {
    pub by: Address,
}

// SEP-41's own stream, matching the SAC's **data formats** exactly (§10, measured
// 2026-08-19). Topics differ by one: a real SAC's `transfer` carries a fourth,
// the classic asset's `CODE:ISSUER`, which a share token has no counterpart for.
//
// `topics = ["transfer"]` on both structs because the destination's shape must
// not change the topic a subscriber filters on. One `#[contractevent]` cannot
// produce two data formats, which is why there are two structs at all — the
// decision §10 assigns to Phase 2 and to nobody.
#[contractevent(topics = ["transfer"], data_format = "single-value")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["transfer"], data_format = "map")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferMuxed {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub to_muxed_id: u64,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub live_until_ledger: u32,
}

#[contractevent(data_format = "single-value")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Burn {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

// No minter address: shares are minted by the contract itself, never by an
// account, so the topic carries the recipient only.
#[contractevent(data_format = "single-value")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mint {
    #[topic]
    pub to: Address,
    pub amount: i128,
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

// The three terminal events, plus the two `close_round` shares with nobody. **DEV2's**, in DEV1's
// file, by the same rule as `EpochOpened`: §10 splits the event ABI by the module that *emits*, and
// these arrive through `close_round` in `settle.rs` while the lapse arrives through
// `lazy_finalize` here.
//
// All four finalization events carry `wclaims` — the indexer half of D-32's regression, and the
// field most easily left out because no on-chain assertion needs it. An indexer that saw it only on
// `settled` would drift permanently the first time a round lapsed with queued withdrawals.

// `spot` is the median TWAP over the windows ending at **expiry**, not the price when this was
// called: every caller at every moment produces the same one (D-40).
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settled {
    #[topic]
    pub round: u32,
    pub spot: i128,
    pub strike: i128,
    pub notional_sold: i128,
    pub payout_total: i128,
    pub premium: i128,
    pub fee: i128,
    pub pps: i128,
    pub wclaims: i128,
}

// `premium_refunded` is the whole premium: each fill gets its **own** back, exactly, through
// `claim_refund` — no pro-rata arithmetic, because every fill on a Dutch curve paid a different
// rate. `pps` is unchanged, which is what "a void costs depositors nothing" means concretely.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochVoided {
    #[topic]
    pub round: u32,
    pub reason: VoidReason,
    pub premium_refunded: i128,
    pub pps: i128,
    pub wclaims: i128,
}

// The outcome an indexer cannot reconstruct any other way.
//
// `fee` is present because this branch **accrues fee exactly as settle does**; omitting it left an
// events-only indexer unable to reconcile `fee_claimable`, and `fee_bps` shipping at 0 would have
// hidden that until after the schema froze — §10 calls this a frozen public API, so a field that is
// merely invisible today is not a field that can be added later.
//
// `oracle_answered` distinguishes the two entrances (D-64): `false` when the clock alone resolved
// the round with no oracle call, `true` when the adapter answered `OutOfReach`. It is diagnostic
// and enters no computation — an operator needs to know whether the feed aged out or the adapter is
// broken, and this is the only place that fact is recorded.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochUnresolved {
    #[topic]
    pub round: u32,
    pub premium_retained: i128,
    pub fee: i128,
    pub pps: i128,
    pub wclaims: i128,
    pub oracle_answered: bool,
}

// Emitted by every branch that accrues fee — settle and unresolved — when the amount is non-zero.
// The void branch accrues none. The fee is **accrued, not paid** (D-39): pushing it made settlement
// depend on the recipient being able to receive XLM, which is one admin setter away from trapping
// every depositor's collateral in `Active`.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeAccrued {
    #[topic]
    pub round: u32,
    pub amount: i128,
}

// The caller's incentive (D-44), paid by the settle and unresolved branches. The void branch pays
// none and emits none: a void refunds the premium in full, so a bounty there has no source — it
// could only come out of the refund, breaking the promise that a refund is exact, or out of
// collateral, breaking "a void costs depositors nothing" (D-51). And it is not needed, because the
// bidder is always motivated to void.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleBounty {
    #[topic]
    pub round: u32,
    pub to: Address,
    pub amount: i128,
}

// `{old, new}` rather than just the new value (§10). A fee that changed is a
// thing participants care about the *size* of, and an indexer that only sees the
// destination cannot report the move without having watched every prior one.
#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeChanged {
    pub old: u32,
    pub new: u32,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeRecipientChanged {
    pub old: Address,
    pub new: Address,
}
