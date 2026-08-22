/**
 * What the vault owes one bidder, read round by round.
 *
 * `08-OFFCHAIN §3` warns that discovery here *"cannot come from events"* — Soroban RPC keeps about
 * seven days, which at instance A is barely one round, so a bidder who looked a round late would
 * find an empty page and conclude they were owed nothing. That warning is right and this module
 * sidesteps it entirely: `bidder_position(round, bidder)` is a **view**, so it answers for any
 * round the contract still holds, with no dependence on the event window at all.
 *
 * Three facts from §3 shape the rest, and each is here because an earlier draft of that paragraph
 * got it wrong:
 *
 *   - **Claiming is never the problem.** A claim is a transaction, so Protocol 23 restores an
 *     archived `Fill` inside its own footprint automatically. Nothing extra is asked of the bidder.
 *   - **Reading is the problem, and it is solvable.** An archived entry is distinguishable from an
 *     absent one at simulation: the response carries a restore preamble. That is what `archived`
 *     below records, and it is why a dormant bidder never sees a zero where their money is.
 *   - **The range is bounded.** Reading every round since genesis would be unbounded work, so the
 *     range is capped and the page states which rounds it covered rather than implying it saw all.
 */
import type { BidderPosition } from "@antares/bindings";

import { vaultClient } from "./vault.ts";

export interface ClaimRow {
  readonly round: number;
  readonly notional: bigint;
  readonly premiumPaid: bigint;
  readonly claimable: bigint;
  readonly claimed: boolean;
  /** The entry was evicted and the read had to be told how to bring it back. Not a loss. */
  readonly archived: boolean;
}

export interface ClaimsRead {
  readonly rows: readonly ClaimRow[];
  /** Oldest and newest round actually queried, so the page can say what it looked at. */
  readonly from: number;
  readonly to: number;
  /** True when the cap stopped the scan short of round 1. */
  readonly truncated: boolean;
}

/**
 * How far back to look.
 *
 * Chosen against the shape of a real deployment rather than a round number: instance A runs one
 * round a week, so this is two years of them, and instance C runs one every three days, which is
 * still nine months. A vault older than that needs the evidence index the keeper writes — the
 * fallback §3 describes — and until it exists the page says what it could not reach.
 */
const MAX_ROUNDS = 104;

/** Small enough not to hammer a public node, large enough that a hundred rounds is a few seconds. */
const BATCH = 8;

interface Sim {
  result: { isOk?: () => boolean; isErr?: () => boolean; unwrap?: () => BidderPosition };
  simulation?: { restorePreamble?: unknown; error?: unknown };
}

async function readOne(
  round: number,
  bidder: string,
  env: Record<string, string | undefined>,
): Promise<ClaimRow | null> {
  const client = vaultClient(env);
  try {
    const tx = (await client.bidder_position({ round, bidder })) as unknown as Sim;
    if (typeof tx.simulation?.error === "string") return null;
    const value = tx.result.unwrap?.();
    if (value === undefined) return null;
    if (value.notional === 0n) return null;

    // A restore preamble in the response means the entry had been archived: the node had to be told
    // how to bring it back before it could answer. The number it answered with is unaffected — this
    // is a fact about storage, not about the money — so it is recorded and shown, never treated as
    // an error or as an absence.
    //
    // **Untested against a real eviction.** Persistent entries live for weeks and none can be aged
    // on demand, which is the same limit `06-TEST-PLAN §7`'s scenario 6 records for the archival
    // path generally. The branch is written from the documented shape and has never fired.
    const archived = tx.simulation?.restorePreamble !== undefined && tx.simulation.restorePreamble !== null;

    return {
      round,
      notional: value.notional,
      premiumPaid: value.premium_paid,
      claimable: value.claimable,
      claimed: value.claimed,
      archived,
    };
  } catch {
    // A round the contract no longer knows about is not an error worth surfacing per-row; the page
    // reports the range it covered and the reader can see where it stops.
    return null;
  }
}

export async function readClaims(
  bidder: string,
  currentRound: number,
  env: Record<string, string | undefined> = {},
): Promise<ClaimsRead> {
  const to = currentRound;
  const from = Math.max(1, to - MAX_ROUNDS + 1);
  const rounds: number[] = [];
  for (let r = to; r >= from; r -= 1) rounds.push(r);

  const rows: ClaimRow[] = [];
  for (let i = 0; i < rounds.length; i += BATCH) {
    const slice = rounds.slice(i, i + BATCH);
    const found = await Promise.all(slice.map((r) => readOne(r, bidder, env)));
    for (const row of found) if (row !== null) rows.push(row);
  }

  return { rows, from, to, truncated: from > 1 };
}

/**
 * What a row means, which is not readable from either field alone.
 *
 * Measured on the live vault: an `Unresolved` round leaves a bidder with `claimable = 0` and
 * `claimed = false`, because nothing was ever owed — the premium stays with depositors and the
 * buyer gets nothing. Rendering that as "unclaimed" would tell somebody there is money waiting for
 * them when the round's whole outcome was that there is not.
 */
export type ClaimState = "claimable" | "claimed" | "nothing-owed";

export function claimState(row: ClaimRow): ClaimState {
  if (row.claimable > 0n && !row.claimed) return "claimable";
  if (row.claimed) return "claimed";
  return "nothing-owed";
}

export function totalUnclaimed(rows: readonly ClaimRow[]): bigint {
  return rows.reduce((sum, r) => (claimState(r) === "claimable" ? sum + r.claimable : sum), 0n);
}
