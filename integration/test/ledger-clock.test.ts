/**
 * Tests for the ledger clock.
 *
 * Driven through a fake RPC rather than the network, because the cases worth pinning are the ones a
 * healthy testnet will not produce on demand: a stalled ledger, a clock that arrives exactly on the
 * boundary, a close time the RPC returns as a string.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  LedgerClockError,
  ledgerNow,
  ledgerSecondsUntil,
  waitUntilLedgerTime,
  type LedgerClockRpc,
} from "../ledger-clock.ts";

/** A ledger that closes every `stepSeconds` of ledger time, one step per call. */
function ticking(from: number, stepSeconds = 5, closes = true): LedgerClockRpc & { calls: number } {
  let closeTime = from;
  let sequence = 1_000;
  return {
    calls: 0,
    getLatestLedger(this: { calls: number }) {
      const current = { sequence, closeTime: String(closeTime) };
      this.calls += 1;
      if (closes) {
        closeTime += stepSeconds;
        sequence += 1;
      }
      return Promise.resolve(current);
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

test("close time is read as a number even though RPC sends a string", async () => {
  // Measured 2026-08-20: testnet returns `"closeTime":"1787240723"`. A `>=` against a string is a
  // lexicographic comparison that happens to be right for ten-digit values and stops being right
  // in 2286 — and long before that, silently wrong against any shorter number.
  const t = await ledgerNow(ticking(1_787_240_723));
  assert.equal(t.closeTime, 1_787_240_723);
  assert.equal(typeof t.closeTime, "number");
});

test("a close time that cannot be used is refused rather than coerced", async () => {
  for (const bad of ["", "not-a-time", "0", 0]) {
    const rpc: LedgerClockRpc = { getLatestLedger: () => Promise.resolve({ sequence: 1, closeTime: bad }) };
    await assert.rejects(() => ledgerNow(rpc), LedgerClockError);
  }
});

test("the wall-clock drift is reported rather than assumed away", async () => {
  const wall = Math.floor(Date.now() / 1000);
  const t = await ledgerNow(ticking(wall - 4));
  assert.ok(t.driftFromWallClock <= -3 && t.driftFromWallClock >= -6, `drift was ${t.driftFromWallClock}`);
});

test("a wait that is already satisfied costs one call and no sleep", async () => {
  const rpc = ticking(2_000);
  let slept = 0;
  const t = await waitUntilLedgerTime(rpc, 1_900, {
    sleep: () => {
      slept += 1;
      return Promise.resolve();
    },
  });
  assert.equal(slept, 0);
  assert.equal(t.closeTime, 2_000);
  assert.equal(rpc.calls, 1);
});

test("the target is inclusive — arriving exactly on the boundary is arriving", async () => {
  const rpc = ticking(1_000, 5);
  const t = await waitUntilLedgerTime(rpc, 1_010, { sleep: noSleep });
  assert.equal(t.closeTime, 1_010);
});

test("a stalled ledger refuses with the measurement, not with 'timed out'", async () => {
  // The ledger stops closing. A wall-clock sleep would have sailed past the deadline and submitted
  // into a phase the chain never entered.
  const rpc = ticking(500, 0, false);
  await assert.rejects(
    () => waitUntilLedgerTime(rpc, 600, { sleep: noSleep, timeoutSeconds: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof LedgerClockError);
      assert.match(err.message, /stood at 500/);
      assert.match(err.message, /100s short/);
      assert.match(err.message, /advanced 0s across 0 ledger\(s\)/);
      return true;
    },
  );
});

test("ledgerSecondsUntil answers in ledger time, and goes negative once the window has closed", async () => {
  assert.equal(await ledgerSecondsUntil(ticking(1_000), 1_020), 20);
  assert.equal(await ledgerSecondsUntil(ticking(1_030), 1_020), -10);
});
