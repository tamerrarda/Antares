/**
 * One pass, and the loop around it.
 *
 * `pass` is the whole of what the bidder does: read the auction, read its own standing, total what
 * it is already carrying, decide, and — only if the decision is to bid — send. It takes a client
 * rather than building one, so every branch here is a unit test against a fake instead of a testnet
 * round nobody can reproduce.
 *
 * # `now` comes from the ledger, not from this machine
 *
 * The keeper defaults its clock to `Date.now()`, and for the keeper that is fine: what it compares
 * against are its own alert thresholds. Here the comparison is against `allowlist_expires_at`, a
 * value the **contract** evaluates against ledger time, and the two directions of a skewed clock are
 * not symmetric. Reading the machine's clock late means bidding into a gate that is still live and
 * being refused — one wasted simulation. Reading it early means **declining business the contract
 * would have taken**, silently, for as long as the skew lasts. The ledger's own close time costs one
 * RPC call per pass and removes the asymmetry, so it is what `loop` supplies.
 *
 * # Backoff exists because a bidder pays to be wrong
 *
 * A keeper that retries too eagerly wastes fees on permissionless calls somebody else will make
 * anyway. A bidder that retries too eagerly does it while an auction is descending, which means it
 * is spending fees at exactly the moment the price is moving against its patience. So `transient`
 * backs off, `blocked` stops, and the two loud kinds stop the loop rather than papering over a
 * disagreement with the contract.
 */

import { classify, type Disposition } from "./errors.ts";
import { decide, type Decision, type RiskCaps, type Strategy } from "./strategy.ts";
import type { BidderVaultClient } from "./vault.ts";

export interface Sink {
  debug(message: string, fields?: unknown): void;
  info(message: string, fields?: unknown): void;
  warn(message: string, fields?: unknown): void;
  alert(message: string, fields?: unknown): void;
}

export interface PassOptions {
  readonly caps: RiskCaps;
  readonly strategy: Strategy;
  /** Ledger close time in seconds. Not `Date.now()` — see the header. */
  readonly now: number;
}

export interface PassResult {
  readonly decision: Decision;
  readonly openNotional: bigint;
  readonly allowed: boolean;
  /** Set only when a bid landed. */
  readonly txHash: string | null;
  /** Set only when a bid was sent and refused. */
  readonly disposition: Disposition | null;
}

/**
 * The allowlist rule, mirrored from `auction.rs` in the same three parts it is written there.
 *
 * The membership read is skipped when the gate cannot apply, which is not an optimisation: reading
 * it would suggest the answer mattered, and a reader of the log should not have to work out that it
 * did not.
 */
async function isAllowed(client: BidderVaultClient, now: number): Promise<boolean> {
  const gate = await client.allowlist();
  if (!gate.enabled) return true;
  if (now >= gate.expiresAt) return true;
  return client.isListed();
}

export async function pass(client: BidderVaultClient, options: PassOptions): Promise<PassResult> {
  const { caps, strategy, now } = options;
  const auction = await client.auction();
  const allowed = await isAllowed(client, now);
  const openNotional = await client.openNotional(auction.round);
  const decision = decide(auction, caps, { openNotional }, strategy, allowed);

  if (decision.kind === "wait") {
    return { decision, openNotional, allowed, txHash: null, disposition: null };
  }

  try {
    const txHash = await client.bid(decision.notional, decision.maxPremiumBps);
    return { decision, openNotional, allowed, txHash, disposition: null };
  } catch (error) {
    return { decision, openNotional, allowed, txHash: null, disposition: classify(error) };
  }
}

export interface LoopOptions extends Omit<PassOptions, "now"> {
  /** Seconds between passes when nothing is backing off. */
  readonly pollMs?: number;
  /** Ceiling for the transient backoff. */
  readonly maxBackoffMs?: number;
  readonly running?: () => boolean;
  /** Ledger close time in seconds. Injected so the loop is testable without a clock. */
  readonly clock: () => Promise<number>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 600_000;

export async function loop(client: BidderVaultClient, sink: Sink, options: LoopOptions): Promise<void> {
  const poll = options.pollMs ?? DEFAULT_POLL_MS;
  const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const running = options.running ?? (() => true);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let backoff = poll;

  while (running()) {
    let wait = poll;
    try {
      const now = await options.clock();
      const result = await pass(client, { caps: options.caps, strategy: options.strategy, now });

      if (result.decision.kind === "wait") {
        sink.debug(`waiting: ${result.decision.why}`, { openNotional: String(result.openNotional) });
        backoff = poll;
      } else if (result.txHash !== null) {
        sink.info(`filled ${result.decision.notional} at ≤${result.decision.maxPremiumBps} bps`, {
          tx: result.txHash,
        });
        backoff = poll;
      } else {
        const d = result.disposition;
        switch (d?.kind) {
          case "benign":
            sink.debug(`bid refused (${d.code}): ${d.why}`);
            backoff = poll;
            break;
          case "transient":
            sink.info(`bid refused (${d.code}): ${d.why}`);
            wait = backoff = Math.min(backoff * 2, maxBackoff);
            break;
          case "blocked":
            // Not an error and not worth a retry loop. The operator has to act, or nobody does.
            sink.warn(`stopping: ${d.why}`);
            return;
          case "mirror_bug":
            // `decide()` promised this could not happen. Retrying would answer a logic bug with a
            // fee, so this ends the process instead of hiding it.
            sink.alert(`decide() disagrees with the contract (${d.code}): ${d.why}`);
            return;
          default:
            sink.alert(`unexpected refusal: ${d?.why ?? "no disposition"}`);
            return;
        }
      }
    } catch (error) {
      // A read failed, not a bid — transport, or the RPC. Back off rather than hammer it.
      sink.warn(`pass failed: ${error instanceof Error ? error.message : String(error)}`);
      wait = backoff = Math.min(backoff * 2, maxBackoff);
    }
    if (running()) await sleep(wait);
  }
}
