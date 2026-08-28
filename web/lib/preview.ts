/**
 * What a call would do, asked before anyone is invited to sign it.
 *
 * The two permissionless entry points are the trust model made operable, and 08-OFFCHAIN §3 is
 * specific about how they must be presented:
 *
 *   - `close_round(bounty_to)`'s bounty is **simulated rather than assumed** — the annulment branch
 *     pays none and a lapsed round has no premium to pay from, so a figure computed from
 *     `settle_bounty_bps` alone would be wrong in two of the four endings.
 *   - `open_epoch()` has **two failure shapes and the UI must tell them apart.** It reverts with a
 *     named error when nothing was finalised, but returns **`false` without reverting** when it did
 *     finalise a lapse and then could not open. Rendering the second as success is a lie: it is a
 *     transaction that succeeded and changed nothing visible.
 *
 * Both are answered the same way — by simulating, which costs nothing and signs nothing.
 */
import type { RoundOutcome } from "@antares/bindings";

import { explainMessage, type CallSite, type ErrorText } from "./errors.ts";
import { vaultClient } from "./vault.ts";

export type Preview<T> =
  | { readonly kind: "would-succeed"; readonly value: T }
  | { readonly kind: "would-refuse"; readonly refusal: ErrorText };

/** Anything that can simulate: the read client is enough, since simulation needs no signer. */
interface Simulatable {
  result: { isErr?: () => boolean; unwrapErr?: () => { message: string }; unwrap?: () => unknown };
  simulation?: { error?: unknown };
}

async function preview<T>(build: Promise<unknown>, site: CallSite): Promise<Preview<T>> {
  try {
    const tx = (await build) as Simulatable;
    // Checked before `tx.result`, which throws when the simulation failed — and it is the only
    // place the numeric error code is legible. See `tx.ts` for the measurement behind that.
    const failed = tx.simulation?.error;
    if (typeof failed === "string" && failed.length > 0) {
      return { kind: "would-refuse", refusal: explainMessage(failed, site) };
    }
    if (tx.result.isErr?.() === true) {
      return { kind: "would-refuse", refusal: explainMessage(tx.result.unwrapErr?.().message ?? "", site) };
    }
    return { kind: "would-succeed", value: tx.result.unwrap?.() as T };
  } catch (cause) {
    return {
      kind: "would-refuse",
      refusal: explainMessage(cause instanceof Error ? cause.message : String(cause), site),
    };
  }
}

/**
 * `bounty_to` has to be somebody, and simulating with the visitor's own address is the honest
 * choice: the number shown is what *they* would earn, not what an abstract caller would.
 */
export function previewClose(
  bountyTo: string,
  env: Record<string, string | undefined> = {},
  suffix?: string,
): Promise<Preview<RoundOutcome>> {
  return preview<RoundOutcome>(vaultClient(env, suffix).close_round({ bounty_to: bountyTo }), "close");
}

export function previewOpen(
  env: Record<string, string | undefined> = {},
  suffix?: string,
): Promise<Preview<boolean>> {
  return preview<boolean>(vaultClient(env, suffix).open_epoch(), "open");
}

/**
 * What a bid would fill, and for how much, before anybody signs it.
 *
 * A bid has more ways to be refused than any other entry point — nine, in BIDDER §2's table — and
 * three of them (`InTheMoney`, `ZeroPremium`, `BelowMinFill`) depend on numbers the bidder cannot
 * see from the auction card alone. Simulating answers all nine at once and costs nothing, which is
 * the same argument `previewClose` makes: the refusal a bidder needs is the contract's own, not our
 * guess at which rule they are about to hit.
 *
 * The returned value is the notional that would **actually** fill, which is `min(notional,
 * remaining)` and may be less than was asked for.
 */
export function previewBid(
  bidder: string,
  notional: bigint,
  maxPremiumBps: number,
  env: Record<string, string | undefined> = {},
  suffix?: string,
): Promise<Preview<bigint>> {
  return preview<bigint>(
    vaultClient(env, suffix).bid({ bidder, notional, max_premium_bps: maxPremiumBps }),
    "bid",
  );
}

/** What closing would produce, said the way a depositor experiences it. */
export const OUTCOME_SENTENCE: Readonly<Record<string, string>> = {
  Settled: "it would settle — the price is readable and the round pays out on it",
  Lapsed: "it would close with no buyer — no premium, and nothing lost",
  Voided: "it would be annulled — the buyer's premium goes back and your collateral is untouched",
  Unresolved: "it would close unresolved — you keep the premium and the buyer gets nothing",
};
