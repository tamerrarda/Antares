/**
 * Waiting on the ledger's clock, never on the wall clock.
 *
 * # Why this file exists rather than a `setTimeout`
 *
 * Every deadline in a round — `auction_end`, `expiry`, `oracle_dead_after`, `unresolved_after` — is
 * compared on-chain against `env.ledger().timestamp()`, which is the **ledger close time**. That is
 * not the machine's clock. It advances in ~5-second steps rather than continuously, it can stall
 * when the network is unwell, and it has no obligation to agree with a laptop that has not synced
 * NTP in a week.
 *
 * At the shipped parameters nobody would notice. At the fast-test profile the margins are 15
 * seconds — `scripts/instances-fast-test.json` states all four — and 15 seconds is three ledgers.
 * A harness that slept on the wall clock would cross a boundary the chain has not crossed, submit a
 * call the contract rejects, and report a `WrongPhase` that looks like a contract bug and is a
 * clock bug. Worse, it would do it **intermittently**, which is the failure mode this project has
 * already paid for once today: an intermittently red gate teaches people to rerun rather than read.
 *
 * # Refusing rather than waiting forever
 *
 * Every wait is bounded and the bound is stated in ledger terms. When it expires the error carries
 * the measurement — where the ledger clock actually was, how far it moved, and what it was compared
 * against — because "timed out" is not a finding and "the ledger advanced 2 seconds in 90" is.
 *
 * # The drift is reported, not assumed away
 *
 * {@link ledgerNow} returns the wall-clock offset alongside the ledger time. It costs nothing and it
 * turns the premise of this whole file from an assertion in a comment into a number in the run log.
 */

/** Only what this module needs from `rpc.Server`, so every path is testable without a network. */
export interface LedgerClockRpc {
  getLatestLedger(): Promise<{ sequence: number; closeTime: string | number }>;
}

export interface LedgerTime {
  readonly sequence: number;
  /** The ledger close time, in seconds — the value `env.ledger().timestamp()` returns on-chain. */
  readonly closeTime: number;
  /**
   * `closeTime - wallClockSeconds`, at the moment of reading.
   *
   * Negative is the normal case and means the newest closed ledger is a few seconds old, which it
   * always is. A large or growing magnitude is the interesting signal.
   */
  readonly driftFromWallClock: number;
}

export class LedgerClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerClockError";
  }
}

export async function ledgerNow(rpc: LedgerClockRpc): Promise<LedgerTime> {
  const l = await rpc.getLatestLedger();
  const closeTime = Number(l.closeTime);
  if (!Number.isFinite(closeTime) || closeTime <= 0) {
    throw new LedgerClockError(
      `getLatestLedger returned a close time this module cannot use: ${JSON.stringify(l.closeTime)}. ` +
        `Every deadline in a round is compared against it on-chain, so proceeding on the wall clock ` +
        `instead would be trading a visible failure for an intermittent one.`,
    );
  }
  return { sequence: l.sequence, closeTime, driftFromWallClock: closeTime - Math.floor(Date.now() / 1000) };
}

export interface WaitOptions {
  /** How often to ask. Default 1 000 ms — a ledger closes in ~5 s, so this oversamples deliberately. */
  readonly pollMs?: number;
  /**
   * How long to keep asking, in **wall-clock** seconds.
   *
   * Wall clock here on purpose, and it is the one place it belongs: this bounds how long the process
   * is willing to sit still, which is a fact about the process. What it must never bound is the
   * comparison — that is always ledger time against ledger time.
   */
  readonly timeoutSeconds?: number;
  /** Called after each poll, so a long wait is legible while it happens. */
  readonly onTick?: (t: LedgerTime) => void;
  /** Injected in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Block until the ledger's clock reaches `target` (inclusive), or refuse with the measurement.
 *
 * Returns immediately when the clock is already there, which is the common case after a chain of
 * transactions has taken longer than expected — and is exactly the case a `sleep(target - now)`
 * would have got wrong in the other direction.
 */
export async function waitUntilLedgerTime(
  rpc: LedgerClockRpc,
  target: number,
  opts: WaitOptions = {},
): Promise<LedgerTime> {
  const pollMs = opts.pollMs ?? 1_000;
  const timeoutSeconds = opts.timeoutSeconds ?? 300;
  const sleep = opts.sleep ?? realSleep;

  const started = await ledgerNow(rpc);
  let latest = started;
  const deadline = Date.now() + timeoutSeconds * 1_000;

  while (latest.closeTime < target) {
    if (Date.now() > deadline) {
      const movedSeconds = latest.closeTime - started.closeTime;
      const movedLedgers = latest.sequence - started.sequence;
      throw new LedgerClockError(
        `the ledger clock did not reach ${target} within ${timeoutSeconds}s of waiting. It stood at ` +
          `${latest.closeTime} (ledger ${latest.sequence}), ${target - latest.closeTime}s short, having ` +
          `advanced ${movedSeconds}s across ${movedLedgers} ledger(s) while this waited. ` +
          `Drift against the wall clock: ${latest.driftFromWallClock}s. ` +
          `If the ledger barely moved, the network stalled and nothing here is wrong; if it moved ` +
          `normally, the target was further away than the caller believed.`,
      );
    }
    await sleep(pollMs);
    latest = await ledgerNow(rpc);
    opts.onTick?.(latest);
  }
  return latest;
}

/**
 * Seconds of ledger time left before `deadline`, or a negative number once it has passed.
 *
 * The auction trap in one call. `auction_duration` is 20 s against a ~5 s ledger, so a fast-test
 * auction is three to four ledgers wide and a bid decided on the wall clock can be submitted into a
 * window the chain has already closed. Ask this before submitting, not after.
 */
export async function ledgerSecondsUntil(rpc: LedgerClockRpc, deadline: number): Promise<number> {
  const now = await ledgerNow(rpc);
  return deadline - now.closeTime;
}
