/**
 * The payoff table's arithmetic, which is the part of it that can be wrong.
 *
 * The table replaces a yield figure (D-35), so it is the number a depositor decides on. Two
 * properties matter more than any single value: above the strike the worth stops moving, and every
 * amount that leaves the vault rounds down. A test that only checked one row would catch neither.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { payoff } from "../lib/payoff.ts";

const XLM = 10_000_000n;
const OPEN = 2_065_000n; // $0.2065 at 7 dp
const STRIKE = 2_126_950n; // 3% above open
const AMOUNT = 1_000n * XLM;
const PREMIUM_BPS = 85.6;

test("the premium is credited up front and rounds down", () => {
  const { credited } = payoff(AMOUNT, OPEN, STRIKE, PREMIUM_BPS, [0]);
  // 1000 XLM × 85.6 bps = 8.56 XLM exactly, which is 85_600_000 stroops at 7 dp.
  assert.equal(credited, 85_600_000n);
});

test("below the strike nothing is paid out and the premium is the whole story", () => {
  const { rows } = payoff(AMOUNT, OPEN, STRIKE, PREMIUM_BPS, [-10, 0, 2]);
  for (const r of rows) {
    assert.equal(r.capped, false, `a ${r.movePct}% move should not be in the money`);
    assert.equal(r.held, AMOUNT + 85_600_000n, "the holding is the deposit plus the premium");
    assert.ok(r.difference > 0n, "and it is worth more than the same XLM held alone");
  }
});

test("above the strike the worth stops moving — the flat line IS the cap", () => {
  const { rows } = payoff(AMOUNT, OPEN, STRIKE, PREMIUM_BPS, [6, 10, 25, 100]);
  const worths = rows.map((r) => r.worth);
  for (const r of rows) assert.equal(r.capped, true);

  // Not merely "smaller than holding" — nearly CONSTANT. A 100% move is worth barely more than a
  // 6% one, which is the property the whole table exists to show.
  const spread = Number(worths.at(-1)! - worths[0]!) / Number(worths[0]!);
  assert.ok(spread < 0.02, `worth should be flat above the strike, spread was ${(spread * 100).toFixed(2)}%`);
});

test("the cap costs money, and the table says so", () => {
  const { rows } = payoff(AMOUNT, OPEN, STRIKE, PREMIUM_BPS, [10]);
  assert.ok(rows[0]!.difference < 0n, "above the strike, holding plain XLM would have been better");
});

test("payouts round down, so the vault never pays a stroop it does not owe", () => {
  // An amount and a price chosen so `amount × (close − strike)` does not divide evenly.
  const odd = payoff(3n * XLM + 1n, OPEN, STRIKE, 33.3, [7]);
  const r = odd.rows[0]!;
  assert.equal(r.capped, true);
  // Reconstruct the exact rational payout and check the row never exceeds it.
  const close = r.close;
  const exact = ((3n * XLM + 1n) * (close - STRIKE)) / close;
  const impliedPayout = 3n * XLM + 1n + odd.credited - r.held;
  assert.ok(impliedPayout <= exact, "the payout must not exceed the exact value");
  assert.ok(exact - impliedPayout < 2n, "and must be within one stroop of it");
});
