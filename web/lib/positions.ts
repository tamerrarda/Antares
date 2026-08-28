/**
 * What an address is holding, across every vault, split the one way that matters.
 *
 * This lived inside the positions page and read `position.shares` alone — so an address whose
 * deposit was still waiting for a live round to end was told, on the page whose subtitle promises
 * to say where their money is, that it had **no position**. The vault page announced the same
 * balance at the same moment. Two views of one balance disagreeing is not a rounding question.
 *
 * It is here rather than in the component so the arithmetic can be tested without a browser, a
 * wallet or a round: the defect was one `filter` predicate, and a predicate is exactly the kind of
 * thing that comes back.
 */
import type { EpochInfo, Position } from "@antares/bindings";

const SCALE = 10_000_000n;

/** The shape the page already has, narrowed to what a total needs. */
export interface Holding {
  readonly epoch: EpochInfo | null;
  readonly position: Position | null;
}

/** Shares valued at the last settled price. Zero when either half is missing. */
export function shareWorth(h: Holding): bigint {
  if (h.position === null || h.epoch === null) return 0n;
  return (h.position.shares * h.epoch.last_pps) / SCALE;
}

/** XLM in the vault that is not shares yet, and takes none of the live round's result. */
export function waitingWorth(h: Holding): bigint {
  return h.position?.pending_deposit ?? 0n;
}

export interface Summary {
  /** Everything the vaults hold for this address — shares valued, plus what is waiting. */
  readonly total: bigint;
  /** The part that is not shares yet. Named separately, never folded into `total` alone. */
  readonly waiting: bigint;
  /** How many vaults hold anything at all, waiting included. */
  readonly vaults: number;
}

export function summarise(rows: readonly Holding[]): Summary {
  let shares = 0n;
  let waiting = 0n;
  let vaults = 0;
  for (const r of rows) {
    const s = shareWorth(r);
    const w = waitingWorth(r);
    if (s > 0n || w > 0n) vaults += 1;
    shares += s;
    waiting += w;
  }
  return { total: shares + waiting, waiting, vaults };
}
