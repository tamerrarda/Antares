/**
 * From decoded events to one epoch's evidence — and to the sweep's roster.
 *
 * Both duties read the same stream, which is why they are one module. 08-OFFCHAIN §1 gives the
 * keeper the fill index *"which addresses filled which round, and for how much"* and 03-STORAGE-TTL
 * §4 gives it a monthly bump of *"every address seen"*. Building two decoders would be the second
 * copy this project keeps removing.
 *
 * Everything here is pure: events in, records out. The network half is `getEvents` paging, which has
 * no rules in it worth testing and every rule below is a unit test.
 *
 * # I10, enforced where the record is written
 *
 * A closed round has **exactly one** terminal event — `settled`, `epoch_voided` or
 * `epoch_unresolved` — because `close_round` is one `match` over four values behind one time check.
 * The assembler refuses a round with two or with none rather than picking one, for the reason the
 * evidence file exists at all: a record that resolves an ambiguity silently is not evidence of
 * anything. Two terminal events would mean the invariant broke on-chain; none means the round has
 * not closed, and writing it as closed would put a lie in a file whose purpose is outliving the
 * chain it came from.
 */

import { hasRound, isTerminal, type DecodedEvent, type TerminalEvent } from "@antares/common/events";

import { NO_GAPS, type EpochEvidence, type Fill, type HistoryGaps, type SigmaEvidence } from "./evidence.ts";

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

/** An event with the transaction it arrived in — what the evidence record needs and decoding drops. */
export interface Located<E extends DecodedEvent = DecodedEvent> {
  readonly event: E;
  readonly txHash: string;
  readonly ledger: number;
}

/** Everything about one round, from its own events. */
export interface RoundInputs {
  readonly vault: string;
  readonly round: number;
  readonly openedAt: number;
  readonly expiry: number;
  readonly closedAt: number;
  readonly events: readonly Located[];
  readonly sigmaRealized: SigmaEvidence | null;
  /** Defaults to "nothing missing" — which must be a *claim* the caller makes, not an assumption. */
  readonly historyGaps?: HistoryGaps;
}

const OUTCOME: Record<TerminalEvent["name"], string> = {
  settled: "Settled",
  epoch_voided: "Voided",
  epoch_unresolved: "Unresolved",
  // A round that closed with no buyer. It reaches the evidence file like any other outcome: an
  // empty auction is a data point about demand (ARCHITECTURE §10), and a record that could not
  // hold one would be silent about exactly the rounds a reader most wants explained.
  epoch_lapsed: "Lapsed",
};

/**
 * The fill index — who filled this round and for how much.
 *
 * Amounts are strings because they are `i128` on-chain and JSON has no bigint: a number here would
 * round silently past `Number.MAX_SAFE_INTEGER` and the Claims page would owe somebody the wrong
 * amount. The transaction hash rides with each fill so a row can link to an explorer, which is the
 * half a testnet reset destroys.
 */
export function fillIndex(events: readonly Located[]): Fill[] {
  const out: Fill[] = [];
  for (const { event, txHash } of events) {
    if (event.name !== "bid_filled") continue;
    out.push({
      bidder: event.bidder,
      notional: event.notional.toString(),
      premium: event.premium.toString(),
      txHash,
    });
  }
  return out;
}

/** The one terminal event, or a refusal saying which way it was wrong. */
export function terminalOf(round: number, events: readonly Located[]): TerminalEvent {
  const terminals = events.map((l) => l.event).filter(isTerminal);
  if (terminals.length === 1) return terminals[0]!;
  if (terminals.length === 0) {
    throw new RecordError(
      `round ${round} has no terminal event, so it has not closed. Writing it into the evidence ` +
        `file as closed would put a claim in a record whose whole purpose is outliving the chain.`,
    );
  }
  throw new RecordError(
    `round ${round} has ${terminals.length} terminal events (${terminals.map((t) => t.name).join(", ")}). ` +
      `I10 says a round reaches at most one, so this is either the invariant broken on-chain or two ` +
      `rounds' events mixed together — and picking one would hide whichever it is.`,
  );
}

/**
 * Assemble one closed epoch.
 *
 * Every transaction hash in the round's life is carried, deduplicated but **in first-seen order**:
 * a set would lose the ordering that makes the list readable as a history, and a reader comparing
 * it against an explorer is following a sequence rather than a bag.
 */
export function epochRecord(inputs: RoundInputs): EpochEvidence {
  const foreign = inputs.events.filter((l) => hasRound(l.event) && l.event.round !== inputs.round);
  if (foreign.length > 0) {
    throw new RecordError(
      `round ${inputs.round}'s events include ${foreign.length} from other rounds ` +
        `(${[...new Set(foreign.map((f) => (hasRound(f.event) ? f.event.round : -1)))].join(", ")}). ` +
        `The fill index is what the Claims page pays people from, so a stray fill is somebody else's money.`,
    );
  }

  const terminal = terminalOf(inputs.round, inputs.events);
  const txHashes: string[] = [];
  for (const { txHash } of inputs.events) {
    if (!txHashes.includes(txHash)) txHashes.push(txHash);
  }

  return {
    vault: inputs.vault,
    round: inputs.round,
    outcome: OUTCOME[terminal.name],
    openedAt: inputs.openedAt,
    expiry: inputs.expiry,
    closedAt: inputs.closedAt,
    txHashes,
    events: inputs.events.map((l) => l.event),
    fills: fillIndex(inputs.events),
    sigmaRealized: inputs.sigmaRealized,
    historyGaps: inputs.historyGaps ?? NO_GAPS,
  };
}

/**
 * Every address the vault has seen — the sweep's roster.
 *
 * Derived from whichever events carry one rather than from a named list, so it grows on its own as
 * events are registered — but "on its own" is a property of the FIELD NAMES, and that is where this
 * went wrong. Until 2026-08-21 the match was `bidder` / `recipient` / `to`, and every depositor-side
 * event names its party `user`: `deposited`, `withdraw_requested`, `withdraw_claimed`,
 * `pending_redeemed`, `deposit_cancelled`. So registering `deposited` (dev1@29a33d9) did not add a
 * single depositor here, and could not have — while `sweep.ts` opens by saying the whole feature is
 * "bumping every known depositor once a month" and `restore_position(user)` re-bumps `Shares`,
 * `PendingDeposit` and `PendingWithdraw`, which are depositor entries and nobody else's. The sweep
 * was passing over the exact population it exists for.
 *
 * `user` is matched now, which makes the four names above the roster's larger half.
 *
 * Order is first-seen and stable, so a sweep interrupted halfway resumes over the same sequence.
 */
export function roster(events: readonly Located[]): string[] {
  const seen: string[] = [];
  const add = (a: string) => {
    if (!seen.includes(a)) seen.push(a);
  };
  for (const { event } of events) {
    if ("user" in event) add(event.user);
    if ("bidder" in event) add(event.bidder);
    if ("recipient" in event) add(event.recipient);
    if ("to" in event) add(event.to);
  }
  return seen;
}
