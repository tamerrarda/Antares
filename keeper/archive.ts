/**
 * The link between "events happened" and "a file exists that outlives the chain".
 *
 * 09-DEPLOYMENT §3 requires this **before the first public end-to-end epoch**, not after: D2's
 * evidence is transaction hashes, a testnet reset erases them, and producing that evidence with no
 * archive in place is the failure the deployment playbook exists to prevent. So this is not
 * bookkeeping that can follow the mechanism — it has to be running when the mechanism first runs.
 *
 * # Accumulate forward, finalize at the close
 *
 * The RPC keeps ~7 days of events and an epoch is 3 to 14. **A round's opening is already
 * unreadable by the time it closes**, so the archive cannot be built by fetching a round's history
 * at settlement — it is built by appending as the round runs, exactly like the σ samples and for
 * exactly the same reason.
 *
 * That makes the working state the one thing here that is *not* reconstructable from the chain,
 * which is why it is written to disk beside the evidence rather than held in memory. 08-OFFCHAIN's
 * "stateless against the chain" is about not keeping a *second source of truth* for things the chain
 * already knows; this is the opposite case — a record of things the chain is about to forget.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { hasRound } from "@antares/common/events";

import { appendEpoch, historyGaps, type SigmaEvidence } from "./evidence.ts";
import { epochRecord, type Located } from "./record.ts";

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** What the archive is holding for one vault between passes. */
export interface Working {
  /** Where to resume reading. `null` before the first fetch. */
  readonly cursor: string | null;
  /** Events not yet finalized, keyed by round. */
  readonly rounds: Record<string, Located[]>;
  /** Ledgers lost to the retention window, accumulated across passes. */
  readonly missedLedgers: number;
  /** Event names seen and not decoded, accumulated. */
  readonly skipped: readonly string[];
}

export const EMPTY: Working = { cursor: null, rounds: {}, missedLedgers: 0, skipped: [] };

export interface WorkingStore {
  load(vault: string): Working;
  save(vault: string, state: Working): void;
}

/** Working state on disk, beside the evidence it becomes. */
export function fileStore(root: string): WorkingStore {
  const path = (vault: string) => join(root, ".working", `${vault}.json`);
  return {
    load(vault) {
      const p = path(vault);
      if (!existsSync(p)) return EMPTY;
      const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        throw new ArchiveError(`${p} is not archive state; refusing to overwrite it`);
      }
      return parsed as Working;
    },
    save(vault, state) {
      const p = path(vault);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify(state, bigintSafe, 2)}\n`);
    },
  };
}

/** `bigint` survives a round trip as a decimal string; `JSON.stringify` refuses it outright. */
function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/**
 * Fold a pass's events into the working state.
 *
 * **Events with no round are dropped, not stored under a placeholder.** `fee_claimed` is the only
 * one today; it belongs to a recipient rather than to a round, so filing it under some round would
 * put it in an evidence record it is not part of.
 *
 * Duplicates are dropped by `(txHash, name, round)`. A pass that overlaps the previous one — a
 * restart, a cursor replayed — must not double an entry in the fill index, because that index is
 * what the Claims page pays from.
 */
export function observe(
  state: Working,
  events: readonly Located[],
  cursor: string | null,
  missedLedgers: number,
  skipped: readonly string[],
): Working {
  const rounds: Record<string, Located[]> = {};
  for (const [k, v] of Object.entries(state.rounds)) rounds[k] = [...v];

  for (const located of events) {
    const ev = located.event;
    if (!hasRound(ev)) continue;
    const key = String(ev.round);
    const bucket = (rounds[key] ??= []);
    // The identity of an entry is `(txHash, name, round)`. Written as a named predicate rather than
    // inline because the narrowing from `hasRound` does not survive a `&&` chain, and the version
    // that silently widened back to `DecodedEvent` compiled under `--experimental-strip-types` and
    // failed only at `tsc` — the third time this block that the test run and the type check
    // disagreed.
    const sameEntry = (b: Located): boolean =>
      b.txHash === located.txHash &&
      b.event.name === ev.name &&
      hasRound(b.event) &&
      b.event.round === ev.round;
    if (!bucket.some(sameEntry)) bucket.push(located);
  }

  return {
    cursor: cursor ?? state.cursor,
    rounds,
    missedLedgers: state.missedLedgers + missedLedgers,
    skipped: [...new Set([...state.skipped, ...skipped])],
  };
}

export interface FinalizeInputs {
  readonly vault: string;
  readonly network: string;
  readonly round: number;
  readonly openedAt: number;
  readonly expiry: number;
  readonly closedAt: number;
  readonly sigmaRealized: SigmaEvidence | null;
}

/**
 * Write one round's evidence and forget it.
 *
 * The round's bucket is cleared **only after the append succeeds**. `appendEpoch` refuses a
 * duplicate rather than overwriting, so a crash between the write and the clear leaves the bucket
 * in place and the next attempt is refused loudly instead of silently writing the round twice —
 * which is the behaviour you want from something whose output is evidence.
 */
export function finalize(
  root: string,
  store: WorkingStore,
  inputs: FinalizeInputs,
): { path: string; state: Working } {
  const state = store.load(inputs.vault);
  const key = String(inputs.round);
  const events = state.rounds[key];
  if (events === undefined || events.length === 0) {
    throw new ArchiveError(
      `no events held for round ${inputs.round} of ${inputs.vault}. Either the keeper was not ` +
        `running while it ran, or the round was already finalized — and writing an empty record ` +
        `would claim a history that was never observed.`,
    );
  }

  const record = epochRecord({
    vault: inputs.vault,
    round: inputs.round,
    openedAt: inputs.openedAt,
    expiry: inputs.expiry,
    closedAt: inputs.closedAt,
    events,
    sigmaRealized: inputs.sigmaRealized,
    historyGaps: historyGaps(state.missedLedgers, state.skipped),
  });

  const path = appendEpoch(root, inputs.network, record);

  const rounds: Record<string, Located[]> = {};
  for (const [k, v] of Object.entries(state.rounds)) if (k !== key) rounds[k] = v;
  const next: Working = { ...state, rounds };
  store.save(inputs.vault, next);
  return { path, state: next };
}
