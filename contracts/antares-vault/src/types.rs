//! Every `#[contracttype]` in the specification, and the four constants — the
//! whole of `02-CONTRACT-SPEC.md` §2, plus `EpochParams` from §1, `VoidReason`
//! from §10 and the view types from §12.
//!
//! **This file is IP-1.** All three developers build against it the same day, so
//! it is deliberately complete rather than "the types DEV1 needs": a type left
//! out becomes a merge conflict in somebody else's module a week later. After
//! IP-1, changing a shared type is a breaking change — announce it, get both
//! other developers to acknowledge, then land it (`DEV-PROTOCOL.md` §5).
//!
//! Field *order* is not ABI here — `#[contracttype]` structs encode as maps keyed
//! by field name — but field *names and presence* are. The order below follows
//! the specification so the two can be read side by side.
//!
//! Amounts are `i128` **stroops** (7 decimals). Ratios are basis points (`u32`,
//! 10 000 = 100 %). Time is `env.ledger().timestamp()` seconds.

use soroban_sdk::{contracttype, Address, String};

// ---------------------------------------------------------------- constants ---

/// Scale of `pps`, 1e7.
pub const PRECISION: i128 = 10_000_000;

/// Basis-point denominator.
pub const BPS: i128 = 10_000;

/// 1 XLM → 1 aXLM before any round has settled.
pub const INITIAL_PPS: i128 = PRECISION;

/// Minted to the contract on the first deposit and charged to it (D-36); never
/// transferable, never burnable. Sized like Uniswap-v2's `MINIMUM_LIQUIDITY`:
/// 1 000 stroops is 0.0001 share, economically negligible.
///
/// Its consequence outlives the deposit that paid for it: **`shares_outstanding`
/// never returns to zero after genesis**, because these have no burn path. Code
/// or tests assuming a zero-supply state after the first deposit are describing
/// something unreachable.
pub const DEAD_SHARES: i128 = 1_000;

// -------------------------------------------------------------------- enums ---

/// The live phases. `Settled` / `Lapsed` / `Voided` / `Unresolved` are **round
/// outcomes**, not phases: the finalizing call writes the `Round` record and sets
/// `phase = Idle` atomically, so there is no intermediate state a second
/// transaction has to clear.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Auction,
    Active,
}

/// How a round ended. `Unresolved` is D-59's third outcome: past a validated
/// bound the round finalizes with no oracle call at all, which is what makes
/// "no oracle state can trap funds" structural rather than a sentence.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundOutcome {
    Settled,
    Lapsed,
    Voided,
    Unresolved,
}

/// Why a round was voided — carried in the `epoch_voided` event (§10).
/// Two variants, both reachable: D-60 removed the ones that were not, on the
/// grounds that an unobservable variant is ABI an integrator must handle and can
/// never see.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    FeedUnusable,
    InvalidPrice,
}

// ------------------------------------------------------------------ configs ---

/// The parameters governing one epoch. Snapshotted into `State` at `open_epoch`,
/// so a change through `set_epoch_params` takes effect **next epoch only** (§15).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochParams {
    /// Seconds from open to expiry.
    pub epoch_duration: u64,
    /// Seconds; `≤ epoch_duration / 24`.
    pub auction_duration: u64,
    /// Minimum seconds between finalization and the next `open_epoch` (D-18).
    /// `≥ epoch_duration / 50` — a fixed hour on a weekly epoch is not a window (D-33).
    pub min_idle_gap: u64,
    /// `strike = twap × (10_000 + this) / 10_000`.
    pub strike_bps_otm: u32,
    /// Decay start, bps of notional.
    pub premium_start_bps: u32,
    /// Decay floor, bps of notional. `0 < floor ≤ start` — the lower bound is
    /// load-bearing: a floor of 0 passes every other rule and then makes the
    /// curve reject every bid with `ZeroPremium` once it arrives there, so the
    /// last stretch of every auction would be dead.
    pub premium_floor_bps: u32,
    /// Seconds of TWAP for open and settle.
    pub twap_window: u64,
    /// Longer TWAP window for the self-consistency breaker; `> twap_window`.
    pub guard_window: u64,
    /// Maximum age of the newest oracle record.
    pub max_staleness: u64,
    /// Breaker bound on `|twap(twap_window) − twap(guard_window)|`. Must stay well
    /// below `strike_bps_otm`: a band wider than the OTM buffer would let an
    /// opener set the strike below the prevailing market.
    pub max_deviation_bps: u32,
    /// Seconds past expiry before the void branch is allowed.
    pub oracle_dead_after: u64,
    /// Guaranteed minimum width of the void window (04-ORACLE §4).
    pub settle_grace: u64,
    /// Seconds past expiry after which `close_round` resolves the round as
    /// `Unresolved` **without calling the oracle** (D-64). Bounded on **both**
    /// sides by `supports_round` (D-68): strictly above the adapter's
    /// `reach_limit`, and no higher than `reach_limit + settle_grace`. A lower
    /// bound alone let an admin setter push the fallback out until it never fired.
    pub unresolved_after: u64,
    /// Dust guard on bid notional; `> 0`.
    pub min_fill: i128,
    /// Dust guard on deposits. Validated **`> DEAD_SHARES`**, not merely `> 0`:
    /// at `INITIAL_PPS` a 1-stroop minimum mints 1 share and `minted −
    /// DEAD_SHARES` underflows a checked subtraction, which would contradict the
    /// promise that no foreseeable condition panics.
    pub min_deposit: i128,
    /// Paid to whoever closes the round, out of premium (D-44). Snapshotted like
    /// the fee, and capped at 100 — an uncapped bounty is D-39's mistake again.
    pub settle_bounty_bps: u32,
}

/// Contract configuration. Everything here that differs between networks is a
/// constructor argument, never a code path (D-50).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub admin: Address,
    /// Two-step admin transfer (§4, D-26): a typo cannot brick the role.
    pub pending_admin: Option<Address>,
    /// XLM SAC address for the network.
    pub asset: Address,
    /// `PriceSource` implementation — the Reflector adapter, or the mock.
    pub oracle: Address,
    pub fee_recipient: Address,
    /// Share-token identity (D-52/D-56). Constructor argument, no setter.
    pub token_suffix: String,
    /// Genesis constant 0 (D-56); non-zero requires a visible setter transaction.
    pub fee_bps: u32,
    /// Enforced from day one; constructor argument (D-56).
    pub deposit_cap: i128,
    /// Genesis constant `false` (D-56).
    pub paused: bool,
    /// Genesis constant `true` (D-56). Disabling it is the public evidence.
    pub allowlist_enabled: bool,
    /// D-63: constructor argument, **no setter**. Past it, `bid` ignores the
    /// allowlist entirely — the admin can open early but can never stay closed,
    /// which is what makes the permissionless path a property rather than a promise.
    pub allowlist_expires_at: u64,
    /// Template for the **next** epoch.
    pub params: EpochParams,
    /// TTL bump threshold, in ledgers (03-STORAGE-TTL §2).
    pub rent_threshold: u32,
    /// TTL extend target, in ledgers. Admin-tunable because ledger close time is
    /// not a constant (D-27).
    pub rent_extend_to: u32,
}

// -------------------------------------------------------------------- state ---

/// The epoch ledger. Live-epoch fields are meaningful only while `phase != Idle`;
/// the rolling fields are always meaningful.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    /// Current round if live, otherwise the last opened one. First round is 1.
    pub round: u32,
    pub phase: Phase,

    // -- live-epoch fields, snapshotted at open --
    /// The snapshot governing this round.
    pub params: EpochParams,
    /// Fee in force for this round, fixed at open (D-39).
    ///
    /// There is deliberately **no `bounty_bps_snapshot`** (D-64): `params` above
    /// *is* the snapshot and already carries `settle_bounty_bps`, so a second
    /// copy would be a second source of truth for one number with nothing keeping
    /// them equal. `fee_bps_snapshot` is not the same case and stays — `fee_bps`
    /// lives in `Config`, outside `EpochParams`, so it has no snapshot without one.
    pub fee_bps_snapshot: u32,
    pub opened_at: u64,
    pub auction_end: u64,
    pub expiry: u64,
    /// Scale established at open from the live reading; close compares against it
    /// and treats a change as `Transient` (D-68). `0` while Idle — never compared
    /// there, since the check is anchored-mode only.
    pub feed_decimals: u32,
    /// Stroops per XLM — see §7 on price units.
    pub strike: i128,
    pub open_twap: i128,
    pub notional_offered: i128,
    pub notional_sold: i128,
    pub premium_collected: i128,
    /// `locked_assets` snapshot at open — the `pps` numerator base, and the upper
    /// bound I2 is stated against.
    pub locked_at_open: i128,
    /// Share supply at open — the `pps` denominator.
    pub shares_snapshot: i128,
    /// Shares burned through `request_withdraw` during this round.
    pub burned_this_round: i128,

    // -- rolling fields, always meaningful --
    /// XLM attributable to current shareholders.
    pub locked_assets: i128,
    /// SEP-41 total supply.
    pub shares_outstanding: i128,
    /// `pps` of the last finalized round; `INITIAL_PPS` before round 1.
    pub last_pps: i128,
    /// 0 until the first `Settled` round — the deviation guard skips while it is 0.
    pub last_settled_spot: i128,
    /// Timestamp of the last round finalization; the `min_idle_gap` base.
    pub last_finalize_time: u64,
    pub pending_deposits_total: i128,
    pub withdraw_claimable_total: i128,
    /// Unclaimed bidder payouts and refunds.
    pub bidder_claimable_total: i128,
    /// Accrued fee awaiting `claim_fee` (D-39).
    pub fee_claimable: i128,
}

/// A finalized round, written once and **never rewritten** (I7). Every unclaimed
/// withdrawal and bidder payout is recomputed from this record, potentially long
/// after the fact, which is what makes archival safe: an archived record can only
/// be restored, never re-derived differently.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Round {
    pub outcome: RoundOutcome,
    /// Post-round price-per-share; equal to the previous `pps` if `Lapsed` or
    /// `Voided`. **Never clamped**, and `0` is accepted (D-66) — forcing `pps ≥ 1`
    /// in the degenerate state breaks the implication that bounds every
    /// downstream amount, and solvency wins where the two conflict.
    pub pps: i128,
    pub strike: i128,
    pub expiry: u64,
    pub notional_sold: i128,
    pub premium: i128,
    pub fee: i128,
    /// 0 unless `Settled`.
    pub settled_spot: i128,
    /// 0 unless `Settled` with `spot > strike`.
    pub payout_total: i128,
}

/// A deposit made during a live round. `round` is the round it was deposited
/// **during**; it stays cancellable for its whole life (D-37).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDeposit {
    pub round: u32,
    pub amount: i128,
}

/// A withdrawal requested during a live round. `round` is the round it was
/// requested **during**; the shares are burned immediately and paid at that
/// round's recorded `pps` once it finalizes.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingWithdraw {
    pub round: u32,
    pub shares: i128,
}

/// One bidder's fill in one round. Never deleted — claims are recomputed from it.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    pub notional: i128,
    pub premium_paid: i128,
    pub claimed: bool,
}

// -------------------------------------------------------------------- views ---
//
// §12: a public API, not an implementation detail. The keeper, the reference
// bidder and all four UI pages compile against these. The shapes freeze at the
// Phase-5 gate and may only be extended **by appending** — "extend freely" is
// exactly backwards for a type other people build against.

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochInfo {
    pub round: u32,
    /// The **effective** phase: a stored `Auction` past `auction_end` with no
    /// fills reads `Idle` here, before anyone calls a mutating function. This
    /// view re-derives the lazy lapse read-only so the keeper and the UI do not
    /// each reimplement it and get it subtly different.
    pub phase: Phase,
    /// True when the stored phase is `Auction` past `auction_end`.
    pub outcome_pending: bool,
    pub opened_at: u64,
    pub auction_end: u64,
    pub expiry: u64,
    pub strike: i128,
    pub open_twap: i128,
    pub notional_offered: i128,
    pub notional_sold: i128,
    pub premium_collected: i128,
    /// The curve evaluated at `now`; 0 outside the auction window.
    pub current_premium_bps: u32,
    pub locked_assets: i128,
    pub shares_outstanding: i128,
    pub last_pps: i128,
    pub last_finalize_time: u64,
    /// `last_finalize_time + min_idle_gap`, using the **same copy of
    /// `min_idle_gap` the contract enforces** (§15: `State.params`, or
    /// `Config.params` before round 1) — never `Config.params` after a
    /// `set_epoch_params`, or the view and the contract disagree.
    pub next_open_at: u64,
    /// `expiry + oracle_dead_after`; 0 when no round is live.
    pub void_available_at: u64,
    /// The snapshot governing this round; `Config.params` when Idle.
    pub params: EpochParams,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub shares: i128,
    /// `shares × last_pps / PRECISION` — indicative.
    pub share_value: i128,
    pub pending_deposit: i128,
    pub pending_deposit_round: u32,
    /// Redeemable. **Still cancellable** — D-37 retired the "finalized ⇒ locked"
    /// rule, and a UI built on the old meaning would grey out a button the
    /// contract still honours.
    pub pending_deposit_finalized: bool,
    pub pending_withdraw_shares: i128,
    pub pending_withdraw_round: u32,
    /// 0 until that round finalizes.
    pub withdraw_claimable: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub admin: Address,
    pub pending_admin: Option<Address>,
    pub asset: Address,
    pub oracle: Address,
    pub fee_recipient: Address,
    pub fee_bps: u32,
    pub deposit_cap: i128,
    /// `cap − (locked + pending)`, floored at 0.
    pub deposit_headroom: i128,
    pub paused: bool,
    pub allowlist_enabled: bool,
    /// D-63 — readable before anyone deposits.
    pub allowlist_expires_at: u64,
    pub app_version: u32,
    pub params: EpochParams,
    pub rent_threshold: u32,
    pub rent_extend_to: u32,
}

/// What one bidder holds in one round. The Claims page cannot be built from
/// `Fill` alone, because `claimable` depends on the round's outcome.
///
/// **A zeroed struct is the answer for an address that never filled — not an
/// error.** The Claims page scans rounds looking for money owed, so "no fill" is
/// its ordinary result and must be cheap and unambiguous; an error would make the
/// common case indistinguishable from a malformed call. `RoundNotFound` is still
/// returned for a round that never existed, and an archived round is a third case.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidderPosition {
    pub notional: i128,
    pub premium_paid: i128,
    pub claimed: bool,
    pub claimable: i128,
}
