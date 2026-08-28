/**
 * Claim, without asking the bidder to know which call applies.
 *
 * A settled round pays through `claim_payout` and an annulled one refunds through `claim_refund`,
 * and picking the wrong one returns `WrongOutcome`. The outcome is knowable from events — but only
 * for rounds inside the RPC's seven-day window, and this page deliberately reaches further back
 * than that. Rather than show a bidder two buttons and let them guess, this tries the payout and
 * falls through to the refund on exactly that refusal.
 *
 * It costs at most one extra **simulation**, which is free: nothing is signed until a branch comes
 * back clean, so the fallback never puts a doomed transaction in front of the wallet.
 */
import { explain } from "./errors.ts";
import { submit, type TxOutcome } from "./tx.ts";
import { writeClient } from "./vault.ts";

/** `WrongOutcome` — the contract's way of saying "right money, wrong door". */
const WRONG_OUTCOME = 39;

export async function claim(
  round: number,
  bidder: string,
  signer: Parameters<typeof submit>[1],
  env: Record<string, string | undefined> = {},
  suffix?: string,
): Promise<TxOutcome<bigint>> {
  const client = writeClient(bidder, env, suffix);

  const payout = await submit<bigint>(client.claim_payout({ round, bidder }), signer);
  if (payout.status === "sent") return payout;
  if (payout.refusal.name !== explain(WRONG_OUTCOME).name) return payout;

  return submit<bigint>(client.claim_refund({ round, bidder }), signer);
}
