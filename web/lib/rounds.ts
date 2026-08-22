/**
 * The vault's rounds, folded out of its own events.
 *
 * Nothing here is computed by a server this project runs. Each field comes from an event the
 * contract emitted, and each round keeps the transaction that ended it — so the table this produces
 * can be rebuilt by anyone holding the contract id and no cooperation from us. That is the
 * difference between a published track record and a verifiable one, and it is why the outcomes that
 * look bad sit in the same list as the ones that do not.
 *
 * The window is a real boundary and is reported rather than hidden: Soroban RPC keeps seven days of
 * events (measured — `ledgerRetentionWindow` 120 960), so a vault older than that has rounds this
 * page cannot see. An empty row is absence; a missing round is distance.
 */
import type { DecodedEvent } from "@antares/common/events";

import type { VaultEvent } from "./events.ts";

export type Outcome = "settled" | "lapsed" | "voided" | "unresolved" | "running";

export interface RoundRecord {
  readonly round: number;
  readonly outcome: Outcome;
  readonly openedAt: number | null;
  readonly expiry: number | null;
  readonly strike: bigint | null;
  readonly notionalOffered: bigint | null;
  readonly notionalSold: bigint;
  /** What buyers actually paid, summed from fills — zero for a round nobody bought. */
  readonly premium: bigint;
  /** Settled rounds only: what the vault paid the buyer, in cash. */
  readonly payout: bigint | null;
  /** Annulled rounds only: the premium handed back. */
  readonly refunded: bigint | null;
  readonly settledSpot: bigint | null;
  /** Price per share after the round finalised. */
  readonly ppsAfter: bigint | null;
  /** The transaction that ended the round — the row's own evidence. */
  readonly terminalTx: string | null;
  readonly terminalAt: Date | null;
  readonly bidders: number;
}

interface Draft {
  round: number;
  outcome: Outcome;
  openedAt: number | null;
  expiry: number | null;
  strike: bigint | null;
  notionalOffered: bigint | null;
  notionalSold: bigint;
  premium: bigint;
  payout: bigint | null;
  refunded: bigint | null;
  settledSpot: bigint | null;
  ppsAfter: bigint | null;
  terminalTx: string | null;
  terminalAt: Date | null;
  bidders: Set<string>;
}

function blank(round: number): Draft {
  return {
    round,
    outcome: "running",
    openedAt: null,
    expiry: null,
    strike: null,
    notionalOffered: null,
    notionalSold: 0n,
    premium: 0n,
    payout: null,
    refunded: null,
    settledSpot: null,
    ppsAfter: null,
    terminalTx: null,
    terminalAt: null,
    bidders: new Set<string>(),
  };
}

/** Newest round first, which is the order a reader wants and the reverse of the fold. */
export function foldRounds(events: readonly VaultEvent[]): readonly RoundRecord[] {
  const drafts = new Map<number, Draft>();
  const get = (round: number): Draft => {
    const found = drafts.get(round) ?? blank(round);
    drafts.set(round, found);
    return found;
  };

  for (const { decoded, txHash, at } of events) {
    const e: DecodedEvent = decoded;
    switch (e.name) {
      case "epoch_opened": {
        const d = get(e.round);
        d.openedAt = e.openedAt;
        d.expiry = e.expiry;
        d.strike = e.strike;
        d.notionalOffered = e.notionalOffered;
        break;
      }
      case "bid_filled": {
        const d = get(e.round);
        d.premium += e.premium;
        d.notionalSold = e.notionalSoldAfter;
        d.bidders.add(e.bidder);
        break;
      }
      case "settled": {
        const d = get(e.round);
        d.outcome = "settled";
        d.payout = e.payoutTotal;
        d.settledSpot = e.spot;
        d.ppsAfter = e.pps;
        d.terminalTx = txHash;
        d.terminalAt = at;
        break;
      }
      case "epoch_lapsed": {
        const d = get(e.round);
        d.outcome = "lapsed";
        d.ppsAfter = e.pps;
        d.terminalTx = txHash;
        d.terminalAt = at;
        break;
      }
      case "epoch_voided": {
        const d = get(e.round);
        d.outcome = "voided";
        d.refunded = e.premiumRefunded;
        d.ppsAfter = e.pps;
        d.terminalTx = txHash;
        d.terminalAt = at;
        break;
      }
      case "epoch_unresolved": {
        const d = get(e.round);
        d.outcome = "unresolved";
        d.ppsAfter = e.pps;
        d.terminalTx = txHash;
        d.terminalAt = at;
        break;
      }
      default:
        break;
    }
  }

  return [...drafts.values()]
    .sort((a, b) => b.round - a.round)
    .map((d) => ({ ...d, bidders: d.bidders.size }));
}

/** What each ending is called in the interface. Never the enum, and never red. */
export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = {
  settled: "Settled",
  lapsed: "No buyer",
  voided: "Annulled",
  unresolved: "Unresolved",
  running: "Running",
};
