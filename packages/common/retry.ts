/**
 * Bounded retry with exponential backoff, and the consecutive-failure counter the alert rule needs.
 *
 * `08-OFFCHAIN.md` §1's shared principle is that *"every write goes through simulate → assemble →
 * sign → send with bounded retries"*, and the keeper's own rule is normative: *"exponential backoff
 * on `OracleUnreachable` / `OracleNotDeadYet` capped at 10 minutes, alert after three consecutive
 * failures"* — with `WrongPhase` counted as **success noise, not an error**.
 *
 * Those are two different mechanisms and conflating them is the mistake this file exists to avoid.
 * Backoff is *within* one operation; "three consecutive failures" is *across* keeper loop passes and
 * therefore outlives any single call. So: {@link withBackoff} for the first,
 * {@link ConsecutiveFailures} for the second.
 */

/** 10 minutes — the cap `08-OFFCHAIN.md` §1 states for the keeper's oracle backoff. */
export const DEFAULT_MAX_DELAY_MS = 600_000;

/** The keeper alerts after this many consecutive failures of the same operation (§1). */
export const DEFAULT_ALERT_AFTER = 3;

export interface BackoffOptions {
  /** Total attempts, including the first. Must be ≥ 1. */
  readonly attempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /**
   * Multiplier per attempt. 2 is exponential; the option exists so a test can pin the schedule
   * rather than measure it.
   */
  readonly factor?: number;
  /**
   * Called before each sleep, so a caller can log or count without wrapping this function.
   * `delayMs` is what will actually be slept, after the cap and the jitter.
   */
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /**
   * Return `false` to stop immediately instead of retrying. A retry loop that cannot be told
   * "this one will never succeed" turns a permanent error into ten of them.
   */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Math.random`. Full jitter, see below. */
  readonly random?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `op`, retrying with exponential backoff and **full jitter**.
 *
 * Jitter is not decoration here. The keeper loops over **five vault instances** (D-47), and every
 * one of them talks to the same RPC endpoint and the same feed. Without jitter a shared outage puts
 * all five on an identical retry schedule, so they recover in lockstep and hit the endpoint together
 * at exactly the moment it is least able to answer. The sleep is therefore uniform on
 * `[delay/2, delay]` rather than exactly `delay`.
 */
export async function withBackoff<T>(op: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = options.factor ?? 2;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const isRetryable = options.isRetryable ?? (() => true);

  if (attempts < 1) throw new RangeError("withBackoff: attempts must be at least 1");

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;
      const uncapped = initialDelayMs * factor ** (attempt - 1);
      const capped = Math.min(uncapped, maxDelayMs);
      const delayMs = Math.round(capped / 2 + random() * (capped / 2));
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Counts consecutive failures of one named operation across loop passes, and says when to alert.
 *
 * The keeper holds one of these per (instance, operation) pair — not one globally. Five vaults
 * failing once each is five instances with a hiccup; one vault failing three times running is the
 * thing worth waking somebody for, and a single shared counter cannot tell those apart.
 *
 * `alert()` fires **once per streak**, on the pass that reaches the threshold, and stays quiet until
 * a success resets it. An alert channel that re-fires every pass is one people mute, and a muted
 * channel is the one that misses the fourth thing (07-SECURITY §6).
 */
export class ConsecutiveFailures {
  #count = 0;
  #alerted = false;

  /**
   * Written as explicit fields rather than as constructor parameter properties, and the whole
   * package is held to that: **parameter properties emit code, so Node's `--experimental-strip-types`
   * refuses them** (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). `erasableSyntaxOnly` in `tsconfig.json`
   * turns that from a runtime failure in whoever imports this into a compile error here, which is
   * where it belongs — the same class of "the check and the runtime disagree" that D-50's pins exist
   * to close.
   */
  readonly operation: string;
  readonly alertAfter: number;

  constructor(operation: string, alertAfter: number = DEFAULT_ALERT_AFTER) {
    if (alertAfter < 1) throw new RangeError("ConsecutiveFailures: alertAfter must be at least 1");
    this.operation = operation;
    this.alertAfter = alertAfter;
  }

  get count(): number {
    return this.#count;
  }

  /** Record a failure. Returns true exactly once per streak, on the pass that crosses the threshold. */
  fail(): boolean {
    this.#count += 1;
    if (this.#count >= this.alertAfter && !this.#alerted) {
      this.#alerted = true;
      return true;
    }
    return false;
  }

  /**
   * Record a success — including the "success noise" cases.
   *
   * `WrongPhase` means somebody else did the thing first, which is **expected** on a permissionless
   * function and is logged at debug (`08-OFFCHAIN.md` §1). It must reset the streak: counting it as
   * a failure would make a busy, healthy vault alert precisely because other people are also
   * keeping it alive.
   */
  succeed(): void {
    this.#count = 0;
    this.#alerted = false;
  }
}
