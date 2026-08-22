/**
 * The vault's own history, read from the chain by the browser.
 *
 * `packages/common/events.ts` already decodes every round-scoped event and is shared with the
 * keeper, so nothing here re-implements that. What it needs is an adapter: its `RawEvent` wants
 * `topics` and `data` **already native**, which its own doc comments say, while the RPC hands back
 * `topic` and `value` as `ScVal`s. That conversion is the whole of this file's first half.
 *
 * The second half is a limit that is not a detail. Soroban RPC retains events for a window, and
 * `getHealth()` is the only authority on where that window starts — asking for anything older
 * silently returns nothing rather than failing, which is the worst possible shape for a page whose
 * subject is "everything that has happened". So the window is read, reported, and shown to the user
 * as a boundary rather than a gap.
 */
import { rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { decodeEvent, eventName, type DecodedEvent, type RawEvent } from "@antares/common/events";

import { deployment } from "./deployment.ts";
import { network } from "./vault.ts";

export interface VaultEvent {
  readonly decoded: DecodedEvent;
  readonly txHash: string;
  readonly ledger: number;
  readonly at: Date | null;
}

export interface EventPage {
  readonly events: readonly VaultEvent[];
  /** The oldest ledger the RPC still holds. Anything before it is unreachable, not absent. */
  readonly oldestLedger: number;
  readonly latestLedger: number;
  /** How many ledgers back the node keeps events — measured 120 960 on testnet, i.e. seven days. */
  readonly retentionLedgers: number;
  /** Event names the RPC returned that this build has no decoder for — admin events, today. */
  readonly undecoded: readonly string[];
}

interface RpcEvent {
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  txHash: string;
  ledger: number;
  ledgerClosedAt?: string;
}

/** The cursor encodes `(ledger << 32) | index`; its ledger is how far the scan has actually got. */
function ledgerOf(cursor: string): number {
  const head = cursor.split("-")[0];
  if (head === undefined) return 0;
  try {
    return Number(BigInt(head) >> 32n);
  } catch {
    return 0;
  }
}

function toRaw(e: RpcEvent): RawEvent {
  return {
    topics: e.topic.map((t) => scValToNative(t) as unknown),
    data: scValToNative(e.value) as unknown,
    txHash: e.txHash,
    ledger: e.ledger,
    ...(e.ledgerClosedAt === undefined ? {} : { ledgerClosedAt: e.ledgerClosedAt }),
  };
}

/**
 * Everything the RPC still holds for this vault, newest last.
 *
 * Undecodable events are collected rather than thrown on. The contract emits admin events
 * (`paused`, `cap_changed`, `upgraded`…) that the shared decoder does not cover yet, and a history
 * page that refuses to render because it met one would be worse than one that renders the rest and
 * names what it skipped.
 */
export async function fetchEvents(env: Record<string, string | undefined> = {}): Promise<EventPage> {
  const net = network(env);
  const server = new rpc.Server(net.rpcUrl ?? "https://soroban-testnet.stellar.org");
  const [health, latest] = await Promise.all([server.getHealth(), server.getLatestLedger()]);

  // The retention window SLIDES, so `oldestLedger` is true when it is read and stale a few seconds
  // later — and asking for a ledger that has since fallen out is a hard `-32600`, not an empty page.
  // Measured: reading health and immediately querying its own floor already failed. The margin costs
  // about eight minutes of history and removes the race entirely.
  const MARGIN = 100;
  const oldest = health.oldestLedger + MARGIN;

  const events: VaultEvent[] = [];
  const undecoded = new Set<string>();
  let cursor: string | undefined;

  // An empty page is not the end. `getEvents` scans FORWARD from `startLedger` and returns at most
  // ~10 000 ledgers per call, so a vault whose first event is days into the window produces several
  // empty pages before anything appears — and each one still carries a cursor. Breaking on
  // `events.length === 0`, which is the obvious loop, returned zero events across a window that
  // actually holds eighty. The cursor's own ledger is the only honest stop condition.
  for (let page = 0; page < 40; page += 1) {
    const res = await server.getEvents({
      ...(cursor === undefined ? { startLedger: oldest } : { cursor }),
      filters: [{ type: "contract", contractIds: [deployment().vaultId] }],
      limit: 200,
    });

    for (const e of res.events) {
      const raw = toRaw(e);
      try {
        events.push({
          decoded: decodeEvent(raw),
          txHash: raw.txHash,
          ledger: raw.ledger,
          at: raw.ledgerClosedAt === undefined ? null : new Date(raw.ledgerClosedAt),
        });
      } catch {
        // An event this build cannot decode is collected, not thrown on. The contract emits admin
        // events the shared decoder does not cover yet, and a history that refuses to render
        // because it met one is worse than one that renders the rest and names what it skipped.
        try {
          undecoded.add(eventName(raw));
        } catch {
          undecoded.add("(unnamed)");
        }
      }
    }

    const next = (res as unknown as { cursor?: string }).cursor;
    if (next === undefined || next === cursor) break;
    cursor = next;
    if (ledgerOf(next) >= res.latestLedger) break;
  }

  return {
    events,
    oldestLedger: oldest,
    latestLedger: latest.sequence,
    retentionLedgers: health.ledgerRetentionWindow,
    undecoded: [...undecoded],
  };
}
