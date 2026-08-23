/**
 * What a contract rejection means **to a bidder**, which is not what it means to a keeper.
 *
 * `keeper/errors.ts` classifies the codes a permissionless helper meets and says why `WrongPhase` is
 * success-noise there. The codes overlap; the dispositions do not. The parse both share moved to
 * `@antares/common/chain` so that this file can disagree with that one on purpose rather than by
 * drift.
 *
 * # The category that is not in the keeper's vocabulary
 *
 * `decide()` claims to prevent two rejections outright: it refuses to send a fill below `min_fill`
 * that would not clear the round (`BelowMinFill`), and it refuses to send at a zero rate
 * (`ZeroPremium`). If either arrives anyway, **the mirror is wrong** — the bidder's copy of a
 * contract rule has drifted from the rule. Folding those into "transient" would answer a logic bug
 * with a retry and hide it for as long as the process runs, which is why they get their own kind and
 * why it is the loudest one here.
 *
 * That is the whole argument for classifying by code at all: a bidder that treats every rejection as
 * "try again later" is indistinguishable from one that is broken, and it keeps paying fees to prove
 * it.
 */

import { contractErrorCode } from "@antares/common/chain";

/** The codes a bidder can actually be handed, from `contracts/antares-vault/src/errors.rs`. */
export const CODES = {
  Paused: 1,
  WrongPhase: 2,
  OracleUnreachable: 13,
  AllowlistForbidden: 30,
  PremiumAboveMax: 31,
  BelowMinFill: 32,
  InTheMoney: 34,
  ZeroPremium: 35,
} as const;

export type Disposition =
  /** We read a stale auction and lost the race. Debug; try again next pass. */
  | { readonly kind: "benign"; readonly code: number; readonly why: string }
  /** A fact about now. Back off, and come back — it can stop being true. */
  | { readonly kind: "transient"; readonly code: number; readonly why: string }
  /** Nothing this process does changes it. Stop bidding on this vault and say so once. */
  | { readonly kind: "blocked"; readonly code: number; readonly why: string }
  /** `decide()` said this could not happen. It did, so `decide()` is wrong. */
  | { readonly kind: "mirror_bug"; readonly code: number; readonly why: string }
  /** Not in the vocabulary. */
  | { readonly kind: "unexpected"; readonly code: number | null; readonly why: string };

const BENIGN: Record<number, string> = {
  [CODES.WrongPhase]:
    "the auction moved between the read and the send — it sold out, or the window closed. The " +
    "next pass reads the phase again rather than assuming which.",
  [CODES.PremiumAboveMax]:
    "the curve was above our own max_premium_bps when the transaction executed. Our slippage " +
    "guard did its job; nothing was bought at a price we did not name.",
};

const TRANSIENT: Record<number, string> = {
  [CODES.Paused]: "the vault is paused. Bids are refused while it is, and it can be unpaused.",
  [CODES.OracleUnreachable]:
    "the feed did not answer the in-the-money guard. This is NOT absent demand and must not be " +
    "counted as a no-bid epoch (D-29) — it is the feed, and it comes back.",
  [CODES.InTheMoney]:
    "spot has reached the strike and the vault will not sell intrinsic value. It can fall back " +
    "inside the same auction, so this is a reason to wait rather than to stop.",
};

const BLOCKED: Record<number, string> = {
  [CODES.AllowlistForbidden]:
    "the allowlist is enabled, unexpired, and this address is not on it. Only the admin can " +
    "change that, so retrying spends fees to be told the same thing.",
};

const MIRROR_BUG: Record<number, string> = {
  [CODES.BelowMinFill]:
    "decide() refuses to send a fill below min_fill unless it clears the round, so this arriving " +
    "means its copy of that rule no longer matches the contract's.",
  [CODES.ZeroPremium]:
    "decide() refuses to send at a zero rate, so this arriving means its copy of that rule no " +
    "longer matches the contract's.",
};

/** Classify by code. Pure, so every rule above is a unit test rather than a surprise in production. */
export function classify(error: unknown): Disposition {
  const code = contractErrorCode(error);
  if (code === null) {
    return {
      kind: "unexpected",
      code: null,
      why: "no contract error code in this failure — it is transport or a bug, not a rejection.",
    };
  }
  const benign = BENIGN[code];
  if (benign !== undefined) return { kind: "benign", code, why: benign };
  const transient = TRANSIENT[code];
  if (transient !== undefined) return { kind: "transient", code, why: transient };
  const blocked = BLOCKED[code];
  if (blocked !== undefined) return { kind: "blocked", code, why: blocked };
  const mirror = MIRROR_BUG[code];
  if (mirror !== undefined) return { kind: "mirror_bug", code, why: mirror };
  return { kind: "unexpected", code, why: `contract error ${code} is not one a bid should produce.` };
}
