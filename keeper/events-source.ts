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

/**
 * Only what this module needs from `rpc.Server`, so the paging is testable without a network.
 *
 * **`topic` and `value` are already `scValToNative`-converted**, which is what {@link RawEvent}
 * documents and what every decoder in `@antares/common/events` reads. The SDK hands back
 * `xdr.ScVal`, so an adapter over the real server has to convert; one that forwards the SDK's
 * objects compiles cleanly against the `unknown[]` below and then fails at `eventName`, where every
 * event in the stream comes back as `<unnameable>`. That is the shape this interface was measured
 * producing on 2026-09-05, so the contract is stated here rather than left to the docstring on a
 * type two files away.
 */
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

/**
 * The ledger a pagination cursor sits at, or `null` if it is not a TOID.
 *
 * Stellar's TOID packs `ledger << 32 | txIndex << 12 | opIndex` into an int64, so the ledger is the
 * high half. `Number` loses precision above 2^53 and the low half is discarded anyway, so the parse
 * goes through `BigInt` and comes back down after the shift.
 */
export function cursorLedger(cursor: string): number | null {
  const head = cursor.split("-")[0];
  if (head === undefined || !/^\d+$/.test(head)) return null;
  const ledger = Number(BigInt(head) >> 32n);
  return Number.isSafeInteger(ledger) && ledger > 0 ? ledger : null;
}

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
  from: { startLedger: number | "oldest" } | { cursor: string },
): Promise<FetchResult & { readonly skipped: readonly string[] }> {
  const health = await rpc.getHealth();
  let missedLedgers = 0;
  let request: { startLedger?: number; cursor?: string };

  if ("cursor" in from) {
    request = { cursor: from.cursor };
  } else if (from.startLedger === "oldest") {
    // **The caller must not compute this itself.** `oldestLedger` moves forward as ledgers close,
    // so a caller that reads health, takes the floor, and passes it back here reads a moving number
    // twice — and the one ledger that closed in between is reported as a real shortfall. Measured:
    // a first collect against testnet came back `missedLedgers: 1`, which `Working` accumulates and
    // never resets, so that single ledger would have stamped `complete: false` on every record the
    // keeper ever wrote. One read, here, where the floor is already in hand.
    request = { startLedger: health.oldestLedger };
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

    if (res.cursor === undefined) {
      break;
    }
    cursor = res.cursor;
    request = { cursor: res.cursor };

    // **An empty page is not the end of the range**, and treating it as one was a live defect: the
    // RPC pages by a ledger window (~10 000 ledgers), not by a count of results, so a contract with
    // few events returns page after empty page while its cursor walks forward. Measured against
    // instance A on 2026-09-05: the 7-day retained window took **13 pages**, the first eleven of
    // them empty, and the two settlement events arrived on page twelve. A scan that stopped at the
    // first empty page returned nothing at all — from a contract whose events were plainly there.
    //
    // So the terminator is the cursor reaching the tip. It is read out of the cursor itself, which
    // is a TOID with the ledger in its high 32 bits; a cursor that does not parse falls through to
    // the `undefined` check and the page cap, which is why neither of those was removed.
    const at = cursorLedger(res.cursor);
    if (at !== null && at >= res.latestLedger) break;

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
