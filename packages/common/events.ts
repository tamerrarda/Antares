/**
 * Event decoding — the off-chain half of `02-CONTRACT-SPEC.md` §10.
 *
 * §10 is a **frozen public ABI**, not logging: *"The web UI and any indexer reconstruct state from
 * them"*, and an integration scenario rebuilds the auction from events alone. So a decoder is not a
 * convenience layer — it is the thing that makes the frozen shape checkable off-chain, and a field
 * silently dropped here is indistinguishable from a field the contract never emitted.
 *
 * # Where the SDK boundary sits, and why it is here rather than inside this file
 *
 * RPC hands back XDR `ScVal`s. Converting those to JavaScript is `scValToNative`'s job and it lives
 * in `@stellar/stellar-sdk`, which the keeper, the bidder and the web app all depend on already.
 * This module deliberately starts **one step later**, at native values, for two reasons that are
 * about testability rather than taste: every decoder below can then be driven to reject on a
 * malformed payload in a plain unit test with no network and no XDR fixture, and `packages/common`
 * stays installable and typecheckable without the SDK's type surface. The caller passes
 * `topics.map(scValToNative)` and `scValToNative(value)`; everything after that is here.
 *
 * # Ownership
 *
 * `DEV-PROTOCOL.md` §3 splits §10 **by the module that emits**, not by one owner — so the decoder
 * entries follow the same split. Registered below are the four events DEV3 emits (`bid_filled`,
 * `payout_claimed`, `refund_claimed`, `fee_claimed`) plus `epoch_opened`, which DEV2 emits and DEV3
 * decodes: `DEV3.md` §3 puts reviewing that payload on DEV3 precisely because *"your reference
 * bidder and the UI decode it"*. DEV1's and DEV2's remaining events are theirs to register, in this
 * file, and the registry is open rather than exhaustive so that a missing entry is a visible gap
 * instead of a silent `undefined`.
 */

/** A native-valued event as it arrives from RPC after `scValToNative`. */
export interface RawEvent {
  /** `topics.map(scValToNative)` — the first is always the event name (§10: the struct name). */
  readonly topics: readonly unknown[];
  /** `scValToNative(value)` — §10's data map. */
  readonly data: unknown;
  readonly txHash: string;
  readonly ledger: number;
  /** ISO timestamp of the ledger close, when RPC supplied one. */
  readonly ledgerClosedAt?: string;
}

export class EventDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventDecodeError";
  }
}

// ------------------------------------------------------------------- primitives ---
//
// Amounts are i128 stroops and round numbers are u32 (`02-CONTRACT-SPEC.md` §2). `scValToNative`
// gives a `bigint` for i128 and a `number` for u32, and the two must not be quietly interchanged:
// a stroop amount coerced to `number` loses precision above 2^53, which is 900 million XLM — far
// above the deposit cap, but the cap is a parameter and precision loss that depends on a parameter
// is a defect waiting for a setter. Amounts stay `bigint` all the way to the formatter.

function field(data: unknown, name: string): unknown {
  if (typeof data !== "object" || data === null) {
    throw new EventDecodeError(`event data is not a map (got ${typeof data})`);
  }
  if (!(name in (data as Record<string, unknown>))) {
    throw new EventDecodeError(`event data is missing field "${name}"`);
  }
  return (data as Record<string, unknown>)[name];
}

function asAmount(data: unknown, name: string): bigint {
  const v = field(data, name);
  if (typeof v === "bigint") return v;
  // An i128 that happens to fit is sometimes handed over as a number; accept it, but never a float.
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  throw new EventDecodeError(`field "${name}" is not an integer amount (got ${typeof v})`);
}

function asU32(value: unknown, what: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > 0xffff_ffffn) throw new EventDecodeError(`${what} out of u32 range`);
    return Number(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff) {
    return value;
  }
  throw new EventDecodeError(`${what} is not a u32 (got ${typeof value})`);
}

function asBool(value: unknown, what: string): boolean {
  // Strict rather than truthy. `scValToNative` gives a real boolean for an
  // `ScvBool`, so anything else here means the payload is not the shape §10
  // declares — and a coerced `undefined` would silently read as `false`, which for
  // `instant` is the difference between "the depositor holds shares now" and "they
  // hold a pending claim". That is not a field to be relaxed about.
  if (typeof value !== "boolean") {
    throw new EventDecodeError(`${what}: expected a boolean, got ${typeof value}`);
  }
  return value;
}

function asAddress(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new EventDecodeError(`${what} is not an address string`);
  }
  return value;
}

/**
 * A Soroban unit-variant enum, as `scValToNative` renders it.
 *
 * `VoidReason` has no payload, so it arrives as a bare string — but a *payloaded* variant would
 * arrive as `["Tag", …]`, and a decoder that assumed one shape would silently produce `undefined`
 * for the other. Both are handled and anything else throws, because a reason that decodes to
 * nothing is worse than one that fails to decode: `epoch_voided` is how an indexer learns **why**
 * a round was annulled, and D-60 exists because those two reasons are not interchangeable.
 */
function asVariant(value: unknown, what: string, allowed: readonly string[]): string {
  const tag: unknown =
    typeof value === "string" ? value : Array.isArray(value) ? (value as unknown[])[0] : undefined;
  if (typeof tag !== "string" || !allowed.includes(tag)) {
    throw new EventDecodeError(`${what} is not one of ${allowed.join(" | ")} (got ${JSON.stringify(value)})`);
  }
  return tag;
}

function topic(ev: RawEvent, index: number, what: string): unknown {
  if (index >= ev.topics.length) {
    throw new EventDecodeError(
      `expected a "${what}" topic at position ${index} but the event carries ${ev.topics.length} topics`,
    );
  }
  return ev.topics[index];
}

// ------------------------------------------------------------------- the events ---

export interface EpochOpened {
  readonly name: "epoch_opened";
  readonly round: number;
  readonly strike: bigint;
  readonly expiry: number;
  readonly openedAt: number;
  readonly auctionEnd: number;
  readonly notionalOffered: bigint;
  readonly openTwap: bigint;
  readonly premiumStartBps: number;
  readonly premiumFloorBps: number;
}

export interface BidFilled {
  readonly name: "bid_filled";
  readonly round: number;
  readonly bidder: string;
  readonly notional: bigint;
  readonly premiumBps: number;
  readonly premium: bigint;
  readonly notionalSoldAfter: bigint;
}

export interface PayoutClaimed {
  readonly name: "payout_claimed";
  readonly round: number;
  readonly bidder: string;
  readonly amount: bigint;
}

export interface RefundClaimed {
  readonly name: "refund_claimed";
  readonly round: number;
  readonly bidder: string;
  readonly amount: bigint;
}

/**
 * `("fee_claimed", recipient)` — **no round topic**, and that is normative rather than an omission:
 * §10 records that `claim_fee` *"spans rounds and therefore carries no round"*. A decoder that
 * invented one would make the fee look like a per-round balance, which is exactly the wrong mental
 * model for the fifth forgettable balance.
 */
export interface FeeClaimed {
  readonly name: "fee_claimed";
  readonly recipient: string;
  readonly amount: bigint;
}

export interface Deposited {
  readonly name: "deposited";
  readonly user: string;
  readonly round: number;
  readonly amount: bigint;
  readonly sharesMinted: bigint;
  /**
   * `true` when the deposit minted immediately (the vault was Idle), `false` when
   * it went to the pending pool to be redeemed at a later price.
   *
   * D-18 is why the flag exists rather than being inferable: shares minted while a
   * round is live would acquire a claim on P&L their capital never backed, so a
   * mid-round deposit mints nothing until Idle. A consumer that treats every
   * `deposited` as a mint reports share balances that do not exist yet.
   */
  readonly instant: boolean;
}
/**
 * The three terminal outcomes, and the two payments that ride with them.
 *
 * Registered by DEV2 under this file's own rule — *"DEV1's and DEV2's remaining events are theirs to
 * register, in this file"*. These five are what the keeper's evidence record is made of: without
 * them a closed epoch can be seen to have happened and not seen to have happened *a particular way*,
 * and the whole point of `evidence/<date>-<network>.json` is that a reset destroys the chain state
 * while the record survives.
 */
export interface Settled {
  readonly name: "settled";
  readonly round: number;
  /** The median TWAP over the windows ending at **expiry** — not the price when close was called. */
  readonly spot: bigint;
  readonly strike: bigint;
  readonly notionalSold: bigint;
  readonly payoutTotal: bigint;
  readonly premium: bigint;
  readonly fee: bigint;
  readonly pps: bigint;
  readonly wclaims: bigint;
}

export interface EpochVoided {
  readonly name: "epoch_voided";
  readonly round: number;
  /** `FeedUnusable` or `InvalidPrice`. D-60 exists because the two are not interchangeable. */
  readonly reason: "FeedUnusable" | "InvalidPrice";
  /** The whole premium: each fill gets its own back exactly, with no pro-rata arithmetic. */
  readonly premiumRefunded: bigint;
  readonly pps: bigint;
  readonly wclaims: bigint;
}

export interface EpochUnresolved {
  readonly name: "epoch_unresolved";
  readonly round: number;
  readonly premiumRetained: bigint;
  readonly fee: bigint;
  readonly pps: bigint;
  readonly wclaims: bigint;
  /**
   * Which of D-64's two entrances resolved the round: `false` when the clock alone did it with no
   * oracle call, `true` when the adapter answered `OutOfReach`. Diagnostic — it enters no
   * computation, and it is the only place the difference between "the feed aged out" and "the
   * adapter is broken" is recorded.
   */
  readonly oracleAnswered: boolean;
}

/**
 * The fourth finalization outcome: an auction nobody bid in.
 *
 * Registered here beside its three siblings, but it is DEV1's by DEV-PROTOCOL §3's rule — which
 * splits §10 by the **call path that arrives**. `finalize_round` emits all four, but the lapse
 * comes through `lazy_finalize` in `vault.rs` while `settled`, `epoch_voided` and
 * `epoch_unresolved` come through `close_round` in `settle.rs`. That split is why this one was the
 * last of the four left without a decoder, and it is not a difference an indexer can see.
 *
 * It carries no payment, and the contract is why: `lazy_finalize` only lapses a round when
 * `notional_sold == 0`, so there is no payout to credit, no fee to accrue and no premium to refund.
 * `pps` is the round's unchanged `last_pps`, and `wclaims` is the withdrawal-queue credit that
 * **all four** finalization events carry — the field most easily left out, since no on-chain
 * assertion needs it.
 */
export interface EpochLapsed {
  readonly name: "epoch_lapsed";
  readonly round: number;
  readonly notionalOffered: bigint;
  readonly pps: bigint;
  readonly wclaims: bigint;
}

export interface FeeAccrued {
  readonly name: "fee_accrued";
  readonly round: number;
  readonly amount: bigint;
}

export interface SettleBounty {
  readonly name: "settle_bounty";
  readonly round: number;
  readonly to: string;
  readonly amount: bigint;
}

export interface WithdrawRequested {
  readonly name: "withdraw_requested";
  readonly user: string;
  readonly round: number;
  readonly shares: bigint;
}

export interface WithdrawClaimed {
  readonly name: "withdraw_claimed";
  readonly user: string;
  readonly round: number;
  readonly shares: bigint;
  readonly amount: bigint;
}

export interface PendingRedeemed {
  readonly name: "pending_redeemed";
  readonly user: string;
  readonly round: number;
  readonly amount: bigint;
  readonly shares: bigint;
  readonly pps: bigint;
}

export interface DepositCancelled {
  readonly name: "deposit_cancelled";
  readonly user: string;
  readonly round: number;
  readonly amount: bigint;
}

export type DecodedEvent =
  | EpochOpened
  | BidFilled
  | PayoutClaimed
  | RefundClaimed
  | FeeClaimed
  | Deposited
  | WithdrawRequested
  | WithdrawClaimed
  | PendingRedeemed
  | DepositCancelled
  | Settled
  | EpochVoided
  | EpochUnresolved
  | EpochLapsed
  | FeeAccrued
  | SettleBounty;

/** Every event with a `round` — everything except `fee_claimed`. */
export type RoundScopedEvent = Exclude<DecodedEvent, FeeClaimed>;

export function hasRound(ev: DecodedEvent): ev is RoundScopedEvent {
  return ev.name !== "fee_claimed";
}

/**
 * The four terminal outcomes — exactly one of these exists per closed round (I10).
 *
 * `epoch_lapsed` belongs here for the same reason as the other three: a lapsed round is CLOSED —
 * `finalize_round` sets `phase = Idle` and stamps `last_finalize_time` — it just closed without a
 * buyer. Leaving it out made `terminalOf` report an empty auction as a round that "has not closed".
 */
export type TerminalEvent = Settled | EpochVoided | EpochUnresolved | EpochLapsed;

export function isTerminal(ev: DecodedEvent): ev is TerminalEvent {
  return (
    ev.name === "settled" ||
    ev.name === "epoch_voided" ||
    ev.name === "epoch_unresolved" ||
    ev.name === "epoch_lapsed"
  );
}

type Decoder = (ev: RawEvent) => DecodedEvent;

const DECODERS: Readonly<Record<string, Decoder>> = {
  epoch_opened: (ev) => ({
    name: "epoch_opened",
    round: asU32(topic(ev, 1, "round"), "epoch_opened round"),
    strike: asAmount(ev.data, "strike"),
    expiry: asU32(field(ev.data, "expiry"), "expiry"),
    openedAt: asU32(field(ev.data, "opened_at"), "opened_at"),
    auctionEnd: asU32(field(ev.data, "auction_end"), "auction_end"),
    notionalOffered: asAmount(ev.data, "notional_offered"),
    openTwap: asAmount(ev.data, "open_twap"),
    premiumStartBps: asU32(field(ev.data, "premium_start_bps"), "premium_start_bps"),
    premiumFloorBps: asU32(field(ev.data, "premium_floor_bps"), "premium_floor_bps"),
  }),

  bid_filled: (ev) => ({
    name: "bid_filled",
    round: asU32(topic(ev, 1, "round"), "bid_filled round"),
    bidder: asAddress(topic(ev, 2, "bidder"), "bid_filled bidder"),
    notional: asAmount(ev.data, "notional"),
    premiumBps: asU32(field(ev.data, "premium_bps"), "premium_bps"),
    premium: asAmount(ev.data, "premium"),
    notionalSoldAfter: asAmount(ev.data, "notional_sold_after"),
  }),

  payout_claimed: (ev) => ({
    name: "payout_claimed",
    round: asU32(topic(ev, 1, "round"), "payout_claimed round"),
    bidder: asAddress(topic(ev, 2, "bidder"), "payout_claimed bidder"),
    amount: asAmount(ev.data, "amount"),
  }),

  refund_claimed: (ev) => ({
    name: "refund_claimed",
    round: asU32(topic(ev, 1, "round"), "refund_claimed round"),
    bidder: asAddress(topic(ev, 2, "bidder"), "refund_claimed bidder"),
    amount: asAmount(ev.data, "amount"),
  }),

  fee_claimed: (ev) => ({
    name: "fee_claimed",
    recipient: asAddress(topic(ev, 1, "recipient"), "fee_claimed recipient"),
    amount: asAmount(ev.data, "amount"),
  }),

  // DEV1's, registered 2026-08-20 under this file's own carve-out. The sweep's
  // roster derives from the event shape rather than a name list, so depositors join
  // it the day this lands — until now it saw bidders only, and depositors are the
  // larger half.
  // **The withdrawal half of Phase 6a's chain.** The gate runs
  // deposit -> open -> fill -> close -> premium -> withdrawal, and until these two
  // existed the harness could not decode the step it ends on: `fetchSince` skipped
  // them by name and returned the names, so nothing threw and the totals came out
  // wrong by an unknown amount. DEV3 wrote the diff to refuse outright when a
  // state-affecting event cannot be decoded, which is why the gate was closed rather
  // than quietly incorrect.
  withdraw_requested: (ev) => ({
    name: "withdraw_requested",
    user: asAddress(topic(ev, 1, "user"), "withdraw_requested user"),
    round: asU32(field(ev.data, "round"), "withdraw_requested round"),
    shares: asAmount(ev.data, "shares"),
  }),

  withdraw_claimed: (ev) => ({
    name: "withdraw_claimed",
    user: asAddress(topic(ev, 1, "user"), "withdraw_claimed user"),
    round: asU32(field(ev.data, "round"), "withdraw_claimed round"),
    shares: asAmount(ev.data, "shares"),
    amount: asAmount(ev.data, "amount"),
  }),

  // Same list, same owner. `pending_redeemed` carries the price its shares were
  // minted at, which is the field that makes a mid-round deposit's conversion
  // auditable from events alone rather than only reproducible.
  pending_redeemed: (ev) => ({
    name: "pending_redeemed",
    user: asAddress(topic(ev, 1, "user"), "pending_redeemed user"),
    round: asU32(field(ev.data, "round"), "pending_redeemed round"),
    amount: asAmount(ev.data, "amount"),
    shares: asAmount(ev.data, "shares"),
    pps: asAmount(ev.data, "pps"),
  }),

  deposit_cancelled: (ev) => ({
    name: "deposit_cancelled",
    user: asAddress(topic(ev, 1, "user"), "deposit_cancelled user"),
    round: asU32(field(ev.data, "round"), "deposit_cancelled round"),
    amount: asAmount(ev.data, "amount"),
  }),

  deposited: (ev) => ({
    name: "deposited",
    user: asAddress(topic(ev, 1, "user"), "deposited user"),
    round: asU32(field(ev.data, "round"), "deposited round"),
    amount: asAmount(ev.data, "amount"),
    sharesMinted: asAmount(ev.data, "shares_minted"),
    instant: asBool(field(ev.data, "instant"), "deposited instant"),
  }),

  // The lapse is DEV1's by the call-path rule above, so it sits on this side of the divider.
  epoch_lapsed: (ev) => ({
    name: "epoch_lapsed",
    round: asU32(topic(ev, 1, "round"), "epoch_lapsed round"),
    notionalOffered: asAmount(ev.data, "notional_offered"),
    pps: asAmount(ev.data, "pps"),
    wclaims: asAmount(ev.data, "wclaims"),
  }),

  // -- DEV2's, registered here under this file's own rule ---------------------------------------

  settled: (ev) => ({
    name: "settled",
    round: asU32(topic(ev, 1, "round"), "settled round"),
    spot: asAmount(ev.data, "spot"),
    strike: asAmount(ev.data, "strike"),
    notionalSold: asAmount(ev.data, "notional_sold"),
    payoutTotal: asAmount(ev.data, "payout_total"),
    premium: asAmount(ev.data, "premium"),
    fee: asAmount(ev.data, "fee"),
    pps: asAmount(ev.data, "pps"),
    wclaims: asAmount(ev.data, "wclaims"),
  }),

  epoch_voided: (ev) => ({
    name: "epoch_voided",
    round: asU32(topic(ev, 1, "round"), "epoch_voided round"),
    reason: asVariant(field(ev.data, "reason"), "epoch_voided reason", [
      "FeedUnusable",
      "InvalidPrice",
    ]) as EpochVoided["reason"],
    premiumRefunded: asAmount(ev.data, "premium_refunded"),
    pps: asAmount(ev.data, "pps"),
    wclaims: asAmount(ev.data, "wclaims"),
  }),

  epoch_unresolved: (ev) => ({
    name: "epoch_unresolved",
    round: asU32(topic(ev, 1, "round"), "epoch_unresolved round"),
    premiumRetained: asAmount(ev.data, "premium_retained"),
    fee: asAmount(ev.data, "fee"),
    pps: asAmount(ev.data, "pps"),
    wclaims: asAmount(ev.data, "wclaims"),
    oracleAnswered: asBool(field(ev.data, "oracle_answered"), "oracle_answered"),
  }),

  fee_accrued: (ev) => ({
    name: "fee_accrued",
    round: asU32(topic(ev, 1, "round"), "fee_accrued round"),
    amount: asAmount(ev.data, "amount"),
  }),

  settle_bounty: (ev) => ({
    name: "settle_bounty",
    round: asU32(topic(ev, 1, "round"), "settle_bounty round"),
    to: asAddress(field(ev.data, "to"), "settle_bounty to"),
    amount: asAmount(ev.data, "amount"),
  }),
};

/** The event names this module can decode today. */
export function decodableEventNames(): readonly string[] {
  return Object.keys(DECODERS);
}

export function eventName(ev: RawEvent): string {
  const first = topic(ev, 0, "event name");
  if (typeof first !== "string" || first === "") {
    throw new EventDecodeError("the first topic is not an event-name symbol");
  }
  return first;
}

/**
 * Decode one event, or throw.
 *
 * **An unregistered event name throws rather than returning `null`.** The alternative reads as
 * tolerance and behaves as data loss: `08-OFFCHAIN.md` §1 has components reconstructing state from
 * events, and an indexer that skips what it does not recognise reports a consistent view of an
 * incomplete history. A thrown error is a visible gap; a skipped event is an invisible one. Callers
 * that genuinely want to ignore other modules' events filter on {@link eventName} first, which makes
 * the choice explicit at the call site.
 */
export function decodeEvent(ev: RawEvent): DecodedEvent {
  const name = eventName(ev);
  const decoder = DECODERS[name];
  if (decoder === undefined) {
    throw new EventDecodeError(
      `no decoder registered for event "${name}". §10 is a frozen ABI and DEV-PROTOCOL §3 splits it ` +
        `by emitting module, so the entry belongs to whoever emits it — registered here: ` +
        `${decodableEventNames().join(", ")}.`,
    );
  }
  return decoder(ev);
}

/**
 * The decay curve's inputs, recovered from `epoch_opened`.
 *
 * `DEV3.md` §7.1 requires the reference bidder to read the curve *"from `epoch_opened`'s event data
 * — it carries every input the decay curve needs"*, and §10 says the payload deliberately does.
 * **Checked rather than assumed, because one of the four is not a field.** `premium_bps(t) = start −
 * (start − floor) × (t − opened_at) / auction_duration` needs `start`, `floor`, `opened_at` and
 * `auction_duration`; the payload carries the first three and **`auction_duration` only by
 * derivation, as `auction_end − opened_at`.** So the claim holds, and it holds by subtraction rather
 * than by a field — which is worth stating once, here, so that nobody later reads the payload
 * looking for a duration, fails to find it, and concludes the event is incomplete.
 *
 * This is not the curve. `curve_ref.py` is DEV1's and `auction.rs` is the authority
 * (`DEV-PROTOCOL.md` §4); this only recovers the arguments.
 */
export function curveInputs(ev: EpochOpened): {
  readonly startBps: number;
  readonly floorBps: number;
  readonly openedAt: number;
  readonly auctionDuration: number;
} {
  const auctionDuration = ev.auctionEnd - ev.openedAt;
  if (auctionDuration <= 0) {
    throw new EventDecodeError(
      `epoch_opened for round ${ev.round} has auction_end <= opened_at, so auction_duration is ` +
        `${auctionDuration}; the curve's divisor cannot be recovered from it.`,
    );
  }
  return {
    startBps: ev.premiumStartBps,
    floorBps: ev.premiumFloorBps,
    openedAt: ev.openedAt,
    auctionDuration,
  };
}

// =================================================================================================
// Administrative events
// =================================================================================================
//
// Deliberately a **separate union** from `DecodedEvent`, and the reason is structural rather than
// tidy. `RoundScopedEvent` is `Exclude<DecodedEvent, FeeClaimed>` and `hasRound` implements it as
// `name !== "fee_claimed"`. Add `paused` to `DecodedEvent` and that guard starts returning `true`
// for an event with no round, handing every caller — the keeper, `reconstruct.ts` — a type that
// claims a field which is not there. The two vocabularies are genuinely different: one is about
// rounds, the other about the operator. Keeping them apart is what keeps `hasRound` honest.
//
// **Only shapes verified against the live contract are decoded.** The spec's §14 table lists more
// than these, but it also describes `upgraded` as a map `{wasm_hash, app_version}` and the chain
// emits a positional tuple — measured 2026-08-22 on the testnet instance. A decoder written from
// the table for an event nobody has produced yet would be a guess that fails the first time it
// matters, so the rest arrive through `UnrecognisedAdminEvent` and are shown with their raw fields
// instead of hidden. An operator log that omits an admin action because the reader did not
// anticipate its shape is worse than one that admits it does not understand it.

/** The full configuration a vault was born with — the only place an events-only reader can learn it. */
export interface Initialized {
  readonly name: "initialized";
  readonly admin: string;
  readonly asset: string;
  readonly oracle: string;
  readonly feeRecipient: string;
  readonly depositCap: bigint;
  readonly feeBps: number;
  readonly allowlistEnabled: boolean;
  readonly allowlistExpiresAt: number;
  readonly appVersion: number;
  readonly paused: boolean;
}

export interface Paused {
  readonly name: "paused";
  readonly by: string;
}

export interface Unpaused {
  readonly name: "unpaused";
  readonly by: string;
}

export interface AllowedChanged {
  readonly name: "allowed_changed";
  readonly bidder: string;
  readonly allowed: boolean;
}

export interface Upgraded {
  readonly name: "upgraded";
  /** Hex, so it can be compared against a build's own hash by eye. */
  readonly wasmHash: string;
  /** The version *before* the upgrade — `migrate` is what moves it. */
  readonly appVersion: number;
}

/** Permissionless, not administrative — but it belongs in the same log: somebody did maintenance. */
export interface PositionRestored {
  readonly name: "position_restored";
  readonly user: string;
}

/** An admin-gated call this build has no verified decoder for. Shown, never swallowed. */
export interface UnrecognisedAdminEvent {
  readonly name: string;
  readonly unrecognised: true;
  readonly topics: readonly unknown[];
  readonly data: unknown;
}

export type AdminEvent =
  Initialized | Paused | Unpaused | AllowedChanged | Upgraded | PositionRestored | UnrecognisedAdminEvent;

export function isUnrecognised(ev: AdminEvent): ev is UnrecognisedAdminEvent {
  return "unrecognised" in ev;
}

/**
 * Names the contract emits that are neither round events nor operator actions.
 *
 * `mint` and `burn` are SEP-41 token events — every deposit and every exit produces one. They are
 * real and they are not the operator doing anything, so an operator log that listed them would bury
 * seven admin calls under a hundred share movements.
 */
const TOKEN_EVENTS: ReadonlySet<string> = new Set([
  "mint",
  "burn",
  "transfer",
  "approve",
  "clawback",
  "set_authorized",
]);

export function isTokenEvent(name: string): boolean {
  return TOKEN_EVENTS.has(name);
}

function asBytesHex(value: unknown, what: string): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  // `in` already narrows `value`, so no assertion is needed to reach `data`. Shape check first:
  // scValToNative hands a Buffer-like object back for bytes in some environments and a Uint8Array
  // in others, and the decoder has to survive both.
  if (typeof value === "object" && value !== null && "data" in value && Array.isArray(value.data)) {
    return Buffer.from(value.data).toString("hex");
  }
  throw new EventDecodeError(`${what} is not a byte string`);
}

const ADMIN_DECODERS: Readonly<Record<string, (ev: RawEvent) => AdminEvent>> = {
  initialized: (ev) => ({
    name: "initialized",
    admin: asAddress(field(ev.data, "admin"), "initialized admin"),
    asset: asAddress(field(ev.data, "asset"), "initialized asset"),
    oracle: asAddress(field(ev.data, "oracle"), "initialized oracle"),
    feeRecipient: asAddress(field(ev.data, "fee_recipient"), "initialized fee_recipient"),
    depositCap: asAmount(ev.data, "deposit_cap"),
    feeBps: asU32(field(ev.data, "fee_bps"), "fee_bps"),
    allowlistEnabled: asBool(field(ev.data, "allowlist_enabled"), "allowlist_enabled"),
    allowlistExpiresAt: Number(asAmount(ev.data, "allowlist_expires_at")),
    appVersion: asU32(field(ev.data, "app_version"), "app_version"),
    paused: asBool(field(ev.data, "paused"), "paused"),
  }),

  paused: (ev) => ({ name: "paused", by: asAddress(field(ev.data, "by"), "paused by") }),
  unpaused: (ev) => ({ name: "unpaused", by: asAddress(field(ev.data, "by"), "unpaused by") }),

  allowed_changed: (ev) => ({
    name: "allowed_changed",
    bidder: asAddress(topic(ev, 1, "allowed_changed bidder"), "allowed_changed bidder"),
    // The whole payload is the boolean — there is no map to take a field from.
    allowed: asBool(ev.data, "allowed_changed allowed"),
  }),

  // Positional, not a map. The §14 table says `{wasm_hash, app_version}`; the chain emits a tuple.
  upgraded: (ev) => {
    if (!Array.isArray(ev.data) || ev.data.length < 2) {
      throw new EventDecodeError("upgraded payload is not a (wasm_hash, app_version) tuple");
    }
    return {
      name: "upgraded",
      wasmHash: asBytesHex(ev.data[0], "upgraded wasm_hash"),
      appVersion: asU32(ev.data[1], "upgraded app_version"),
    };
  },

  position_restored: (ev) => ({
    name: "position_restored",
    user: asAddress(topic(ev, 1, "position_restored user"), "position_restored user"),
  }),
};

/** True for a name this module decodes as an administrative event. */
export function isAdminEventName(name: string): boolean {
  return name in ADMIN_DECODERS;
}

/**
 * Decode an operator-facing event, or admit that it cannot.
 *
 * Never throws for an unknown name: the point of the log is completeness, and a name this build
 * does not know is still an admin action somebody took. It returns the raw fields so the page can
 * show what happened even when it cannot say it in words.
 */
export function decodeAdminEvent(ev: RawEvent): AdminEvent {
  const name = eventName(ev);
  const decoder = ADMIN_DECODERS[name];
  if (decoder === undefined) {
    return { name, unrecognised: true, topics: ev.topics, data: ev.data };
  }
  try {
    return decoder(ev);
  } catch {
    // A shape that changed under us is exactly the case the fallback exists for.
    return { name, unrecognised: true, topics: ev.topics, data: ev.data };
  }
}
