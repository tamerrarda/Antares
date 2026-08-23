/**
 * Which of the Vault page's faces to render, derived from one `epoch()` call and the clock.
 *
 * The contract's phases are not a UI vocabulary (08-OFFCHAIN §3), and the mapping is not one to
 * one: `Active` is two different screens depending on whether expiry has passed, and `Idle` is one
 * screen whose sub-text depends on `outcome_pending`. Getting this wrong is not a cosmetic bug —
 * "Active" shown for twelve hours after expiry with no explanation is precisely the case the plan
 * calls out as needing a first-class state of its own.
 */
import type { EpochInfo, Position } from "@antares/bindings";

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

/**
 * Whether `redeem_shares` can run right now.
 *
 * `vault.rs` refuses it with `WrongPhase` outside `Idle`, and the awkward part is that a pending
 * deposit exists *because* a round was running — so an ungated button is offered mostly in the one
 * state it cannot work in. Gate on the **effective** phase this view reports rather than on a
 * face: `enter()` lazily finalizes before the contract's own check, so an `Idle` that still carries
 * `outcome_pending` is one the call will succeed against, and excluding it would hide a button that
 * works.
 */
export function canRedeemPending(e: EpochInfo): boolean {
  return e.phase.tag === "Idle";
}

/**
 * Whether a new deposit would be refused as `UnredeemedPending`.
 *
 * Narrower than "the user has a pending deposit", and the difference is two ordinary actions.
 * `deposit` **redeems and then mints** while the vault is Idle, and **accumulates** into a pending
 * from the round now running; only a pending left over from an *older* round while a round is live
 * is refused. `Position.pending_deposit_round` exists to make this checkable, and its sibling
 * `pending_deposit_finalized` carries the contract's own warning that a UI built on the retired
 * "finalized ⇒ locked" rule would grey out a button the contract still honours (D-37).
 */
export function blocksNewDeposit(e: EpochInfo, p: Position | null): boolean {
  if (p === null || p.pending_deposit <= 0n) return false;
  if (e.phase.tag === "Idle") return false;
  return p.pending_deposit_round !== e.round;
}

/**
 * A queued exit that has not finalized yet, in shares — `null` when there is none.
 *
 * `request_withdraw` **burns the shares immediately**, so between the request and the round's
 * finalization the depositor's balance has already dropped and there is nothing in the wallet, the
 * balance or the position to say why. `withdraw_claimable` stays 0 for the whole of that window,
 * which is exactly the window this answers for: on a seven-day instance it is seven days of a
 * number the user cannot see.
 *
 * The two states are disjoint by construction. `request_withdraw` auto-claims an older finalized
 * request before recording a new one, so a position never carries both a claimable amount and a
 * separate unfinalized one.
 */
export function queuedExit(p: Position | null): bigint | null {
  if (p === null) return null;
  if (p.pending_withdraw_shares <= 0n) return null;
  return p.withdraw_claimable > 0n ? null : p.pending_withdraw_shares;
}
