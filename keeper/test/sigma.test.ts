/**
 * D-67's estimator, checked where it can drift silently.
 *
 * σ_realized is the denominator of the only figure the project publishes as evidence, and a third
 * party recomputing it from the published series has to land on the *same* number. So the tests
 * that matter here are not "does it return something plausible" — they are the ones that pin the
 * divisor, the annualization constant and the gap rule, each of which is invisible in the result.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ANNUALIZATION,
  DAYS_PER_YEAR,
  INTERVALS_PER_DAY,
  logReturns,
  populationStdDev,
  realizedSigma,
  SigmaError,
  type Sample,
} from "../sigma.ts";

const RES = 300;

/** A tick-aligned series from a list of prices, one resolution apart. */
const series = (prices: readonly number[], start = 1_787_000_000): Sample[] =>
  prices.map((price, i) => ({ ts: start + i * RES, price }));

test("the annualization factor is √(365 · 24 · 12), not a trading-day convention", () => {
  assert.equal(INTERVALS_PER_DAY, 24 * 12);
  assert.equal(DAYS_PER_YEAR, 365);
  assert.equal(ANNUALIZATION, Math.sqrt(105_120));
  // The equity convention would understate σ by ~20 %. Asserted as a number rather than described,
  // because "we use 365" is the kind of claim that survives the edit that stops being true.
  assert.ok(ANNUALIZATION / Math.sqrt(252 * INTERVALS_PER_DAY) > 1.2);
});

test("the divisor is n, not n − 1 — population form", () => {
  // Hand-computed: mean 2, deviations -1, 0, 1, Σd² = 2.
  // Population: √(2/3) = 0.816496…   Sample: √(2/2) = 1.
  const xs = [1, 2, 3];
  assert.ok(Math.abs(populationStdDev(xs) - Math.sqrt(2 / 3)) < 1e-15);
  assert.notEqual(populationStdDev(xs), 1);
});

test("a flat feed has zero volatility, not a small one", () => {
  const r = realizedSigma(series([0.16, 0.16, 0.16, 0.16, 0.16]), RES);
  assert.equal(r.sigma, 0);
  assert.equal(r.returns, 4);
  assert.equal(r.completeness, 1);
});

test("a series with a known return spread annualizes to exactly r · √105120", () => {
  // Alternating ±r log returns: mean 0, population stdev exactly r.
  const r = 0.001;
  const prices = [1];
  for (let i = 1; i <= 8; i++) {
    prices.push(i % 2 === 1 ? Math.exp(r) : 1);
  }
  const out = realizedSigma(series(prices), RES);
  assert.ok(
    Math.abs(out.sigma - r * ANNUALIZATION) < 1e-12,
    `expected ${r * ANNUALIZATION}, got ${out.sigma}`,
  );
  assert.equal(out.returns, 8);
});

test("a gap breaks the chain rather than being bridged", () => {
  // Six ticks with the fourth missing. Two adjacent pairs straddle the hole: (3rd,5th) is the only
  // one, since the 4th is simply absent from the series.
  const s: Sample[] = [
    { ts: 0, price: 1.0 },
    { ts: 300, price: 1.01 },
    { ts: 600, price: 1.02 },
    // 900 missing
    { ts: 1200, price: 1.03 },
    { ts: 1500, price: 1.04 },
  ];
  const { returns, droppedForGaps } = logReturns(s, RES);
  assert.equal(droppedForGaps, 1, "the pair spanning 600 → 1200 is 10 minutes, not 5");
  assert.equal(returns.length, 3);

  const out = realizedSigma(s, RES);
  assert.equal(out.droppedForGaps, 1);
  // Five intervals of span, three returns formed.
  assert.equal(out.completeness, 3 / 5);
  assert.ok(out.completeness < 1, "a feed that dropped a tick must not score as complete");
});

test("steady drift is not volatility", () => {
  // A series compounding at a constant 1 % per tick. Every log return is identical, so their
  // dispersion — which is what σ measures — is exactly zero, however far the price travelled.
  //
  // Written after the first version of this test asserted `σ > 0` on precisely this series and
  // failed. The test was wrong and the estimator was right, and the distinction is worth a test of
  // its own: σ_realized prices the *spread* of returns, and a bidder reading a large price move
  // and expecting a large σ is reading the wrong quantity.
  const out = realizedSigma(series([1, 1.01, 1.0201, 1.030301, 1.04060401]), RES);
  assert.equal(out.sigma, 0);
  assert.equal(out.returns, 4);
});

test("a series whose every pair straddles a gap is refused, not bridged", () => {
  // The same price path sampled every 10 minutes. Bridging would treat each move as a 5-minute
  // return and annualize it against an interval it does not have, inflating σ. Nothing survives the
  // gap rule here, so the epoch is refused rather than mismeasured.
  const bridged: Sample[] = [
    { ts: 0, price: 1 },
    { ts: 600, price: 1.0201 },
    { ts: 1200, price: 1.04060401 },
  ];
  assert.throws(
    () => realizedSigma(bridged, RES),
    (e: unknown) => e instanceof SigmaError && /sparse feed/.test(e.message),
  );
});

test("a sparse feed is refused rather than reported as calm", () => {
  // Two samples, ten minutes apart: one pair, dropped, zero returns. Reporting σ = 0 here would say
  // "the price did not move" when the truth is "we did not look".
  const s: Sample[] = [
    { ts: 0, price: 1 },
    { ts: 600, price: 2 },
  ];
  assert.throws(
    () => realizedSigma(s, RES),
    (e: unknown) => e instanceof SigmaError && /sparse feed/.test(e.message),
  );
});

test("a non-positive price is refused, not logged", () => {
  const s: Sample[] = [
    { ts: 0, price: 1 },
    { ts: 300, price: 0 },
    { ts: 600, price: 1 },
  ];
  assert.throws(() => realizedSigma(s, RES), SigmaError);
});

test("an unsorted or duplicated series is refused", () => {
  const dup: Sample[] = [
    { ts: 300, price: 1 },
    { ts: 300, price: 1.01 },
    { ts: 600, price: 1.02 },
  ];
  assert.throws(() => realizedSigma(dup, RES), SigmaError);

  const back: Sample[] = [
    { ts: 600, price: 1 },
    { ts: 300, price: 1.01 },
    { ts: 900, price: 1.02 },
  ];
  assert.throws(() => realizedSigma(back, RES), SigmaError);
});

test("one sample is not an epoch", () => {
  assert.throws(() => realizedSigma([{ ts: 0, price: 1 }], RES), SigmaError);
  assert.throws(() => realizedSigma([], RES), SigmaError);
});

test("the estimator follows the feed's resolution rather than assuming 300", () => {
  // D-58: the vault holds no `resolution` field and must never grow one. The same rule applies
  // here — if Reflector moved to a 60 s grid, a hardcoded 300 would drop every pair as a gap.
  const s: Sample[] = [
    { ts: 0, price: 1 },
    { ts: 60, price: 1.001 },
    { ts: 120, price: 1.002 },
    { ts: 180, price: 1.0015 },
  ];
  assert.throws(() => realizedSigma(s, 300), SigmaError);
  const out = realizedSigma(s, 60);
  assert.equal(out.returns, 3);
  assert.equal(out.completeness, 1);
});

test("σ is scale-free: the same series at a different price scale gives the same number", () => {
  // The sampler normalizes, and ratios cancel the scale — but only if the scale is constant across
  // the series, which is why a mid-epoch `decimals` change is a refusal upstream rather than a
  // rescaling here (D-68's hazard, the same one).
  const prices = [0.16, 0.1612, 0.1605, 0.1631, 0.1622, 0.1618];
  const a = realizedSigma(series(prices), RES);
  const b = realizedSigma(series(prices.map((p) => p * 1e7)), RES);
  assert.ok(Math.abs(a.sigma - b.sigma) < 1e-12);
});
