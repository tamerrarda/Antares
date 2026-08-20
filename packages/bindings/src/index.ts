import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}





/**
 * One bidder's fill in one round.
 */
export interface Fill {
  claimed: boolean;
  notional: i128;
  premium_paid: i128;
}

/**
 * Which stage of an epoch the vault is in.
 */
export type Phase = {tag: "Idle", values: void} | {tag: "Auction", values: void} | {tag: "Active", values: void};


/**
 * A finalized round. Immutable once written; every late claim is computed from it.
 */
export interface Round {
  expiry: u64;
  fee: i128;
  notional_sold: i128;
  outcome: RoundOutcome;
  payout_total: i128;
  pps: i128;
  premium: i128;
  settled_spot: i128;
  strike: i128;
}


/**
 * The vault's accounting state: the current round, and the running totals.
 */
export interface State {
  auction_end: u64;
  bidder_claimable_total: i128;
  burned_this_round: i128;
  expiry: u64;
  fee_bps_snapshot: u32;
  fee_claimable: i128;
  feed_decimals: u32;
  last_finalize_time: u64;
  last_pps: i128;
  last_settled_spot: i128;
  locked_assets: i128;
  locked_at_open: i128;
  notional_offered: i128;
  notional_sold: i128;
  open_twap: i128;
  opened_at: u64;
  params: EpochParams;
  pending_deposits_total: i128;
  phase: Phase;
  premium_collected: i128;
  round: u32;
  shares_outstanding: i128;
  shares_snapshot: i128;
  strike: i128;
  withdraw_claimable_total: i128;
}


/**
 * Vault configuration. Everything network-specific is a constructor argument.
 */
export interface Config {
  admin: string;
  allowlist_enabled: boolean;
  allowlist_expires_at: u64;
  asset: string;
  deposit_cap: i128;
  fee_bps: u32;
  fee_recipient: string;
  oracle: string;
  params: EpochParams;
  paused: boolean;
  pending_admin: Option<string>;
  rent_extend_to: u32;
  rent_threshold: u32;
  token_suffix: string;
}


/**
 * What `position(user)` returns.
 */
export interface Position {
  pending_deposit: i128;
  pending_deposit_finalized: boolean;
  pending_deposit_round: u32;
  pending_withdraw_round: u32;
  pending_withdraw_shares: i128;
  share_value: i128;
  shares: i128;
  withdraw_claimable: i128;
}


/**
 * What `epoch()` returns. `phase` is effective, not stored.
 */
export interface EpochInfo {
  auction_end: u64;
  current_premium_bps: u32;
  expiry: u64;
  last_finalize_time: u64;
  last_pps: i128;
  locked_assets: i128;
  next_open_at: u64;
  notional_offered: i128;
  notional_sold: i128;
  open_twap: i128;
  opened_at: u64;
  outcome_pending: boolean;
  params: EpochParams;
  phase: Phase;
  premium_collected: i128;
  round: u32;
  shares_outstanding: i128;
  strike: i128;
  void_available_at: u64;
}


/**
 * What `config()` returns.
 */
export interface ConfigView {
  admin: string;
  allowlist_enabled: boolean;
  allowlist_expires_at: u64;
  app_version: u32;
  asset: string;
  deposit_cap: i128;
  deposit_headroom: i128;
  fee_bps: u32;
  fee_claimable: i128;
  fee_recipient: string;
  oracle: string;
  params: EpochParams;
  paused: boolean;
  pending_admin: Option<string>;
  rent_extend_to: u32;
  rent_threshold: u32;
}

/**
 * Why a round was annulled.
 */
export type VoidReason = {tag: "FeedUnusable", values: void} | {tag: "InvalidPrice", values: void};


/**
 * The parameters governing one epoch. A change takes effect from the next one.
 */
export interface EpochParams {
  auction_duration: u64;
  epoch_duration: u64;
  guard_window: u64;
  max_deviation_bps: u32;
  max_staleness: u64;
  min_deposit: i128;
  min_fill: i128;
  min_idle_gap: u64;
  oracle_dead_after: u64;
  premium_floor_bps: u32;
  premium_start_bps: u32;
  settle_bounty_bps: u32;
  settle_grace: u64;
  strike_bps_otm: u32;
  twap_window: u64;
  unresolved_after: u64;
}

/**
 * How a round ended.
 */
export type RoundOutcome = {tag: "Settled", values: void} | {tag: "Lapsed", values: void} | {tag: "Voided", values: void} | {tag: "Unresolved", values: void};


/**
 * What `bidder_position(round, bidder)` returns. Zeroed when that address never filled.
 */
export interface BidderPosition {
  claimable: i128;
  claimed: boolean;
  notional: i128;
  premium_paid: i128;
}


/**
 * A deposit waiting for the live round to end. Cancellable at any time.
 */
export interface PendingDeposit {
  amount: i128;
  round: u32;
}


/**
 * A withdrawal waiting for its round to finalize. The shares are already burned.
 */
export interface PendingWithdraw {
  round: u32;
  shares: i128;
}

export const Errors = {
  1: {message:"Paused"},
  2: {message:"WrongPhase"},
  /**
   * The gap between rounds has not elapsed yet.
   */
  3: {message:"IdleGapNotElapsed"},
  4: {message:"NotExpired"},
  6: {message:"OracleNotDeadYet"},
  7: {message:"NothingOffered"},
  /**
   * The vault has never had a deposit, so there is nothing to write options against.
   */
  8: {message:"NoShares"},
  9: {message:"RoundNotFound"},
  10: {message:"OracleStale"},
  11: {message:"OracleDeviation"},
  12: {message:"OracleInvalidPrice"},
  13: {message:"OracleUnreachable"},
  20: {message:"BelowMinDeposit"},
  21: {message:"DepositCapExceeded"},
  22: {message:"NothingPending"},
  /**
   * An earlier queued deposit is still unredeemed. Redeem it between rounds first.
   */
  24: {message:"UnredeemedPending"},
  25: {message:"InsufficientShares"},
  26: {message:"NothingToClaim"},
  /**
   * The round this withdrawal belongs to has not finalized yet.
   */
  27: {message:"WithdrawNotSettled"},
  29: {message:"InsufficientAllowance"},
  36: {message:"InsufficientBalance"},
  37: {message:"AlreadyClaimed"},
  38: {message:"NoFill"},
  39: {message:"WrongOutcome"},
  44: {message:"ZeroShares"},
  30: {message:"AllowlistForbidden"},
  31: {message:"PremiumAboveMax"},
  32: {message:"BelowMinFill"},
  /**
   * Spot has reached the strike; the vault will not sell intrinsic value.
   */
  34: {message:"InTheMoney"},
  /**
   * The fill is too small to pay a premium at the current price.
   */
  35: {message:"ZeroPremium"},
  40: {message:"InvalidAmount"},
  41: {message:"InvalidParams"},
  51: {message:"MigrationOrder"},
  52: {message:"NoPendingAdmin"},
  53: {message:"InvalidAddress"},
  /**
   * The pool is worth nothing per share, so nothing can be minted. Exits still work.
   */
  54: {message:"VaultWorthless"}
}





































export type DataKey = {tag: "Config", values: void} | {tag: "State", values: void} | {tag: "AppVersion", values: void} | {tag: "Shares", values: readonly [string]} | {tag: "Allowance", values: readonly [string, string]} | {tag: "PendingDeposit", values: readonly [string]} | {tag: "PendingWithdraw", values: readonly [string]} | {tag: "Round", values: readonly [u32]} | {tag: "Fill", values: readonly [u32, string]} | {tag: "Allowed", values: readonly [string]};


export interface AllowanceValue {
  amount: i128;
  live_until_ledger: u32;
}

/**
 * The outcome of an anchored read. All three are answers; failures arrive as `Err`.
 */
export type ReadResult = {tag: "Reading", values: readonly [OracleReading]} | {tag: "Unusable", values: void} | {tag: "OutOfReach", values: void};

/**
 * Faults a price source can report. Callers treat all of them alike: retry later.
 */
export const AdapterError = {
  /**
   * The underlying feed call failed.
   */
  1: {message:"FeedUnreachable"},
  /**
   * The feed's live configuration cannot serve the requested windows.
   */
  2: {message:"BadConfig"},
  /**
   * No feed is pinned.
   */
  3: {message:"NotInitialized"}
}


/**
 * One anchored read. Prices are 1e7 fixed point; `feed_decimals` is the scale they came from.
 */
export interface OracleReading {
  /**
 * The feed's `decimals()` these prices were normalized from.
 */
feed_decimals: u32;
  /**
 * Median over the guard window, ending at the anchor.
 */
guard_twap: i128;
  /**
 * Timestamp of the newest record used.
 */
newest_ts: u64;
  /**
 * Median over the short window, ending at the anchor. The settlement price.
 */
short_twap: i128;
}

export interface Client {
  /**
   * Construct and simulate a migrate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Advance the storage schema. v1 has no target, so this always rejects.
   */
  migrate: ({to_version}: {to_version: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Replace the contract code. Does not migrate storage; see `migrate`.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Stop new risk entering. Never stops anything leaving (I8).
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_allowed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Add or remove one bidder from the allowlist. Inert once the expiry has passed.
   */
  set_allowed: ({bidder, allowed}: {bidder: string, allowed: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the protocol fee, in basis points of premium. Takes effect next epoch.
   */
  set_fee_bps: ({bps}: {bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Complete a pending admin transfer. Called by the incoming admin.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Nominate a new admin. They must call `accept_admin` before anything changes.
   */
  transfer_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_deposit_cap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the deposit cap. Zero means uncapped; below the current total is legal.
   */
  set_deposit_cap: ({cap}: {cap: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_rent_params transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the rent threshold and extension window. Takes effect from the next call.
   */
  set_rent_params: ({threshold, extend_to}: {threshold: u32, extend_to: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_epoch_params transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Replace the parameters for the **next** epoch. The live round is untouched.
   */
  set_epoch_params: ({params}: {params: EpochParams}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_recipient transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Point the accrued fee at a different address. Moves no money.
   */
  set_fee_recipient: ({recipient}: {recipient: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_allowlist_enabled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Turn the bidder allowlist on or off. Inert once the expiry has passed.
   */
  set_allowlist_enabled: ({enabled}: {enabled: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a open_epoch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Open a new round: fix the strike from the live price and put the vault into `Auction`.
   * Returns `false` if a lapse was finalized first and the open then could not proceed.
   */
  open_epoch: (options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a burn transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Destroy your own shares. Permitted in any phase.
   */
  burn: ({from, amount}: {from: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a name transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The share token's display name.
   */
  name: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a symbol transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `aXLM`, plus this instance's suffix.
   */
  symbol: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a approve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Authorize `spender` for `amount` until `live_until_ledger`.
   */
  approve: ({from, spender, amount, live_until_ledger}: {from: string, spender: string, amount: i128, live_until_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Share balance. Zero for an address that has never held any.
   */
  balance: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a decimals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Seven, matching XLM.
   */
  decimals: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Move shares. The destination may be muxed; the balance is keyed by the
   */
  transfer: ({from, to, amount}: {from: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a allowance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * How many shares `spender` may still move on `from`'s behalf.
   */
  allowance: ({from, spender}: {from: string, spender: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a burn_from transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Destroy someone's shares against an allowance.
   */
  burn_from: ({spender, from, amount}: {spender: string, from: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_from transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Move shares on someone's behalf, against an allowance.
   */
  transfer_from: ({spender, from, to, amount}: {spender: string, from: string, to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deposit XLM. Returns the shares minted, or `0` when a live round queues it.
   */
  deposit: ({from, amount}: {from: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a redeem_shares transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Turn a queued deposit into shares at the current price. Between rounds only.
   */
  redeem_shares: ({from}: {from: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a claim_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collect a queued withdrawal once its round has finalized.
   */
  claim_withdraw: ({from}: {from: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a request_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Burn shares: paid at once between rounds, otherwise queued until the round ends.
   */
  request_withdraw: ({from, shares, require_idle}: {from: string, shares: i128, require_idle: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a restore_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Refresh the storage backing a user's position. Callable by anyone.
   */
  restore_position: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_pending_deposit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Take back a queued deposit, in full. Works in any phase, including while paused.
   */
  cancel_pending_deposit: ({from}: {from: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a epoch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The current epoch, with the phase a mutating call would produce.
   */
  epoch: (options?: MethodOptions) => Promise<AssembledTransaction<EpochInfo>>

  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The configuration, plus the headroom a depositor actually has.
   */
  config: (options?: MethodOptions) => Promise<AssembledTransaction<ConfigView>>

  /**
   * Construct and simulate a position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One address's holdings, pending deposit and pending withdrawal.
   */
  position: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<Position>>

  /**
   * Construct and simulate a total_assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Capital actually backing shares.
   */
  total_assets: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a bidder_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * What one bidder holds in one round.
   */
  bidder_position: ({round, bidder}: {round: u32, bidder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BidderPosition>>>

  /**
   * Construct and simulate a price_per_share transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A finalized round's recorded price. A live round returns `last_pps`.
   */
  price_per_share: ({round}: {round: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a convert_to_shares transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Indicative conversion at the last settled price.
   */
  convert_to_shares: ({assets}: {assets: i128}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a claim_fee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collect the accrued protocol fee.
   * Only the configured `fee_recipient` may call it.
   */
  claim_fee: (options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a claim_payout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Collect what a settled round owes you on a fill you made in it.
   * Any phase, and unpausable.
   */
  claim_payout: ({round, bidder}: {round: u32, bidder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a claim_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Take back the premium you paid into a round that was voided.
   * Exactly what you paid.
   */
  claim_refund: ({round, bidder}: {round: u32, bidder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a close_round transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Close the round. Settles, voids or resolves it as unresolved, and pays the caller's bounty.
   * Anyone may call it once the round has expired.
   */
  close_round: ({bounty_to}: {bounty_to: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<RoundOutcome>>>

  /**
   * Construct and simulate a bid transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buy part of this round's offer at the current decay price.
   * Rejects rather than fill above `max_premium_bps`; returns the notional actually filled.
   */
  bid: ({bidder, notional, max_premium_bps}: {bidder: string, notional: i128, max_premium_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, asset, oracle, fee_recipient, params, token_suffix, deposit_cap, rent_threshold, rent_extend_to, allowlist_expires_at}: {admin: string, asset: string, oracle: string, fee_recipient: string, params: EpochParams, token_suffix: string, deposit_cap: i128, rent_threshold: u32, rent_extend_to: u32, allowlist_expires_at: u64},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, asset, oracle, fee_recipient, params, token_suffix, deposit_cap, rent_threshold, rent_extend_to, allowlist_expires_at}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAEVBZHZhbmNlIHRoZSBzdG9yYWdlIHNjaGVtYS4gdjEgaGFzIG5vIHRhcmdldCwgc28gdGhpcyBhbHdheXMgcmVqZWN0cy4AAAAAAAAHbWlncmF0ZQAAAAABAAAAAAAAAAp0b192ZXJzaW9uAAAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAENSZXBsYWNlIHRoZSBjb250cmFjdCBjb2RlLiBEb2VzIG5vdCBtaWdyYXRlIHN0b3JhZ2U7IHNlZSBgbWlncmF0ZWAuAAAAAAd1cGdyYWRlAAAAAAEAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADpTdG9wIG5ldyByaXNrIGVudGVyaW5nLiBOZXZlciBzdG9wcyBhbnl0aGluZyBsZWF2aW5nIChJOCkuAAAAAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAE5BZGQgb3IgcmVtb3ZlIG9uZSBiaWRkZXIgZnJvbSB0aGUgYWxsb3dsaXN0LiBJbmVydCBvbmNlIHRoZSBleHBpcnkgaGFzIHBhc3NlZC4AAAAAAAtzZXRfYWxsb3dlZAAAAAACAAAAAAAAAAZiaWRkZXIAAAAAABMAAAAAAAAAB2FsbG93ZWQAAAAAAQAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEpTZXQgdGhlIHByb3RvY29sIGZlZSwgaW4gYmFzaXMgcG9pbnRzIG9mIHByZW1pdW0uIFRha2VzIGVmZmVjdCBuZXh0IGVwb2NoLgAAAAAAC3NldF9mZWVfYnBzAAAAAAEAAAAAAAAAA2JwcwAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAEBDb21wbGV0ZSBhIHBlbmRpbmcgYWRtaW4gdHJhbnNmZXIuIENhbGxlZCBieSB0aGUgaW5jb21pbmcgYWRtaW4uAAAADGFjY2VwdF9hZG1pbgAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAExOb21pbmF0ZSBhIG5ldyBhZG1pbi4gVGhleSBtdXN0IGNhbGwgYGFjY2VwdF9hZG1pbmAgYmVmb3JlIGFueXRoaW5nIGNoYW5nZXMuAAAADnRyYW5zZmVyX2FkbWluAAAAAAABAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAEtTZXQgdGhlIGRlcG9zaXQgY2FwLiBaZXJvIG1lYW5zIHVuY2FwcGVkOyBiZWxvdyB0aGUgY3VycmVudCB0b3RhbCBpcyBsZWdhbC4AAAAAD3NldF9kZXBvc2l0X2NhcAAAAAABAAAAAAAAAANjYXAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAE1TZXQgdGhlIHJlbnQgdGhyZXNob2xkIGFuZCBleHRlbnNpb24gd2luZG93LiBUYWtlcyBlZmZlY3QgZnJvbSB0aGUgbmV4dCBjYWxsLgAAAAAAAA9zZXRfcmVudF9wYXJhbXMAAAAAAgAAAAAAAAAJdGhyZXNob2xkAAAAAAAABAAAAAAAAAAJZXh0ZW5kX3RvAAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEtSZXBsYWNlIHRoZSBwYXJhbWV0ZXJzIGZvciB0aGUgKipuZXh0KiogZXBvY2guIFRoZSBsaXZlIHJvdW5kIGlzIHVudG91Y2hlZC4AAAAAEHNldF9lcG9jaF9wYXJhbXMAAAABAAAAAAAAAAZwYXJhbXMAAAAAB9AAAAALRXBvY2hQYXJhbXMAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAD1Qb2ludCB0aGUgYWNjcnVlZCBmZWUgYXQgYSBkaWZmZXJlbnQgYWRkcmVzcy4gTW92ZXMgbm8gbW9uZXkuAAAAAAAAEXNldF9mZWVfcmVjaXBpZW50AAAAAAAAAQAAAAAAAAAJcmVjaXBpZW50AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEZUdXJuIHRoZSBiaWRkZXIgYWxsb3dsaXN0IG9uIG9yIG9mZi4gSW5lcnQgb25jZSB0aGUgZXhwaXJ5IGhhcyBwYXNzZWQuAAAAAAAVc2V0X2FsbG93bGlzdF9lbmFibGVkAAAAAAAAAQAAAAAAAAAHZW5hYmxlZAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAKpPcGVuIGEgbmV3IHJvdW5kOiBmaXggdGhlIHN0cmlrZSBmcm9tIHRoZSBsaXZlIHByaWNlIGFuZCBwdXQgdGhlIHZhdWx0IGludG8gYEF1Y3Rpb25gLgpSZXR1cm5zIGBmYWxzZWAgaWYgYSBsYXBzZSB3YXMgZmluYWxpemVkIGZpcnN0IGFuZCB0aGUgb3BlbiB0aGVuIGNvdWxkIG5vdCBwcm9jZWVkLgAAAAAACm9wZW5fZXBvY2gAAAAAAAAAAAABAAAD6QAAAAEAAAAD",
        "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",
        "AAAAAQAAAB5XaGF0IGBwb3NpdGlvbih1c2VyKWAgcmV0dXJucy4AAAAAAAAAAAAIUG9zaXRpb24AAAAIAAAAAAAAAA9wZW5kaW5nX2RlcG9zaXQAAAAACwAAAAAAAAAZcGVuZGluZ19kZXBvc2l0X2ZpbmFsaXplZAAAAAAAAAEAAAAAAAAAFXBlbmRpbmdfZGVwb3NpdF9yb3VuZAAAAAAAAAQAAAAAAAAAFnBlbmRpbmdfd2l0aGRyYXdfcm91bmQAAAAAAAQAAAAAAAAAF3BlbmRpbmdfd2l0aGRyYXdfc2hhcmVzAAAAAAsAAAAAAAAAC3NoYXJlX3ZhbHVlAAAAAAsAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAASd2l0aGRyYXdfY2xhaW1hYmxlAAAAAAAL",
        "AAAAAQAAADlXaGF0IGBlcG9jaCgpYCByZXR1cm5zLiBgcGhhc2VgIGlzIGVmZmVjdGl2ZSwgbm90IHN0b3JlZC4AAAAAAAAAAAAACUVwb2NoSW5mbwAAAAAAABMAAAAAAAAAC2F1Y3Rpb25fZW5kAAAAAAYAAAAAAAAAE2N1cnJlbnRfcHJlbWl1bV9icHMAAAAABAAAAAAAAAAGZXhwaXJ5AAAAAAAGAAAAAAAAABJsYXN0X2ZpbmFsaXplX3RpbWUAAAAAAAYAAAAAAAAACGxhc3RfcHBzAAAACwAAAAAAAAANbG9ja2VkX2Fzc2V0cwAAAAAAAAsAAAAAAAAADG5leHRfb3Blbl9hdAAAAAYAAAAAAAAAEG5vdGlvbmFsX29mZmVyZWQAAAALAAAAAAAAAA1ub3Rpb25hbF9zb2xkAAAAAAAACwAAAAAAAAAJb3Blbl90d2FwAAAAAAAACwAAAAAAAAAJb3BlbmVkX2F0AAAAAAAABgAAAAAAAAAPb3V0Y29tZV9wZW5kaW5nAAAAAAEAAAAAAAAABnBhcmFtcwAAAAAH0AAAAAtFcG9jaFBhcmFtcwAAAAAAAAAABXBoYXNlAAAAAAAH0AAAAAVQaGFzZQAAAAAAAAAAAAARcHJlbWl1bV9jb2xsZWN0ZWQAAAAAAAALAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAAEnNoYXJlc19vdXRzdGFuZGluZwAAAAAACwAAAAAAAAAGc3RyaWtlAAAAAAALAAAAAAAAABF2b2lkX2F2YWlsYWJsZV9hdAAAAAAAAAY=",
        "AAAAAQAAABhXaGF0IGBjb25maWcoKWAgcmV0dXJucy4AAAAAAAAACkNvbmZpZ1ZpZXcAAAAAABAAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAARYWxsb3dsaXN0X2VuYWJsZWQAAAAAAAABAAAAAAAAABRhbGxvd2xpc3RfZXhwaXJlc19hdAAAAAYAAAAAAAAAC2FwcF92ZXJzaW9uAAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAALZGVwb3NpdF9jYXAAAAAACwAAAAAAAAAQZGVwb3NpdF9oZWFkcm9vbQAAAAsAAAAAAAAAB2ZlZV9icHMAAAAABAAAAAAAAAANZmVlX2NsYWltYWJsZQAAAAAAAAsAAAAAAAAADWZlZV9yZWNpcGllbnQAAAAAAAATAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAABnBhcmFtcwAAAAAH0AAAAAtFcG9jaFBhcmFtcwAAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAAAAAANcGVuZGluZ19hZG1pbgAAAAAAA+gAAAATAAAAAAAAAA5yZW50X2V4dGVuZF90bwAAAAAABAAAAAAAAAAOcmVudF90aHJlc2hvbGQAAAAAAAQ=",
        "AAAAAgAAABlXaHkgYSByb3VuZCB3YXMgYW5udWxsZWQuAAAAAAAAAAAAAApWb2lkUmVhc29uAAAAAAACAAAAAAAAAAAAAAAMRmVlZFVudXNhYmxlAAAAAAAAAAAAAAAMSW52YWxpZFByaWNl",
        "AAAAAQAAAExUaGUgcGFyYW1ldGVycyBnb3Zlcm5pbmcgb25lIGVwb2NoLiBBIGNoYW5nZSB0YWtlcyBlZmZlY3QgZnJvbSB0aGUgbmV4dCBvbmUuAAAAAAAAAAtFcG9jaFBhcmFtcwAAAAAQAAAAAAAAABBhdWN0aW9uX2R1cmF0aW9uAAAABgAAAAAAAAAOZXBvY2hfZHVyYXRpb24AAAAAAAYAAAAAAAAADGd1YXJkX3dpbmRvdwAAAAYAAAAAAAAAEW1heF9kZXZpYXRpb25fYnBzAAAAAAAABAAAAAAAAAANbWF4X3N0YWxlbmVzcwAAAAAAAAYAAAAAAAAAC21pbl9kZXBvc2l0AAAAAAsAAAAAAAAACG1pbl9maWxsAAAACwAAAAAAAAAMbWluX2lkbGVfZ2FwAAAABgAAAAAAAAARb3JhY2xlX2RlYWRfYWZ0ZXIAAAAAAAAGAAAAAAAAABFwcmVtaXVtX2Zsb29yX2JwcwAAAAAAAAQAAAAAAAAAEXByZW1pdW1fc3RhcnRfYnBzAAAAAAAABAAAAAAAAAARc2V0dGxlX2JvdW50eV9icHMAAAAAAAAEAAAAAAAAAAxzZXR0bGVfZ3JhY2UAAAAGAAAAAAAAAA5zdHJpa2VfYnBzX290bQAAAAAABAAAAAAAAAALdHdhcF93aW5kb3cAAAAABgAAAAAAAAAQdW5yZXNvbHZlZF9hZnRlcgAAAAY=",
        "AAAAAgAAABJIb3cgYSByb3VuZCBlbmRlZC4AAAAAAAAAAAAMUm91bmRPdXRjb21lAAAABAAAAAAAAAAAAAAAB1NldHRsZWQAAAAAAAAAAAAAAAAGTGFwc2VkAAAAAAAAAAAAAAAAAAZWb2lkZWQAAAAAAAAAAAAAAAAAClVucmVzb2x2ZWQAAA==",
        "AAAAAQAAAFVXaGF0IGBiaWRkZXJfcG9zaXRpb24ocm91bmQsIGJpZGRlcilgIHJldHVybnMuIFplcm9lZCB3aGVuIHRoYXQgYWRkcmVzcyBuZXZlciBmaWxsZWQuAAAAAAAAAAAAAA5CaWRkZXJQb3NpdGlvbgAAAAAABAAAAAAAAAAJY2xhaW1hYmxlAAAAAAAACwAAAAAAAAAHY2xhaW1lZAAAAAABAAAAAAAAAAhub3Rpb25hbAAAAAsAAAAAAAAADHByZW1pdW1fcGFpZAAAAAs=",
        "AAAAAQAAAEVBIGRlcG9zaXQgd2FpdGluZyBmb3IgdGhlIGxpdmUgcm91bmQgdG8gZW5kLiBDYW5jZWxsYWJsZSBhdCBhbnkgdGltZS4AAAAAAAAAAAAADlBlbmRpbmdEZXBvc2l0AAAAAAACAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAABXJvdW5kAAAAAAAABA==",
        "AAAAAQAAAE5BIHdpdGhkcmF3YWwgd2FpdGluZyBmb3IgaXRzIHJvdW5kIHRvIGZpbmFsaXplLiBUaGUgc2hhcmVzIGFyZSBhbHJlYWR5IGJ1cm5lZC4AAAAAAAAAAAAPUGVuZGluZ1dpdGhkcmF3AAAAAAIAAAAAAAAABXJvdW5kAAAAAAAABAAAAAAAAAAGc2hhcmVzAAAAAAAL",
        "AAAAAAAAAEtEZXBvc2l0IFhMTS4gUmV0dXJucyB0aGUgc2hhcmVzIG1pbnRlZCwgb3IgYDBgIHdoZW4gYSBsaXZlIHJvdW5kIHF1ZXVlcyBpdC4AAAAAB2RlcG9zaXQAAAAAAgAAAAAAAAAEZnJvbQAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAClEZXBsb3kgdGhlIHZhdWx0LiBSdW5zIG9uY2UsIGF0IGNyZWF0aW9uLgAAAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAACgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABm9yYWNsZQAAAAAAEwAAAAAAAAANZmVlX3JlY2lwaWVudAAAAAAAABMAAAAAAAAABnBhcmFtcwAAAAAH0AAAAAtFcG9jaFBhcmFtcwAAAAAAAAAADHRva2VuX3N1ZmZpeAAAABAAAAAAAAAAC2RlcG9zaXRfY2FwAAAAAAsAAAAAAAAADnJlbnRfdGhyZXNob2xkAAAAAAAEAAAAAAAAAA5yZW50X2V4dGVuZF90bwAAAAAABAAAAAAAAAAUYWxsb3dsaXN0X2V4cGlyZXNfYXQAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAExUdXJuIGEgcXVldWVkIGRlcG9zaXQgaW50byBzaGFyZXMgYXQgdGhlIGN1cnJlbnQgcHJpY2UuIEJldHdlZW4gcm91bmRzIG9ubHkuAAAADXJlZGVlbV9zaGFyZXMAAAAAAAABAAAAAAAAAARmcm9tAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAADlDb2xsZWN0IGEgcXVldWVkIHdpdGhkcmF3YWwgb25jZSBpdHMgcm91bmQgaGFzIGZpbmFsaXplZC4AAAAAAAAOY2xhaW1fd2l0aGRyYXcAAAAAAAEAAAAAAAAABGZyb20AAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAFBCdXJuIHNoYXJlczogcGFpZCBhdCBvbmNlIGJldHdlZW4gcm91bmRzLCBvdGhlcndpc2UgcXVldWVkIHVudGlsIHRoZSByb3VuZCBlbmRzLgAAABByZXF1ZXN0X3dpdGhkcmF3AAAAAwAAAAAAAAAEZnJvbQAAABMAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAMcmVxdWlyZV9pZGxlAAAAAQAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAEJSZWZyZXNoIHRoZSBzdG9yYWdlIGJhY2tpbmcgYSB1c2VyJ3MgcG9zaXRpb24uIENhbGxhYmxlIGJ5IGFueW9uZS4AAAAAABByZXN0b3JlX3Bvc2l0aW9uAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAFBUYWtlIGJhY2sgYSBxdWV1ZWQgZGVwb3NpdCwgaW4gZnVsbC4gV29ya3MgaW4gYW55IHBoYXNlLCBpbmNsdWRpbmcgd2hpbGUgcGF1c2VkLgAAABZjYW5jZWxfcGVuZGluZ19kZXBvc2l0AAAAAAABAAAAAAAAAARmcm9tAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAEBUaGUgY3VycmVudCBlcG9jaCwgd2l0aCB0aGUgcGhhc2UgYSBtdXRhdGluZyBjYWxsIHdvdWxkIHByb2R1Y2UuAAAABWVwb2NoAAAAAAAAAAAAAAEAAAfQAAAACUVwb2NoSW5mbwAAAA==",
        "AAAAAAAAAD5UaGUgY29uZmlndXJhdGlvbiwgcGx1cyB0aGUgaGVhZHJvb20gYSBkZXBvc2l0b3IgYWN0dWFsbHkgaGFzLgAAAAAABmNvbmZpZwAAAAAAAAAAAAEAAAfQAAAACkNvbmZpZ1ZpZXcAAA==",
        "AAAAAAAAAD9PbmUgYWRkcmVzcydzIGhvbGRpbmdzLCBwZW5kaW5nIGRlcG9zaXQgYW5kIHBlbmRpbmcgd2l0aGRyYXdhbC4AAAAACHBvc2l0aW9uAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAH0AAAAAhQb3NpdGlvbg==",
        "AAAAAAAAACBDYXBpdGFsIGFjdHVhbGx5IGJhY2tpbmcgc2hhcmVzLgAAAAx0b3RhbF9hc3NldHMAAAAAAAAAAQAAAAs=",
        "AAAAAAAAACNXaGF0IG9uZSBiaWRkZXIgaG9sZHMgaW4gb25lIHJvdW5kLgAAAAAPYmlkZGVyX3Bvc2l0aW9uAAAAAAIAAAAAAAAABXJvdW5kAAAAAAAABAAAAAAAAAAGYmlkZGVyAAAAAAATAAAAAQAAA+kAAAfQAAAADkJpZGRlclBvc2l0aW9uAAAAAAAD",
        "AAAAAAAAAERBIGZpbmFsaXplZCByb3VuZCdzIHJlY29yZGVkIHByaWNlLiBBIGxpdmUgcm91bmQgcmV0dXJucyBgbGFzdF9wcHNgLgAAAA9wcmljZV9wZXJfc2hhcmUAAAAAAQAAAAAAAAAFcm91bmQAAAAAAAAEAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAADBJbmRpY2F0aXZlIGNvbnZlcnNpb24gYXQgdGhlIGxhc3Qgc2V0dGxlZCBwcmljZS4AAAARY29udmVydF90b19zaGFyZXMAAAAAAAABAAAAAAAAAAZhc3NldHMAAAAAAAsAAAABAAAACw==",
        "AAAAAAAAAFJDb2xsZWN0IHRoZSBhY2NydWVkIHByb3RvY29sIGZlZS4KT25seSB0aGUgY29uZmlndXJlZCBgZmVlX3JlY2lwaWVudGAgbWF5IGNhbGwgaXQuAAAAAAAJY2xhaW1fZmVlAAAAAAAAAAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAFpDb2xsZWN0IHdoYXQgYSBzZXR0bGVkIHJvdW5kIG93ZXMgeW91IG9uIGEgZmlsbCB5b3UgbWFkZSBpbiBpdC4KQW55IHBoYXNlLCBhbmQgdW5wYXVzYWJsZS4AAAAAAAxjbGFpbV9wYXlvdXQAAAACAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAABmJpZGRlcgAAAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAFNUYWtlIGJhY2sgdGhlIHByZW1pdW0geW91IHBhaWQgaW50byBhIHJvdW5kIHRoYXQgd2FzIHZvaWRlZC4KRXhhY3RseSB3aGF0IHlvdSBwYWlkLgAAAAAMY2xhaW1fcmVmdW5kAAAAAgAAAAAAAAAFcm91bmQAAAAAAAAEAAAAAAAAAAZiaWRkZXIAAAAAABMAAAABAAAD6QAAAAsAAAAD",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAJAAAAAAAAAAGUGF1c2VkAAAAAAABAAAAAAAAAApXcm9uZ1BoYXNlAAAAAAACAAAAK1RoZSBnYXAgYmV0d2VlbiByb3VuZHMgaGFzIG5vdCBlbGFwc2VkIHlldC4AAAAAEUlkbGVHYXBOb3RFbGFwc2VkAAAAAAAAAwAAAAAAAAAKTm90RXhwaXJlZAAAAAAABAAAAAAAAAAQT3JhY2xlTm90RGVhZFlldAAAAAYAAAAAAAAADk5vdGhpbmdPZmZlcmVkAAAAAAAHAAAAUFRoZSB2YXVsdCBoYXMgbmV2ZXIgaGFkIGEgZGVwb3NpdCwgc28gdGhlcmUgaXMgbm90aGluZyB0byB3cml0ZSBvcHRpb25zIGFnYWluc3QuAAAACE5vU2hhcmVzAAAACAAAAAAAAAANUm91bmROb3RGb3VuZAAAAAAAAAkAAAAAAAAAC09yYWNsZVN0YWxlAAAAAAoAAAAAAAAAD09yYWNsZURldmlhdGlvbgAAAAALAAAAAAAAABJPcmFjbGVJbnZhbGlkUHJpY2UAAAAAAAwAAAAAAAAAEU9yYWNsZVVucmVhY2hhYmxlAAAAAAAADQAAAAAAAAAPQmVsb3dNaW5EZXBvc2l0AAAAABQAAAAAAAAAEkRlcG9zaXRDYXBFeGNlZWRlZAAAAAAAFQAAAAAAAAAOTm90aGluZ1BlbmRpbmcAAAAAABYAAABOQW4gZWFybGllciBxdWV1ZWQgZGVwb3NpdCBpcyBzdGlsbCB1bnJlZGVlbWVkLiBSZWRlZW0gaXQgYmV0d2VlbiByb3VuZHMgZmlyc3QuAAAAAAARVW5yZWRlZW1lZFBlbmRpbmcAAAAAAAAYAAAAAAAAABJJbnN1ZmZpY2llbnRTaGFyZXMAAAAAABkAAAAAAAAADk5vdGhpbmdUb0NsYWltAAAAAAAaAAAAO1RoZSByb3VuZCB0aGlzIHdpdGhkcmF3YWwgYmVsb25ncyB0byBoYXMgbm90IGZpbmFsaXplZCB5ZXQuAAAAABJXaXRoZHJhd05vdFNldHRsZWQAAAAAABsAAAAAAAAAFUluc3VmZmljaWVudEFsbG93YW5jZQAAAAAAAB0AAAAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAJAAAAAAAAAAOQWxyZWFkeUNsYWltZWQAAAAAACUAAAAAAAAABk5vRmlsbAAAAAAAJgAAAAAAAAAMV3JvbmdPdXRjb21lAAAAJwAAAAAAAAAKWmVyb1NoYXJlcwAAAAAALAAAAAAAAAASQWxsb3dsaXN0Rm9yYmlkZGVuAAAAAAAeAAAAAAAAAA9QcmVtaXVtQWJvdmVNYXgAAAAAHwAAAAAAAAAMQmVsb3dNaW5GaWxsAAAAIAAAAEVTcG90IGhhcyByZWFjaGVkIHRoZSBzdHJpa2U7IHRoZSB2YXVsdCB3aWxsIG5vdCBzZWxsIGludHJpbnNpYyB2YWx1ZS4AAAAAAAAKSW5UaGVNb25leQAAAAAAIgAAADxUaGUgZmlsbCBpcyB0b28gc21hbGwgdG8gcGF5IGEgcHJlbWl1bSBhdCB0aGUgY3VycmVudCBwcmljZS4AAAALWmVyb1ByZW1pdW0AAAAAIwAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAACgAAAAAAAAADUludmFsaWRQYXJhbXMAAAAAAAApAAAAAAAAAA5NaWdyYXRpb25PcmRlcgAAAAAAMwAAAAAAAAAOTm9QZW5kaW5nQWRtaW4AAAAAADQAAAAAAAAADkludmFsaWRBZGRyZXNzAAAAAAA1AAAAUFRoZSBwb29sIGlzIHdvcnRoIG5vdGhpbmcgcGVyIHNoYXJlLCBzbyBub3RoaW5nIGNhbiBiZSBtaW50ZWQuIEV4aXRzIHN0aWxsIHdvcmsuAAAADlZhdWx0V29ydGhsZXNzAAAAAAA2",
        "AAAABQAAAAAAAAAAAAAABEJ1cm4AAAABAAAABGJ1cm4AAAACAAAAAAAAAARmcm9tAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAA",
        "AAAABQAAAAAAAAAAAAAABE1pbnQAAAABAAAABG1pbnQAAAACAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAA",
        "AAAABQAAAAAAAAAAAAAABlBhdXNlZAAAAAAAAQAAAAZwYXVzZWQAAAAAAAEAAAAAAAAAAmJ5AAAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAB0FwcHJvdmUAAAAAAQAAAAdhcHByb3ZlAAAAAAQAAAAAAAAABGZyb20AAAATAAAAAQAAAAAAAAAHc3BlbmRlcgAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAARbGl2ZV91bnRpbF9sZWRnZXIAAAAAAAAEAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAAB1NldHRsZWQAAAAAAQAAAAdzZXR0bGVkAAAAAAkAAAAAAAAABXJvdW5kAAAAAAAABAAAAAEAAAAAAAAABHNwb3QAAAALAAAAAAAAAAAAAAAGc3RyaWtlAAAAAAALAAAAAAAAAAAAAAANbm90aW9uYWxfc29sZAAAAAAAAAsAAAAAAAAAAAAAAAxwYXlvdXRfdG90YWwAAAALAAAAAAAAAAAAAAAHcHJlbWl1bQAAAAALAAAAAAAAAAAAAAADZmVlAAAAAAsAAAAAAAAAAAAAAANwcHMAAAAACwAAAAAAAAAAAAAAB3djbGFpbXMAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACE1pZ3JhdGVkAAAAAQAAAAhtaWdyYXRlZAAAAAIAAAAAAAAADGZyb21fdmVyc2lvbgAAAAQAAAAAAAAAAAAAAAp0b192ZXJzaW9uAAAAAAAEAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAACFRyYW5zZmVyAAAAAQAAAAh0cmFuc2ZlcgAAAAMAAAAAAAAABGZyb20AAAATAAAAAQAAAAAAAAACdG8AAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAACFVucGF1c2VkAAAAAQAAAAh1bnBhdXNlZAAAAAEAAAAAAAAAAmJ5AAAAAAATAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAACFVwZ3JhZGVkAAAAAQAAAAh1cGdyYWRlZAAAAAIAAAAAAAAACXdhc21faGFzaAAAAAAAA+4AAAAgAAAAAAAAAAAAAAALYXBwX3ZlcnNpb24AAAAABAAAAAAAAAAB",
        "AAAABQAAAAAAAAAAAAAACUJpZEZpbGxlZAAAAAAAAAEAAAAKYmlkX2ZpbGxlZAAAAAAABgAAAAAAAAAFcm91bmQAAAAAAAAEAAAAAQAAAAAAAAAGYmlkZGVyAAAAAAATAAAAAQAAAAAAAAAIbm90aW9uYWwAAAALAAAAAAAAAAAAAAALcHJlbWl1bV9icHMAAAAABAAAAAAAAAAAAAAAB3ByZW1pdW0AAAAACwAAAAAAAAAAAAAAE25vdGlvbmFsX3NvbGRfYWZ0ZXIAAAAACwAAAAAAAAAC",
        "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",
        "AAAABQAAAAAAAAAAAAAADVBhcmFtc0NoYW5nZWQAAAAAAAABAAAADnBhcmFtc19jaGFuZ2VkAAAAAAABAAAAAAAAAAZwYXJhbXMAAAAAB9AAAAALRXBvY2hQYXJhbXMAAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADVBheW91dENsYWltZWQAAAAAAAABAAAADnBheW91dF9jbGFpbWVkAAAAAAADAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAABAAAAAAAAAAZiaWRkZXIAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVJlZnVuZENsYWltZWQAAAAAAAABAAAADnJlZnVuZF9jbGFpbWVkAAAAAAADAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAABAAAAAAAAAAZiaWRkZXIAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADVRyYW5zZmVyTXV4ZWQAAAAAAAABAAAACHRyYW5zZmVyAAAABAAAAAAAAAAEZnJvbQAAABMAAAABAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAAC3RvX211eGVkX2lkAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADkFsbG93ZWRDaGFuZ2VkAAAAAAABAAAAD2FsbG93ZWRfY2hhbmdlZAAAAAACAAAAAAAAAAZiaWRkZXIAAAAAABMAAAABAAAAAAAAAAdhbGxvd2VkAAAAAAEAAAAAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAAD0Vwb2NoVW5yZXNvbHZlZAAAAAABAAAAEGVwb2NoX3VucmVzb2x2ZWQAAAAGAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAABAAAAAAAAABBwcmVtaXVtX3JldGFpbmVkAAAACwAAAAAAAAAAAAAAA2ZlZQAAAAALAAAAAAAAAAAAAAADcHBzAAAAAAsAAAAAAAAAAAAAAAd3Y2xhaW1zAAAAAAsAAAAAAAAAAAAAAA9vcmFjbGVfYW5zd2VyZWQAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD1BlbmRpbmdSZWRlZW1lZAAAAAABAAAAEHBlbmRpbmdfcmVkZWVtZWQAAAAFAAAAAAAAAAR1c2VyAAAAEwAAAAEAAAAAAAAABXJvdW5kAAAAAAAABAAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAAA3BwcwAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1dpdGhkcmF3Q2xhaW1lZAAAAAABAAAAEHdpdGhkcmF3X2NsYWltZWQAAAAEAAAAAAAAAAR1c2VyAAAAEwAAAAEAAAAAAAAABXJvdW5kAAAAAAAABAAAAAAAAAAAAAAABnNoYXJlcwAAAAAACwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEEFsbG93bGlzdFRvZ2dsZWQAAAABAAAAEWFsbG93bGlzdF90b2dnbGVkAAAAAAAAAQAAAAAAAAAHZW5hYmxlZAAAAAABAAAAAAAAAAA=",
        "AAAABQAAAAAAAAAAAAAAEERlcG9zaXRDYW5jZWxsZWQAAAABAAAAEWRlcG9zaXRfY2FuY2VsbGVkAAAAAAAAAwAAAAAAAAAEdXNlcgAAABMAAAABAAAAAAAAAAVyb3VuZAAAAAAAAAQAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEFBvc2l0aW9uUmVzdG9yZWQAAAABAAAAEXBvc2l0aW9uX3Jlc3RvcmVkAAAAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEVJlbnRQYXJhbXNDaGFuZ2VkAAAAAAAAAQAAABNyZW50X3BhcmFtc19jaGFuZ2VkAAAAAAQAAAAAAAAADW9sZF90aHJlc2hvbGQAAAAAAAAEAAAAAAAAAAAAAAANbmV3X3RocmVzaG9sZAAAAAAAAAQAAAAAAAAAAAAAAA1vbGRfZXh0ZW5kX3RvAAAAAAAABAAAAAAAAAAAAAAADW5ld19leHRlbmRfdG8AAAAAAAAEAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAAEVdpdGhkcmF3UmVxdWVzdGVkAAAAAAAAAQAAABJ3aXRoZHJhd19yZXF1ZXN0ZWQAAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAQAAAAAAAAAFcm91bmQAAAAAAAAEAAAAAAAAAAAAAAAGc2hhcmVzAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE0ZlZVJlY2lwaWVudENoYW5nZWQAAAAAAQAAABVmZWVfcmVjaXBpZW50X2NoYW5nZWQAAAAAAAACAAAAAAAAAANvbGQAAAAAEwAAAAAAAAAAAAAAA25ldwAAAAATAAAAAAAAAAE=",
        "AAAABQAAAAAAAAAAAAAAFEFkbWluVHJhbnNmZXJTdGFydGVkAAAAAQAAABZhZG1pbl90cmFuc2Zlcl9zdGFydGVkAAAAAAACAAAAAAAAAAdjdXJyZW50AAAAABMAAAAAAAAAAAAAAAdwZW5kaW5nAAAAABMAAAAAAAAAAQ==",
        "AAAAAAAAAIpDbG9zZSB0aGUgcm91bmQuIFNldHRsZXMsIHZvaWRzIG9yIHJlc29sdmVzIGl0IGFzIHVucmVzb2x2ZWQsIGFuZCBwYXlzIHRoZSBjYWxsZXIncyBib3VudHkuCkFueW9uZSBtYXkgY2FsbCBpdCBvbmNlIHRoZSByb3VuZCBoYXMgZXhwaXJlZC4AAAAAAAtjbG9zZV9yb3VuZAAAAAABAAAAAAAAAAlib3VudHlfdG8AAAAAAAATAAAAAQAAA+kAAAfQAAAADFJvdW5kT3V0Y29tZQAAAAM=",
        "AAAAAAAAAJJCdXkgcGFydCBvZiB0aGlzIHJvdW5kJ3Mgb2ZmZXIgYXQgdGhlIGN1cnJlbnQgZGVjYXkgcHJpY2UuClJlamVjdHMgcmF0aGVyIHRoYW4gZmlsbCBhYm92ZSBgbWF4X3ByZW1pdW1fYnBzYDsgcmV0dXJucyB0aGUgbm90aW9uYWwgYWN0dWFsbHkgZmlsbGVkLgAAAAAAA2JpZAAAAAADAAAAAAAAAAZiaWRkZXIAAAAAABMAAAAAAAAACG5vdGlvbmFsAAAACwAAAAAAAAAPbWF4X3ByZW1pdW1fYnBzAAAAAAQAAAABAAAD6QAAAAsAAAAD",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAACgAAAAAAAAAAAAAABkNvbmZpZwAAAAAAAAAAAAAAAAAFU3RhdGUAAAAAAAAAAAAAAAAAAApBcHBWZXJzaW9uAAAAAAABAAAAAAAAAAZTaGFyZXMAAAAAAAEAAAATAAAAAQAAAAAAAAAJQWxsb3dhbmNlAAAAAAAAAgAAABMAAAATAAAAAQAAAAAAAAAOUGVuZGluZ0RlcG9zaXQAAAAAAAEAAAATAAAAAQAAAAAAAAAPUGVuZGluZ1dpdGhkcmF3AAAAAAEAAAATAAAAAQAAAAAAAAAFUm91bmQAAAAAAAABAAAABAAAAAEAAAAAAAAABEZpbGwAAAACAAAABAAAABMAAAABAAAAAAAAAAdBbGxvd2VkAAAAAAEAAAAT",
        "AAAAAQAAAAAAAAAAAAAADkFsbG93YW5jZVZhbHVlAAAAAAACAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAEWxpdmVfdW50aWxfbGVkZ2VyAAAAAAAABA==",
        "AAAAAgAAAFFUaGUgb3V0Y29tZSBvZiBhbiBhbmNob3JlZCByZWFkLiBBbGwgdGhyZWUgYXJlIGFuc3dlcnM7IGZhaWx1cmVzIGFycml2ZSBhcyBgRXJyYC4AAAAAAAAAAAAAClJlYWRSZXN1bHQAAAAAAAMAAAABAAAAEVNldHRsZW1lbnQtZ3JhZGUuAAAAAAAAB1JlYWRpbmcAAAAAAQAAB9AAAAANT3JhY2xlUmVhZGluZwAAAAAAAAAAAABETm8gc2V0dGxlbWVudC1ncmFkZSByZWNvcmRzIGluc2lkZSB0aGUgd2luZG93LiBBIGZhY3QgYWJvdXQgaGlzdG9yeS4AAAAIVW51c2FibGUAAAAAAAAAPlRoZSBhbmNob3IgaXMgb2xkZXIgdGhhbiB0aGUgZmVlZCBjYW4gc2VydmUuIEEgZmFjdCBhYm91dCBub3cuAAAAAAAKT3V0T2ZSZWFjaAAA",
        "AAAABAAAAE9GYXVsdHMgYSBwcmljZSBzb3VyY2UgY2FuIHJlcG9ydC4gQ2FsbGVycyB0cmVhdCBhbGwgb2YgdGhlbSBhbGlrZTogcmV0cnkgbGF0ZXIuAAAAAAAAAAAMQWRhcHRlckVycm9yAAAAAwAAACBUaGUgdW5kZXJseWluZyBmZWVkIGNhbGwgZmFpbGVkLgAAAA9GZWVkVW5yZWFjaGFibGUAAAAAAQAAAEFUaGUgZmVlZCdzIGxpdmUgY29uZmlndXJhdGlvbiBjYW5ub3Qgc2VydmUgdGhlIHJlcXVlc3RlZCB3aW5kb3dzLgAAAAAAAAlCYWRDb25maWcAAAAAAAACAAAAEk5vIGZlZWQgaXMgcGlubmVkLgAAAAAADk5vdEluaXRpYWxpemVkAAAAAAAD",
        "AAAAAQAAAFtPbmUgYW5jaG9yZWQgcmVhZC4gUHJpY2VzIGFyZSAxZTcgZml4ZWQgcG9pbnQ7IGBmZWVkX2RlY2ltYWxzYCBpcyB0aGUgc2NhbGUgdGhleSBjYW1lIGZyb20uAAAAAAAAAAANT3JhY2xlUmVhZGluZwAAAAAAAAQAAAA6VGhlIGZlZWQncyBgZGVjaW1hbHMoKWAgdGhlc2UgcHJpY2VzIHdlcmUgbm9ybWFsaXplZCBmcm9tLgAAAAAADWZlZWRfZGVjaW1hbHMAAAAAAAAEAAAAM01lZGlhbiBvdmVyIHRoZSBndWFyZCB3aW5kb3csIGVuZGluZyBhdCB0aGUgYW5jaG9yLgAAAAAKZ3VhcmRfdHdhcAAAAAAACwAAACRUaW1lc3RhbXAgb2YgdGhlIG5ld2VzdCByZWNvcmQgdXNlZC4AAAAJbmV3ZXN0X3RzAAAAAAAABgAAAElNZWRpYW4gb3ZlciB0aGUgc2hvcnQgd2luZG93LCBlbmRpbmcgYXQgdGhlIGFuY2hvci4gVGhlIHNldHRsZW1lbnQgcHJpY2UuAAAAAAAACnNob3J0X3R3YXAAAAAAAAs=" ]),
      options
    )
  }
  public readonly fromJSON = {
    migrate: this.txFromJSON<Result<void>>,
        upgrade: this.txFromJSON<Result<void>>,
        set_paused: this.txFromJSON<Result<void>>,
        set_allowed: this.txFromJSON<Result<void>>,
        set_fee_bps: this.txFromJSON<Result<void>>,
        accept_admin: this.txFromJSON<Result<void>>,
        transfer_admin: this.txFromJSON<Result<void>>,
        set_deposit_cap: this.txFromJSON<Result<void>>,
        set_rent_params: this.txFromJSON<Result<void>>,
        set_epoch_params: this.txFromJSON<Result<void>>,
        set_fee_recipient: this.txFromJSON<Result<void>>,
        set_allowlist_enabled: this.txFromJSON<Result<void>>,
        open_epoch: this.txFromJSON<Result<boolean>>,
        burn: this.txFromJSON<Result<void>>,
        name: this.txFromJSON<string>,
        symbol: this.txFromJSON<Result<string>>,
        approve: this.txFromJSON<Result<void>>,
        balance: this.txFromJSON<i128>,
        decimals: this.txFromJSON<u32>,
        transfer: this.txFromJSON<Result<void>>,
        allowance: this.txFromJSON<i128>,
        burn_from: this.txFromJSON<Result<void>>,
        transfer_from: this.txFromJSON<Result<void>>,
        deposit: this.txFromJSON<Result<i128>>,
        redeem_shares: this.txFromJSON<Result<i128>>,
        claim_withdraw: this.txFromJSON<Result<i128>>,
        request_withdraw: this.txFromJSON<Result<i128>>,
        restore_position: this.txFromJSON<Result<void>>,
        cancel_pending_deposit: this.txFromJSON<Result<i128>>,
        epoch: this.txFromJSON<EpochInfo>,
        config: this.txFromJSON<ConfigView>,
        position: this.txFromJSON<Position>,
        total_assets: this.txFromJSON<i128>,
        bidder_position: this.txFromJSON<Result<BidderPosition>>,
        price_per_share: this.txFromJSON<Result<i128>>,
        convert_to_shares: this.txFromJSON<i128>,
        claim_fee: this.txFromJSON<Result<i128>>,
        claim_payout: this.txFromJSON<Result<i128>>,
        claim_refund: this.txFromJSON<Result<i128>>,
        close_round: this.txFromJSON<Result<RoundOutcome>>,
        bid: this.txFromJSON<Result<i128>>
  }
}