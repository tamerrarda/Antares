/**
 * `evidence/<date>-<network>.json` — the record that outlives the chain it came from.
 *
 * 09-DEPLOYMENT §3: a testnet reset destroys public tx-hash evidence of closed epochs, and the
 * Rounds page and D2's claim both rest on it. 08-OFFCHAIN §1 puts the writing here, in the keeper,
 * and says why it cannot live in `integration/`: that harness only runs during Phase 6, while the
 * Claims page needs the fill index for rounds older than the RPC event window — measured at ~7 days,
 * which is barely one round on instance A.
 *
 * So this file answers three questions that nothing else can answer later:
 *
 * 1. **What happened** — the event log and the tx hashes, which survive a reset that the chain
 *    state does not.
 * 2. **Who is owed** — the fill index: which address filled which round and for how much. A bidder
 *    who looks a round late finds nothing in RPC; this is where the Claims page gets the range.
 * 3. **Whether the gate was met** — σ_realized *and the series it was computed from*, so a third
 *    party recomputes the number rather than trusting it (D-67).
 *
 * # Append, never rewrite
 *
 * One file per UTC date per network, holding every epoch that closed that day. A closed epoch is a
 * fact and facts do not get edited, so writing is append-only and re-writing an epoch that is
 * already present is refused rather than overwritten — the same rule I7 enforces on-chain, for the
 * same reason: a record that can be corrected silently is not evidence.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SigmaResult, Sample } from "./sigma.ts";

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

/** One bidder's participation in one round — the Claims page's unit of discovery. */
export interface Fill {
  readonly bidder: string;
  /** Stroops of notional filled. String, because these are i128 on-chain and JSON has no bigint. */
  readonly notional: string;
  readonly premium: string;
  /** The transaction the fill landed in, so the row links to an explorer. */
  readonly txHash: string;
}

/** σ_realized, published with everything needed to recompute it. */
export interface SigmaEvidence {
  readonly sigma: number;
  readonly returns: number;
  readonly droppedForGaps: number;
  readonly completeness: number;
  /**
   * The samples themselves, not a summary. D-67 is explicit that the series is published so the
   * gate can be recomputed by someone checking our work — and the feed's ~21 h reachable depth
   * means nobody, including us, can fetch it again afterwards.
   */
  readonly samples: readonly Sample[];
  readonly feedId: string;
  readonly resolution: number;
  readonly decimals: number;
}

export interface EpochEvidence {
  readonly vault: string;
  readonly round: number;
  readonly outcome: string;
  readonly openedAt: number;
  readonly expiry: number;
  readonly closedAt: number;
  /** Every tx hash in this round's life — open, fills, close. The half a reset destroys. */
  readonly txHashes: readonly string[];
  /** The decoded events, as emitted. */
  readonly events: readonly unknown[];
  readonly fills: readonly Fill[];
  /**
   * Absent when the keeper was not running for the whole epoch. Recorded as `null` rather than
   * omitted, because "we did not sample" and "the field does not exist" are different facts and
   * only one of them is a gap in the evidence.
   */
  readonly sigmaRealized: SigmaEvidence | null;
}

export interface EvidenceFile {
  readonly _what: string;
  readonly network: string;
  readonly date: string;
  readonly epochs: readonly EpochEvidence[];
}

const WHAT =
  "Closed-epoch evidence written by the keeper (08-OFFCHAIN §1). Carries the tx hashes and event " +
  "log that a testnet reset destroys (09-DEPLOYMENT §3), the fill index the Claims page needs for " +
  "rounds older than the ~7-day RPC event window, and σ_realized with the series it was computed " +
  "from so the Phase-2 clearing gate can be recomputed rather than trusted (D-67).";

/** `evidence/<date>-<network>.json`, with the date in UTC so the filename is not machine-local. */
export function evidencePath(root: string, network: string, closedAt: number): string {
  const date = new Date(closedAt * 1000).toISOString().slice(0, 10);
  return join(root, `${date}-${network}.json`);
}

function readFile(path: string, network: string, date: string): EvidenceFile {
  if (!existsSync(path)) {
    return { _what: WHAT, network, date, epochs: [] };
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as EvidenceFile).epochs)) {
    throw new EvidenceError(`${path} exists but is not an evidence file; refusing to overwrite it`);
  }
  return parsed as EvidenceFile;
}

/**
 * Append one closed epoch.
 *
 * Refuses a duplicate rather than replacing it: `(vault, round)` identifies an epoch, and a second
 * write for the same pair means either the keeper is confused about what closed or somebody is
 * editing evidence. Both are worth stopping for.
 */
export function appendEpoch(root: string, network: string, epoch: EpochEvidence): string {
  const path = evidencePath(root, network, epoch.closedAt);
  const date = path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf("/") + 11);
  const file = readFile(path, network, date);

  const clash = file.epochs.find((e) => e.vault === epoch.vault && e.round === epoch.round);
  if (clash !== undefined) {
    throw new EvidenceError(
      `round ${epoch.round} of ${epoch.vault} is already recorded in ${path} with outcome ` +
        `${clash.outcome}. A closed epoch is a fact; rewriting one is not an update, and if the ` +
        `outcome differs then one of the two records is wrong and silently keeping the newer would ` +
        `destroy the evidence of which.`,
    );
  }

  const next: EvidenceFile = {
    _what: WHAT,
    network,
    date,
    epochs: [...file.epochs, epoch].sort((a, b) =>
      a.vault === b.vault ? a.round - b.round : a.vault.localeCompare(b.vault),
    ),
  };
  mkdirSync(dirname(path), { recursive: true });
  // Two-space JSON, terminated with a newline: this file is committed, so it has to survive
  // `prettier --check` in CI the way `coverage.json` did not.
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

/** Shape a `SigmaResult` plus its inputs into the published form. */
export function sigmaEvidence(
  result: SigmaResult,
  samples: readonly Sample[],
  feed: { feedId: string; resolution: number; decimals: number },
): SigmaEvidence {
  return {
    sigma: result.sigma,
    returns: result.returns,
    droppedForGaps: result.droppedForGaps,
    completeness: result.completeness,
    samples,
    feedId: feed.feedId,
    resolution: feed.resolution,
    decimals: feed.decimals,
  };
}
