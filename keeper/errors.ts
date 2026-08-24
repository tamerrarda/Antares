/**
 * What a contract error means **to a helper that is not the only actor**.
 *
 * This is where D-09 stops being a sentence. `open_epoch` and `close_round` are permissionless, so
 * the keeper is one caller among any number — and the errors that come back are mostly not failures
 * at all. Classifying them by their code, in one place, is what keeps that from being re-decided at
 * each call site by whoever is writing it that day.
 *
 * # The three properties, and what getting each wrong costs
 *
 * **`WrongPhase` is success-noise.** It means somebody got there first. A keeper that counts it as a
 * failure pages a human at three in the morning **for the property the whole design is built on** —
 * and does it more often the healthier the system is, because a vault with an active community
 * loses more races. It is logged at `debug` and it **resets** the streak rather than merely not
 * incrementing it: work got done, which is the definition of the operation succeeding.
 *
 * **The oracle transients back off.** `OracleUnreachable` and `OracleNotDeadYet` are facts about
 * *now* — a trapping adapter, a grace period still running — and the right response to both is to
 * come back later, exponentially, to a ten-minute cap. Retrying at loop speed turns a congested
 * ledger into a self-inflicted denial of service against the RPC we depend on.
 *
 * **The rejections that emit no event still have to be seen.** `OracleStale`, `OracleDeviation` and
 * `OracleInvalidPrice` reject an `open_epoch` *before* anything is written, so there is no event to
 * subscribe to — the simulation result is the only signal that exists (04-ORACLE §3). They alert
 * without counting toward the failure streak, because the feed being unusable is not the keeper
 * failing.
 *
 * Everything else is unexpected by construction, and unexpected is the one that should page.
 */

import { contractErrorCode } from "@antares/common/chain";

/** Contract error codes, from `contracts/antares-vault/src/errors.rs`. Only the ones a keeper meets. */
export const CODES = {
  Paused: 1,
  WrongPhase: 2,
  IdleGapNotElapsed: 3,
  NotExpired: 4,
  OracleNotDeadYet: 6,
  NothingOffered: 7,
  NoShares: 8,
  OracleStale: 10,
  OracleDeviation: 11,
  OracleInvalidPrice: 12,
  OracleUnreachable: 13,
} as const;

export type Disposition =
  /** Somebody else did the work, or it was never needed. Debug, and the streak resets. */
  | { readonly kind: "benign"; readonly code: number; readonly why: string }
  /** A fact about now. Back off exponentially to the cap; alert after three in a row. */
  | { readonly kind: "transient"; readonly code: number; readonly why: string }
  /** A fact about the feed, with no event behind it. Alert, but it is not the keeper failing. */
  | { readonly kind: "feed_signal"; readonly code: number; readonly why: string }
  /** Not in the vocabulary. This is the one that should wake someone. */
  | { readonly kind: "unexpected"; readonly code: number | null; readonly why: string };

const BENIGN: Record<number, string> = {
  [CODES.WrongPhase]:
    "somebody else already moved the vault out of the phase we read. close_round and open_epoch " +
    "are permissionless (D-09), so losing this race is the design working, not a failure.",
  [CODES.NotExpired]:
    "the round had not expired when the contract looked, though it had when we did. A clock a " +
    "second apart, not a fault; the next pass closes it.",
  [CODES.IdleGapNotElapsed]:
    "the idle gap had not elapsed at the contract's clock. The most likely thing an eager caller " +
    "meets, and it resolves by waiting.",
  [CODES.Paused]:
    "the vault is paused, so no new risk is written. close_round is unpausable and unaffected (I8).",
  [CODES.NothingOffered]: "there was nothing to offer, so there was no round to open.",
  [CODES.NoShares]: "no shares are outstanding, so there is nothing to write a round against.",
};

const TRANSIENT: Record<number, string> = {
  [CODES.OracleUnreachable]:
    "the adapter did not answer this ledger — a trap, an archived instance, a live-config fault. " +
    "A fact about now, never about the expiry window (D-60), so the round stays closable.",
  [CODES.OracleNotDeadYet]:
    "the feed is dead at expiry but the grace period has not run out. The void path is not open " +
    "yet and will be; nothing here needs doing except waiting.",
};

const FEED_SIGNAL: Record<number, string> = {
  [CODES.OracleStale]: "the newest record is older than max_staleness",
  [CODES.OracleDeviation]: "the short and guard TWAPs disagree by more than max_deviation_bps",
  [CODES.OracleInvalidPrice]: "the aggregate is zero or negative",
};

/**
 * Pull a contract error code out of whatever the SDK threw.
 *
 * Moved to `@antares/common/chain` on 2026-08-23, when the bidder became the third caller. The
 * parse is shared; the disposition below is not, and that is the whole of the split — the same code
 * is benign to a keeper that lost a permissionless race and a stop signal to a bidder that is not
 * on the allowlist.
 */
export { contractErrorCode };

/** Classify by code. Pure, so every rule above is a unit test rather than an outage. */
export function classify(error: unknown): Disposition {
  const code = contractErrorCode(error);
  if (code === null) {
    return {
      kind: "unexpected",
      code: null,
      why: "no contract error code — a transport or signing failure, not a rejection by the vault",
    };
  }
  const benign = BENIGN[code];
  if (benign !== undefined) return { kind: "benign", code, why: benign };

  const transient = TRANSIENT[code];
  if (transient !== undefined) return { kind: "transient", code, why: transient };

  const signal = FEED_SIGNAL[code];
  if (signal !== undefined) {
    return {
      kind: "feed_signal",
      code,
      why:
        `open_epoch was rejected because ${signal}. This rejection writes nothing and emits no ` +
        `event, so a simulation result is the only signal it exists (04-ORACLE §3).`,
    };
  }
  return { kind: "unexpected", code, why: `contract error #${code} is not in the keeper's vocabulary` };
}

/** Whether `withBackoff` should try again. Only the oracle transients are worth a retry. */
export function isRetryable(error: unknown): boolean {
  return classify(error).kind === "transient";
}
