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

function asAddress(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new EventDecodeError(`${what} is not an address string`);
  }
  return value;
}

function asBool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new EventDecodeError(`${what} is not a boolean`);
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

export type DecodedEvent =
  | EpochOpened
  | BidFilled
  | PayoutClaimed
  | RefundClaimed
  | FeeClaimed
  | Settled
  | EpochVoided
  | EpochUnresolved
  | FeeAccrued
  | SettleBounty;

/** Every event with a `round` — everything except `fee_claimed`. */
export type RoundScopedEvent = Exclude<DecodedEvent, FeeClaimed>;

export function hasRound(ev: DecodedEvent): ev is RoundScopedEvent {
  return ev.name !== "fee_claimed";
}

/** The three terminal outcomes — exactly one of these exists per closed round (I10). */
export type TerminalEvent = Settled | EpochVoided | EpochUnresolved;

export function isTerminal(ev: DecodedEvent): ev is TerminalEvent {
  return ev.name === "settled" || ev.name === "epoch_voided" || ev.name === "epoch_unresolved";
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
