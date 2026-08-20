/**
 * The monthly TTL sweep — 03-STORAGE-TTL §4.
 *
 * `restore_position(user)` is callable by **anyone**. That is not an oversight to work around, it is
 * a maintenance entry point put there on purpose so a helper can maintain a dormant user's position
 * without holding anything of theirs. It re-bumps `Shares`, `PendingDeposit`, `PendingWithdraw` and
 * any `Round` those reference.
 *
 * So the whole feature is a list of addresses and a monthly pass. Bumping every known depositor once
 * a month costs dust and **makes archival a non-event**: an entry that never gets close to expiry is
 * never restored under pressure, never restored by a user who does not know they have to, and never
 * the reason someone cannot exit.
 *
 * # It is a convenience like everything else here (D-09)
 *
 * A sweep that does not run means some positions drift toward archival, and an archived entry is
 * **permissionlessly restorable** — by the user, or by the next sweep, or by anyone. It does not mean
 * anybody loses anything. The sweep exists so nobody has to find that out.
 *
 * # Where the roster comes from
 *
 * Addresses seen in deposit events. That is the same event-decoding seam the evidence writer needs,
 * so the two land together and neither invents its own. It is behind an interface here rather than
 * imported, which keeps the cadence and the batching testable without a chain and lets the source
 * change without touching this file.
 */

/** Thirty days. A month as a duration rather than a calendar month — TTL is measured in ledgers. */
export const SWEEP_INTERVAL_SECONDS = 30 * 86_400;

/** Where the addresses come from. Deposit events today; anything that answers this tomorrow. */
export interface Roster {
  /** Every address that has ever held or queued anything in this vault. */
  addresses(): Promise<readonly string[]>;
}

export interface RestoreClient {
  readonly id: string;
  /** `restore_position(user)`. Permissionless, so this needs no authority over `user`. */
  restorePosition(user: string): Promise<string>;
}

export interface SweepState {
  /** Unix seconds of the last completed sweep, or `null` if none has run. */
  readonly lastSweptAt: number | null;
}

export interface SweepResult {
  readonly attempted: number;
  readonly restored: number;
  /** Addresses whose restore failed, with the reason. A failure here is not fatal — see below. */
  readonly failed: readonly { readonly address: string; readonly why: string }[];
  readonly sweptAt: number;
}

/**
 * Whether a sweep is due.
 *
 * A keeper that has never swept sweeps immediately: the alternative is that a fresh deployment waits
 * a month before its first maintenance, which is exactly the window in which nobody is watching yet.
 */
export function isDue(state: SweepState, now: number): boolean {
  if (state.lastSweptAt === null) return true;
  return now - state.lastSweptAt >= SWEEP_INTERVAL_SECONDS;
}

/**
 * Bump every known position once.
 *
 * **One failure does not stop the pass.** Each address is independent — a restore that fails for one
 * user tells us nothing about the next — and a sweep that aborts on the first error would leave the
 * rest of the roster unbumped because of somebody else's problem. The failures are collected and
 * reported instead, which is also what makes a partial sweep legible afterwards.
 */
export async function sweep(
  client: RestoreClient,
  roster: Roster,
  now: number,
  onProgress?: (address: string, ok: boolean) => void,
): Promise<SweepResult> {
  const addresses = await roster.addresses();
  const failed: { address: string; why: string }[] = [];
  let restored = 0;

  for (const address of addresses) {
    try {
      await client.restorePosition(address);
      restored++;
      onProgress?.(address, true);
    } catch (error) {
      failed.push({ address, why: error instanceof Error ? error.message : String(error) });
      onProgress?.(address, false);
    }
  }

  return { attempted: addresses.length, restored, failed, sweptAt: now };
}
