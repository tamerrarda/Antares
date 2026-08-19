//! The complete, numbered error enum — `02-CONTRACT-SPEC.md` §3.
//!
//! **Error numbers are ABI.** After IP-1 a change to any number here is a breaking
//! change: announce it, get both other developers to acknowledge, then land it
//! (`DEV-PROTOCOL.md` §5). Gaps are never re-used and retired codes stay retired,
//! which is why the unallocated numbers are written down below rather than left
//! as silent holes somebody later fills in good faith.
//!
//! Every public function returns `Result<T, Error>`, the SEP-41 surface included.
//! The one exception is arithmetic overflow, which panics: §8's bounds prove it
//! unreachable, so reaching it means an assumption broke and the transaction must
//! die rather than continue on a wrapped value. No *foreseeable* condition panics —
//! "insufficient balance" is `InsufficientBalance`, not a checked-subtraction panic.
//!
//! There is deliberately no `NotInitialized`: with a `__constructor` an
//! uninitialized-but-deployed contract is unrepresentable. Authorization failures
//! surface as Soroban auth errors from `require_auth`, never as a variant here.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ---- lifecycle ----
    Paused = 1,
    WrongPhase = 2,
    /// The gap between rounds has not elapsed yet.
    IdleGapNotElapsed = 3,
    NotExpired = 4,
    // 5 unallocated — `AuctionClosed` is retired (§16). `lazy_finalize` moves the
    // phase before a late bid is ever evaluated, so `WrongPhase` is always the
    // answer and 5 could never have been returned.
    // `close_round`: dead at expiry, but before `expiry + oracle_dead_after`.
    OracleNotDeadYet = 6,
    // `open_epoch` with zero locked assets.
    NothingOffered = 7,
    // `open_epoch` before the first deposit ever — the only zero-supply state,
    // since `DEAD_SHARES` floors the supply after genesis. Checked **before**
    // `min_fill`, or it is unreachable (§4).
    /// The vault has never had a deposit, so there is nothing to write options against.
    NoShares = 8,
    // The referenced round never existed. Distinct from *archived*, which is a
    // third case the caller sees at simulation (§12).
    RoundNotFound = 9,

    // ---- oracle ----
    OracleStale = 10,
    OracleDeviation = 11,
    // Non-positive or absurd price from the adapter.
    OracleInvalidPrice = 12,
    // The adapter call itself failed — trap or budget. Never propagated (04 §3b).
    OracleUnreachable = 13,

    // ---- deposits / withdrawals ----
    BelowMinDeposit = 20,
    DepositCapExceeded = 21,
    NothingPending = 22,
    // 23 unallocated — `PendingNotFinalized` is unreachable: `redeem_shares` is
    // Idle-only, and in Idle the pending's round is finalized by construction.
    // Deposit during a live round while an older *finalized* pending exists (D-18).
    /// An earlier queued deposit is still unredeemed. Redeem it between rounds first.
    UnredeemedPending = 24,
    InsufficientShares = 25,
    NothingToClaim = 26,
    // `claim_withdraw` before the referenced round finalized.
    /// The round this withdrawal belongs to has not finalized yet.
    WithdrawNotSettled = 27,
    // 28 retired — was `PendingAlreadyFinalized`; cancel is now always allowed (D-37).
    // SEP-41 `transfer_from` / `burn_from`.
    InsufficientAllowance = 29,
    // SEP-41 `transfer` / `burn` beyond balance — never a raw panic.
    InsufficientBalance = 36,
    // `claim_payout` / `claim_refund` on an already-claimed `Fill`.
    AlreadyClaimed = 37,
    // `claim_*` by an address that never filled that round.
    NoFill = 38,
    // `claim_payout` on a non-`Settled` round, `claim_refund` on a non-`Voided` one.
    WrongOutcome = 39,
    // A mint that would round to zero shares (D-36).
    ZeroShares = 44,

    // ---- auction ----
    AllowlistForbidden = 30,
    // The bidder's own slippage guard tripped.
    PremiumAboveMax = 31,
    BelowMinFill = 32,
    SoldOut = 33,
    // Spot ≥ strike: the vault refuses to sell intrinsic value. An **unreadable**
    // spot is `OracleUnreachable`, never this — the two are counted separately so
    // a feed outage is not read as absent demand (D-29).
    /// Spot has reached the strike; the vault will not sell intrinsic value.
    InTheMoney = 34,
    // Fill so small the premium floors to 0 — a free option, rejected.
    /// The fill is too small to pay a premium at the current price.
    ZeroPremium = 35,

    // ---- amounts / params ----
    // Non-positive amount, anywhere.
    InvalidAmount = 40,
    InvalidParams = 41,

    // ---- admin / upgrade ----
    // `migrate` target version is not monotonic.
    MigrationOrder = 51,
    // `accept_admin` with no pending transfer.
    NoPendingAdmin = 52,
    // A constructor or setter was given the contract's own address, or a role
    // collision such as `asset == oracle` (§11).
    InvalidAddress = 53,
    // A mint was attempted while `last_pps == 0` (§16). Withdrawals still work —
    // that asymmetry is the point (D-66).
    /// The pool is worth nothing per share, so nothing can be minted. Exits still work.
    VaultWorthless = 54,
    // 55–56 unallocated, permanently. D-60 defined `OracleOutOfReach`,
    // `OracleStillReadable` and `NotUnusable` at 54–56 as the rejections for
    // calling the wrong one of three terminal entry points; D-61 collapsed those
    // into `close_round`'s single dispatch, so no caller can choose wrongly and
    // all three became unreachable. They are removed rather than reserved: an
    // unreachable code is ABI an integrator must handle and can never observe.
    // 54 was reassigned to `VaultWorthless`; 55–56 stay empty so nothing shifts.
}
