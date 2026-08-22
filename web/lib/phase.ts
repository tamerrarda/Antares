/**
 * Which of the Vault page's faces to render, derived from one `epoch()` call and the clock.
 *
 * The contract's phases are not a UI vocabulary (08-OFFCHAIN §3), and the mapping is not one to
 * one: `Active` is two different screens depending on whether expiry has passed, and `Idle` is one
 * screen whose sub-text depends on `outcome_pending`. Getting this wrong is not a cosmetic bug —
 * "Active" shown for twelve hours after expiry with no explanation is precisely the case the plan
 * calls out as needing a first-class state of its own.
 */
import type { EpochInfo } from "@antares/bindings";

export type FaceId = "auction" | "active" | "delayed" | "window";

export interface Face {
  readonly id: FaceId;
  /** Named by consequence, never by enum. */
  readonly label: string;
  readonly note: string;
  /** `live` while a clock is running and something can still change; `quiet` otherwise. */
  readonly tone: "live" | "quiet";
}

/**
 * `next_open_at` is the authority **only** once the round has finalised, and both halves matter.
 *
 * During `Auction` and `Active` it still carries the *previous* round's value — a past timestamp —
 * because `last_finalize_time` does not move until the current round ends. And `epoch()` reports
 * the *effective* phase, so an auction that closed empty is already reported as `Idle` with
 * `outcome_pending = true` while `last_finalize_time` still belongs to the previous round.
 * Switching on `phase === "Idle"` alone therefore shows a stale — usually negative — countdown at
 * the exact moment the window opens, in the lapse branch, which is the common one.
 */
export function windowOpensAt(e: EpochInfo): bigint | null {
  return e.phase.tag === "Idle" && !e.outcome_pending ? e.next_open_at : null;
}

export function faceOf(e: EpochInfo, nowSeconds: number): Face {
  const now = BigInt(Math.floor(nowSeconds));

  if (e.phase.tag === "Auction") {
    return {
      id: "auction",
      label: "The option is for sale",
      note:
        e.notional_sold > 0n
          ? `Round ${e.round} · partly sold`
          : `Round ${e.round} · nobody has bought it yet`,
      tone: "live",
    };
  }

  if (e.phase.tag === "Active") {
    // Past expiry and still reported Active means `close_round` has not succeeded — the oracle is
    // refusing. There is no contract phase for that, and leaving the user on "Active" with no
    // explanation for up to `oracle_dead_after` is the thing this branch exists to prevent.
    if (now >= e.expiry) {
      return {
        id: "delayed",
        label: "Settlement is late",
        note: `Round ${e.round} has expired · your funds are safe`,
        tone: "live",
      };
    }
    return {
      id: "active",
      label: "Sold — the round is running",
      note: `Round ${e.round} · the premium is already in the vault`,
      tone: "live",
    };
  }

  return {
    id: "window",
    label: "Your window is open",
    note: e.outcome_pending
      ? `Round ${e.round} found no buyer · deposits and exits are instant right now`
      : `Deposits, exits and redemptions are instant right now`,
    tone: "live",
  };
}
