/**
 * Reading events off the chain, in pages, with the horizon made visible.
 *
 * # The horizon is the whole problem
 *
 * Soroban RPC keeps roughly **seven days** of events — measured here at `ledgerRetentionWindow:
 * 120 960` over a 4 117 340 … 4 238 299 range. An epoch is **3 to 14 days**. So for anything but the
 * shortest instance, **the opening of a round is already unreadable by the time it closes**, and a
 * keeper that fetched a round's history at settlement would find part of it and no indication that
 * the rest ever existed.
 *
 * That is why this reads **forward, incrementally, from a cursor** rather than backward from a
 * close. The same shape as the σ sampler and for the same reason: what the window drops cannot be
 * fetched again by anybody, so it has to be collected while it is still there.
 *
 * # A partial range is refused, never clamped
 *
 * `getEvents` errors when `startLedger` is below `oldestLedger` rather than silently truncating —
 * good, and not enough. A caller that catches that and retries from `oldestLedger` gets a range
 * that **looks complete and is not**, which is the exact failure `decodeEvent` refuses to make when
 * it throws on an unregistered name: *a thrown error is a visible gap; a skipped one is invisible*.
 * So {@link fetchSince} reports the shortfall as a value rather than papering over it, and the
 * caller decides — the evidence writer records the gap in the file, which is the only honest thing
 * to do with history nobody can recover.
 */

import { decodeEvent, eventName, type RawEvent } from "@antares/common/events";

import type { Located } from "./record.ts";

export class EventSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventSourceError";
  }
}

/** Only what this module needs from `rpc.Server`, so the paging is testable without a network. */
export interface RpcLike {
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>;
  getEvents(request: {
    startLedger?: number;
    cursor?: string;
    filters: { type: "contract"; contractIds: string[] }[];
    limit?: number;
  }): Promise<{
    events: {
      contractId?: { toString(): string } | string;
      topic: unknown[];
      value: unknown;
      txHash: string;
      ledger: number;
    }[];
    cursor?: string;
    latestLedger: number;
  }>;
}

export interface FetchResult {
  readonly events: readonly Located[];
  /** Where to resume. Pass as `cursor` next time; `null` when the page had nothing. */
  readonly cursor: string | null;
  /** The newest ledger the RPC had when this ran. */
  readonly latestLedger: number;
  /**
   * Ledgers requested but already dropped by the retention window, or 0.
   *
   * **Non-zero means history was lost, not that the fetch failed.** Nobody can recover it — not us,
   * not a reviewer — so it belongs in the record beside the events rather than in a log line.
   */
  readonly missedLedgers: number;
  /** The oldest ledger the RPC still holds, so a caller can see how close the horizon is. */
  readonly oldestLedger: number;
}

/** How many events a page asks for. The RPC caps this; the loop pages until the cursor runs out. */
export const PAGE_LIMIT = 200;

/** A hard stop on paging, so a misconfigured cursor cannot spin forever against a shared endpoint. */
export const MAX_PAGES = 50;

const asRaw = (e: { topic: unknown[]; value: unknown; txHash: string; ledger: number }): RawEvent => ({
  topics: e.topic,
  data: e.value,
  txHash: e.txHash,
  ledger: e.ledger,
});

/**
 * Every event from `startLedger` (or `cursor`) to now, decoded, in order.
 *
 * **Events from other modules are skipped by name, deliberately and explicitly.** `decodeEvent`
 * throws on an unregistered name because skipping is data loss dressed as tolerance — but a keeper
 * reading a vault that also emits DEV1's and DEV3's events has to pass over the ones it has no
 * decoder for *without* that being silent. So the filter is on {@link eventName} against the
 * registry, the skipped names are returned, and the caller can see exactly what it did not read.
 */
export async function fetchSince(
  rpc: RpcLike,
  contractIds: readonly string[],
  from: { startLedger: number } | { cursor: string },
): Promise<FetchResult & { readonly skipped: readonly string[] }> {
  const health = await rpc.getHealth();
  let missedLedgers = 0;
  let request: { startLedger?: number; cursor?: string };

  if ("cursor" in from) {
    request = { cursor: from.cursor };
  } else {
    if (from.startLedger < health.oldestLedger) {
      // Reported, not thrown and not clamped. The caller still wants what survives; what it must
      // not get is a range that reads as whole.
      missedLedgers = health.oldestLedger - from.startLedger;
      request = { startLedger: health.oldestLedger };
    } else {
      request = { startLedger: from.startLedger };
    }
  }

  const events: Located[] = [];
  const skipped = new Set<string>();
  let cursor: string | null = null;
  let latestLedger = health.latestLedger;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await rpc.getEvents({
      ...request,
      filters: [{ type: "contract", contractIds: [...contractIds] }],
      limit: PAGE_LIMIT,
    });
    latestLedger = res.latestLedger;

    for (const e of res.events) {
      const raw = asRaw(e);
      let name: string;
      try {
        name = eventName(raw);
      } catch {
        // A topic list we cannot even read a name from is malformed, not foreign. Counted under a
        // sentinel rather than dropped, because "we could not tell what this was" is information.
        skipped.add("<unnameable>");
        continue;
      }
      try {
        events.push({ event: decodeEvent(raw), txHash: e.txHash, ledger: e.ledger });
      } catch {
        skipped.add(name);
      }
    }

    if (res.cursor === undefined || res.events.length === 0) {
      cursor = res.cursor ?? cursor;
      break;
    }
    cursor = res.cursor;
    request = { cursor: res.cursor };

    if (page === MAX_PAGES - 1) {
      throw new EventSourceError(
        `stopped after ${MAX_PAGES} pages with a cursor still open. Either the range is far larger ` +
          `than a keeper pass should cover, or the cursor is not advancing — and spinning against a ` +
          `shared endpoint is the failure mode that would take the RPC down for everyone.`,
      );
    }
  }

  return {
    events,
    cursor,
    latestLedger,
    missedLedgers,
    oldestLedger: health.oldestLedger,
    skipped: [...skipped],
  };
}
