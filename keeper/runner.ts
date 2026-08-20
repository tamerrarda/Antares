/**
 * One pass over one vault, and the loop that repeats it.
 *
 * `decide.ts` says *what*; this says *how often*, *what to do when it fails*, and *who hears about
 * it*. It is deliberately thin: everything with a rule in it lives in a pure module that a unit
 * test can reach, and what is left here is sequencing.
 *
 * # D-09's failure mode is the design target
 *
 * *A dead keeper means things happen later, never that things cannot happen.* Every entry point it
 * calls is permissionless, it holds no admin key, and it stores nothing that is not reconstructable
 * from `epoch()` on the next pass. **Switching it off must be boring** — and Phase 6's drills are
 * where that claim gets tested rather than asserted.
 *
 * Two consequences visible in the code below:
 *
 * - **Re-simulate before every send.** The decision was made from a read that is already old, and
 *   anyone may have acted in between. The simulation is not an optimisation, it is the check that
 *   the decision still applies.
 * - **No state carried across passes.** `VaultState` is rebuilt each time. A keeper that cached
 *   would be a second source of truth about a chain that anybody can move.
 */

import { ConsecutiveFailures, DEFAULT_MAX_DELAY_MS, withBackoff } from "@antares/common/retry";

import { alerts, decide, type Action, type Alert, type EpochView, type VaultConfig } from "./decide.ts";
import { classify, isRetryable } from "./errors.ts";

/** Every read and write the runner needs, behind an interface so the loop is testable without a chain. */
export interface VaultClient {
  readonly id: string;
  epoch(): Promise<EpochView>;
  config(): Promise<VaultConfig>;
  /** `expires(XLM)` on the feed this vault's adapter is pinned to. */
  feedExpiresAt(): Promise<number | null>;
  /**
   * Simulate, then send. **Both**, in that order, in one call — so no caller can send without
   * simulating first. A separate `simulate()` on this interface would be an invitation to skip it.
   */
  submit(action: Exclude<Action, { kind: "wait" }>): Promise<string>;
}

export interface Sink {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  alert(alert: Alert): void;
}

export interface PassResult {
  readonly action: Action;
  /** Present when something was sent and accepted. */
  readonly txHash?: string;
  readonly alerts: readonly Alert[];
  /** What the contract said, when it said no. */
  readonly disposition?: ReturnType<typeof classify>;
}

/** How long a pass waits before the next one. 30 s, and no cron: 08-OFFCHAIN §1. */
export const LOOP_INTERVAL_MS = 30_000;

/**
 * The knobs a test needs and production does not.
 *
 * `sleep` is injected rather than hardcoded because the backoff cap is **ten minutes**: a suite that
 * exercises the retry path against a real timer takes almost a minute to assert a rule that has no
 * time in it. It was written that way first and the suite took 52 seconds, which is the length at
 * which people quietly stop running it — the same reasoning §6.1 applies to the close checklist.
 */
export interface PassOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly attempts?: number;
}

/**
 * One vault, one pass.
 *
 * The failure counter is passed in rather than created here, because a streak is a property of the
 * vault across passes and this function deliberately holds nothing.
 */
export async function pass(
  vault: VaultClient,
  failures: ConsecutiveFailures,
  sink: Sink,
  now: number,
  options: PassOptions = {},
): Promise<PassResult> {
  const [view, config, expiresAt] = await Promise.all([vault.epoch(), vault.config(), vault.feedExpiresAt()]);

  const raised = alerts(vault.id, view, { expiresAt }, now);
  for (const a of raised) sink.alert(a);

  const action = decide(view, config, now);
  if (action.kind === "wait") {
    sink.debug(`${vault.id}: ${action.why}`);
    return { action, alerts: raised };
  }

  try {
    // `submit` simulates and sends. The backoff is around the whole thing, because the transients
    // it retries — a trapping adapter, a grace period — surface in the *simulation*, which is
    // exactly where we want them: nothing is signed and nothing is spent.
    const txHash = await withBackoff(() => vault.submit(action), {
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
      isRetryable,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      onRetry: (error, attempt, delayMs) => {
        sink.debug(`${vault.id}: ${action.kind} retrying in ${delayMs}ms`, {
          attempt,
          why: classify(error).why,
        });
      },
    });
    failures.succeed();
    sink.info(`${vault.id}: ${action.kind}`, { txHash, round: view.round });
    return { action, txHash, alerts: raised };
  } catch (error) {
    const disposition = classify(error);

    if (disposition.kind === "benign") {
      // The property the whole design rests on, so it is not a failure and it does not merely
      // "not count" — it **resets** the streak. The work got done; we were not the one who did it.
      failures.succeed();
      sink.debug(`${vault.id}: ${action.kind} was not needed`, { why: disposition.why });
      return { action, alerts: raised, disposition };
    }

    if (disposition.kind === "feed_signal") {
      // No event exists behind this rejection, so if the keeper does not say it, nobody learns it.
      // It is not a keeper failure, so the streak is untouched in either direction.
      sink.warn(`${vault.id}: ${action.kind} rejected by the feed`, { why: disposition.why });
      return { action, alerts: raised, disposition };
    }

    const shouldAlert = failures.fail();
    sink.warn(`${vault.id}: ${action.kind} failed`, {
      why: disposition.why,
      consecutive: failures.count,
    });
    if (shouldAlert) {
      const alert: Alert = {
        kind: "failure_streak",
        vault: vault.id,
        message:
          `${action.kind} has failed ${failures.count} times in a row: ${disposition.why}. ` +
          `Both entry points are permissionless, so anyone can do this by hand while it is looked at.`,
      };
      sink.alert(alert);
      return { action, alerts: [...raised, alert], disposition };
    }
    return { action, alerts: raised, disposition };
  }
}

export interface LoopOptions extends PassOptions {
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  /** Return false to stop. Injected so a test can run a bounded number of passes. */
  readonly running?: () => boolean;
}

/**
 * The loop, over every deployed instance (D-47: five vaults, one process).
 *
 * A pass that throws is caught here rather than allowed to end the process: one vault's RPC failure
 * must not stop the other four from being maintained, and a keeper that exits on the first error is
 * a keeper that is off — which is survivable by design but pointless by accident.
 */
export async function loop(
  vaults: readonly VaultClient[],
  sink: Sink,
  options: LoopOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? LOOP_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const running = options.running ?? (() => true);

  const failures = new Map<string, ConsecutiveFailures>();
  for (const v of vaults) failures.set(v.id, new ConsecutiveFailures(`keeper:${v.id}`));

  while (running()) {
    for (const vault of vaults) {
      try {
        await pass(vault, failures.get(vault.id)!, sink, clock(), options);
      } catch (error) {
        sink.warn(`${vault.id}: pass failed before a decision could be made`, {
          why: classify(error).why,
        });
      }
    }
    if (running()) await sleep(intervalMs);
  }
}
