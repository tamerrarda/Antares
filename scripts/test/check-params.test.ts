/**
 * `check-params.ts`'s own unit inventory — `06-TEST-PLAN.md` §2 and `DEV3.md` §6.1.
 *
 * Four things are required of this file and each has a test below: **one rejecting case per gate**;
 * a `--fast-test` profile that violates gate 3 is **still rejected** while the same profile
 * violating 1, 2, 4 and 5 passes; **σ is read from measured data rather than a constant**; and
 * `floor / fair` is printed across the σ range. D-86's bounty margin is tested here too, and the
 * assertion that matters most is the one saying it can never change a verdict.
 *
 * Run: `node --experimental-strip-types --test test/*.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BPS,
  EPOCH_PARAM_FIELDS,
  ParamError,
  checkGates,
  checkSet,
  fairValueBps,
  floorOverFair,
  loadInstances,
  loadSeries,
  normalCdf,
  realizedVolatility,
  bountyMargin,
  sigmaRange,
  SETTLE_FEE_STROOPS,
  type CoherenceParams,
  type SigmaRange,
} from "../check-params.ts";

// §1b's own worked figures, which are what the gates are stated against.
const SIGMA_LOW = 0.337;
const SIGMA_HIGH = 0.984;
const WEEK = 604_800;

const range = (low: number, high: number): SigmaRange => ({
  low,
  high,
  windows: [
    { days: 30, sigma: low },
    { days: 90, sigma: high },
  ],
});

/** Instance A, the mainnet target (02-CONTRACT-SPEC §1's instance table). */
const A: CoherenceParams = {
  epoch_duration: WEEK,
  strike_bps_otm: 300,
  premium_start_bps: 450,
  premium_floor_bps: 40,
  max_deviation_bps: 100,
};

// =================================================================================================
// The arithmetic, against §1b's published table
// =================================================================================================

test("the fair value reproduces §1b's own table, which is what makes the gate trustworthy", () => {
  // A gate whose arithmetic disagreed with the document it enforces would be worse than no gate,
  // so this pins it against the four rows §1b prints for 3 % OTM over 7 days.
  const at = (sigma: number) => fairValueBps(300, WEEK, sigma);
  assert.ok(Math.abs(at(0.337) - 75.6) < 0.2, `σ 33.7 % → ${at(0.337).toFixed(1)}, §1b says 75.6`);
  assert.ok(Math.abs(at(0.502) - 156.5) < 0.5, `σ 50.2 % → ${at(0.502).toFixed(1)}, §1b says 156.5`);
  assert.ok(Math.abs(at(0.6) - 207.4) < 0.5, `σ 60 % → ${at(0.6).toFixed(1)}, §1b says 207.4`);
  assert.ok(Math.abs(at(0.984) - 414.3) < 0.5, `σ 98.4 % → ${at(0.984).toFixed(1)}, §1b says 414.3`);
});

test("the fair value reproduces §1b's sensitivity table, which is the reason the strike moved", () => {
  // §1b's regime-ratio column: far-out-of-the-money options are exponentially sensitive to σ and
  // near-the-money ones are close to linear. That asymmetry is why the old 5 % / 3 d default was
  // unfixable by tuning the band, and it is worth pinning because gate 4 rests on it.
  const ratio = (otm: number, dur: number) => fairValueBps(otm, dur, 0.98) / fairValueBps(otm, dur, 0.337);
  assert.ok(ratio(500, 259_200) > 15, "5 % OTM / 3 d should swing more than 15× (§1b says 23×)");
  assert.ok(ratio(300, WEEK) < 8, "3 % OTM / 7 d should swing under 8× (§1b says 5.4×)");
});

test("normalCdf is accurate enough that it cannot move a verdict", () => {
  // Compared against the **true** values of Φ rather than their rounded two-figure forms. The
  // first version of this test asserted `|Φ(1.96) − 0.975| < 1e-6` and failed — not because the
  // approximation was poor but because Φ(1.96) is 0.97500210485…, so the tolerance was being spent
  // on the rounding in the constant rather than on the error being measured. Measured worst error
  // across these points: 6.9e-8, which is four orders of magnitude finer than the basis point the
  // gates compare in, so it cannot move a verdict.
  const cases: Array<[number, number]> = [
    [0, 0.5],
    [1, 0.8413447460685429],
    [1.96, 0.9750021048517795],
    [-1.96, 0.024997895148220435],
    [2.5, 0.9937903346742238],
  ];
  for (const [x, exact] of cases) {
    assert.ok(
      Math.abs(normalCdf(x) - exact) < 7.5e-8,
      `Φ(${x}) = ${normalCdf(x)}, exact ${exact}, error ${Math.abs(normalCdf(x) - exact)}`,
    );
  }
  assert.ok(normalCdf(-10) >= 0 && normalCdf(10) <= 1, "and it stays a probability at the tails");
});

test("a zero or negative horizon or volatility prices at zero rather than NaN", () => {
  // Reachable from a fast-test profile and from a malformed series; a NaN here would propagate
  // through every comparison as `false` and read as a gate failure for the wrong reason.
  assert.equal(fairValueBps(300, 0, 0.5), 0);
  assert.equal(fairValueBps(300, WEEK, 0), 0);
});

// =================================================================================================
// One rejecting case per gate
// =================================================================================================

const gate = (results: ReturnType<typeof checkGates>, n: 1 | 2 | 3 | 4 | 5) =>
  results.find((r) => r.gate === n)!;

test("REJECT gate 1: a start below fair value at the top of the measured regime", () => {
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  assert.ok(gate(checkGates(A, sigma), 1).passed, "instance A passes at §1b's own σ range");
  const bad = { ...A, premium_start_bps: 100 };
  assert.equal(gate(checkGates(bad, sigma), 1).passed, false);
});

test("REJECT gate 2: a floor below half the option's worth at the low end", () => {
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  assert.ok(gate(checkGates(A, sigma), 2).passed);
  const bad = { ...A, premium_floor_bps: 1 };
  assert.equal(gate(checkGates(bad, sigma), 2).passed, false);
});

test("REJECT gate 3: a breaker at or wider than half the OTM buffer", () => {
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  assert.ok(gate(checkGates(A, sigma), 3).passed);
  // The boundary is strict: exactly half is a refusal, because the guard has to sit *inside* the
  // buffer it protects.
  assert.equal(gate(checkGates({ ...A, max_deviation_bps: 150 }, sigma), 3).passed, false);
  assert.equal(gate(checkGates({ ...A, max_deviation_bps: 149 }, sigma), 3).passed, true);
});

test("REJECT gate 4: a regime the band cannot span", () => {
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  // §1b's own counter-example: 5 % OTM over 3 days swings ~23×, and no band spanning 11× can hold
  // it. This is the arithmetic check that would have caught the original error immediately.
  const wide: CoherenceParams = {
    epoch_duration: 259_200,
    strike_bps_otm: 500,
    premium_start_bps: 450,
    premium_floor_bps: 40,
    max_deviation_bps: 100,
  };
  assert.equal(gate(checkGates(wide, sigma), 4).passed, false);
});

test("REJECT gate 5: a reserve above the option's own worth, which gates 1-4 all admit", () => {
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  // The defect §1b says gate 5 repairs: gate 2 bounds the floor from *below* and nothing bounded it
  // from above, so a floor exceeding fair(σ_low) passed all four. Constructed here to prove gate 5
  // is not implied by the others — the assertion is that 1, 2 and 4 pass while 5 fails.
  const greedy: CoherenceParams = { ...A, premium_floor_bps: 76 };
  const r = checkGates(greedy, sigma);
  assert.ok(gate(r, 1).passed && gate(r, 2).passed && gate(r, 4).passed, "1, 2 and 4 admit it");
  assert.equal(gate(r, 5).passed, false, "and 5 is the only one that catches it");
});

// =================================================================================================
// The fast-test exemption — gate 3 survives it and nothing else does
// =================================================================================================

test("a fast-test profile violating gate 3 is STILL rejected", () => {
  // §1b: exempt from 1, 2, 4 and 5 — never 3. This script is gate 3's only enforcer anywhere, and
  // without it a fast-test profile could ship a breaker wider than its own OTM buffer, which is a
  // strike set below the prevailing market at open (A-7).
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  const profile: CoherenceParams = {
    epoch_duration: 2_400,
    strike_bps_otm: 300,
    premium_start_bps: 450,
    premium_floor_bps: 40,
    max_deviation_bps: 150, // exactly half — a refusal
  };
  const r = checkGates(profile, sigma, { fastTest: true });
  assert.equal(gate(r, 3).passed, false, "gate 3 must still fail");
  assert.equal(gate(r, 3).exempt, false, "and must not be marked exempt");
  assert.equal(checkSet([{ suffix: "-FT", params: profile }], sigma, { fastTest: true }).passed, false);
});

test("the same fast-test profile violating 1, 2, 4 and 5 passes", () => {
  // The other half of the rule, and the reason the exemption exists: at a second-scale
  // `epoch_duration` fair value collapses toward zero, so gate 5 compares a positive floor against
  // ~0 and gate 4's ratio explodes. Applied literally, §1b would refuse every deployment Phase 6a
  // depends on.
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  const profile: CoherenceParams = {
    epoch_duration: 2_400,
    strike_bps_otm: 300,
    premium_start_bps: 450,
    premium_floor_bps: 40,
    max_deviation_bps: 100,
  };
  // Without the exemption it fails — which is what makes the exemption load-bearing rather than
  // decorative.
  const strict = checkGates(profile, sigma);
  assert.ok(
    !gate(strict, 1).passed || !gate(strict, 2).passed || !gate(strict, 4).passed || !gate(strict, 5).passed,
    "a second-scale profile must fail at least one of 1/2/4/5 unexempted, or the exemption is pointless",
  );
  const r = checkGates(profile, sigma, { fastTest: true });
  assert.ok(
    r.every((g) => g.passed),
    "with the exemption it passes",
  );
  assert.deepEqual(
    r.filter((g) => g.exempt).map((g) => g.gate),
    [1, 2, 4, 5],
    "exactly 1, 2, 4 and 5 are exempt — never 3",
  );
});

// =================================================================================================
// D-57: the whole set is refused if any one instance fails
// =================================================================================================

test("one failing instance refuses the entire set", () => {
  // D-57 exists because a partially-deployable experiment is how instances C and D reached review
  // while being un-deployable.
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  const set = [
    { suffix: "-A", params: A },
    { suffix: "-BAD", params: { ...A, max_deviation_bps: 200 } },
  ];
  const out = checkSet(set, sigma);
  assert.equal(out.passed, false, "the set is refused");
  assert.equal(out.instances[0]!.passed, true, "even though the first instance is fine");
  assert.equal(out.instances[1]!.passed, false);
});

// =================================================================================================
// σ is measured, never assumed
// =================================================================================================

test("realized volatility is computed from the series, and two different series give two answers", () => {
  // The rule D-53 bought with a factor-of-two error: a constant baked into the script is the defect
  // the gate exists to prevent. Asserted by construction — a flat series has zero volatility and a
  // moving one does not, so the number cannot be coming from anywhere but the data.
  const flat = Array.from({ length: 40 }, () => 0.16);
  assert.equal(realizedVolatility(flat, 30), 0);

  // An alternating 5 % series: log returns of ±0.0488, so the sample deviation is ≈ 0.0494 and
  // annualizing multiplies by √365 ≈ 19.1 — about 0.94. Asserted as a band rather than "> 1",
  // which is what the first version said and was wrong by 6 %; a bound guessed rather than
  // computed is a bound that fails on correct code.
  const moving = Array.from({ length: 40 }, (_, i) => 0.16 * (i % 2 === 0 ? 1 : 1.05));
  const sigma = realizedVolatility(moving, 30);
  assert.ok(sigma > 0.9 && sigma < 1.0, `an alternating 5 % series annualizes near 0.94, got ${sigma}`);
});

test("REJECT a malformed or too-short series rather than guessing", () => {
  assert.throws(() => realizedVolatility([0.1, 0.2], 30), ParamError);
  assert.throws(() => realizedVolatility([0.1, 0, 0.2, 0.3], 3), ParamError);

  const dir = mkdtempSync(join(tmpdir(), "antares-series-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ cadence: "hourly", closes: [1, 2, 3, 4] }));
  // A different cadence is a refusal rather than a silent rescaling: the annualization here assumes
  // daily closes because §1b's measurement did.
  assert.throws(() => loadSeries(p), ParamError);

  writeFileSync(p, JSON.stringify({ cadence: "daily", closes: [1, 2] }));
  assert.throws(() => loadSeries(p), ParamError);
});

test("sigmaRange takes the low and high of every window it could measure", () => {
  const closes = Array.from({ length: 95 }, (_, i) => 0.16 + Math.sin(i / 3) * 0.01);
  const s = sigmaRange({ asset: "X", cadence: "daily", source: "t", measuredAt: "t", closes });
  assert.deepEqual(
    s.windows.map((w) => w.days),
    [30, 60, 90],
  );
  assert.equal(s.low, Math.min(...s.windows.map((w) => w.sigma)));
  assert.equal(s.high, Math.max(...s.windows.map((w) => w.sigma)));
});

// =================================================================================================
// D-62's margin is reported whether or not the gates pass
// =================================================================================================

test("floor / fair is produced across the whole measured range", () => {
  // §1b: at 0.52-0.55 today, a clearing-gate threshold of 0.5 would have been passed by an auction
  // that never left the floor. Printing the margin is what stops that being discovered afterwards,
  // so it is produced for every window rather than only the one that binds a gate.
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  const m = floorOverFair(A, sigma);
  assert.equal(m.length, 2);
  assert.ok(m.every((x) => x.fair > 0 && Number.isFinite(x.ratio)));
  // At §1b's own σ_low the published margin is 40 / 75.6 = 0.529.
  assert.ok(Math.abs(m[0]!.ratio - 0.529) < 0.01, `got ${m[0]!.ratio.toFixed(3)}, §1b implies 0.529`);
});

test("BPS matches the contract's own denominator", () => {
  assert.equal(BPS, 10_000);
});

// =================================================================================================
// loadInstances — the sixteen fields, and the refusal to default
// =================================================================================================

const RENT = { rent_threshold: 120_960, rent_extend_to: 518_400 };

const SHARED_TEN = {
  auction_duration: 2700,
  twap_window: 900,
  guard_window: 3600,
  max_staleness: 600,
  oracle_dead_after: 43_200,
  settle_grace: 7200,
  unresolved_after: 75_600,
  min_fill: 1_000_000_000,
  min_deposit: 100_000_000,
  settle_bounty_bps: 25,
};

const SIX_A = {
  epoch_duration: 604_800,
  strike_bps_otm: 300,
  premium_start_bps: 450,
  premium_floor_bps: 40,
  max_deviation_bps: 100,
  min_idle_gap: 14_400,
};

function writeInstances(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "antares-instances-")), "instances.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

test("loadInstances merges shared and per-instance into the full sixteen", () => {
  const path = writeInstances({
    shared: { ...SHARED_TEN, ...RENT, deposit_cap: 1_000_000_000_000 },
    instances: [{ suffix: "-A", params: SIX_A }],
  });
  const [a] = loadInstances(path);
  assert.equal(Object.keys(a!.params).length, 16);
  assert.deepEqual(Object.keys(a!.params).sort(), Object.keys(EPOCH_PARAM_FIELDS).sort());
  assert.equal(a!.params["auction_duration"], 2700, "shared value did not reach the instance");
  assert.equal(a!.params["premium_floor_bps"], 40, "own value did not survive the merge");
  assert.equal(a!.depositCap, 1_000_000_000_000);
});

test("an instance may override a shared field, and the override wins", () => {
  const path = writeInstances({
    shared: { ...SHARED_TEN, ...RENT, deposit_cap: 1_000_000_000_000 },
    instances: [{ suffix: "-C", params: { ...SIX_A, auction_duration: 1800 } }],
  });
  assert.equal(loadInstances(path)[0]!.params["auction_duration"], 1800);
});

test("a missing field is a refusal, never a default", () => {
  const short = { ...SHARED_TEN };
  delete (short as Record<string, unknown>)["unresolved_after"];
  const path = writeInstances({
    shared: { ...short, ...RENT, deposit_cap: 1_000_000_000_000 },
    instances: [{ suffix: "-A", params: SIX_A }],
  });
  assert.throws(() => loadInstances(path), /missing unresolved_after/);
});

test("an unrecognised field is a refusal — this is the typo case, and it is the point", () => {
  // `unresolved_afer` would otherwise leave the real field at whatever the code chose, the gate
  // would pass, and the deployed vault would differ from the reviewed one in a field nobody read.
  const typo = { ...SHARED_TEN, unresolved_afer: 75_600 };
  delete (typo as Record<string, unknown>)["unresolved_after"];
  const path = writeInstances({
    shared: { ...typo, ...RENT, deposit_cap: 1_000_000_000_000 },
    instances: [{ suffix: "-A", params: SIX_A }],
  });
  assert.throws(() => loadInstances(path), /"unresolved_afer", which is not a field of EpochParams/);
});

test("the bare-array form still loads, so DEV2's recorded reproduction command keeps working", () => {
  const path = writeInstances([
    { suffix: "-A", params: { ...SIX_A, ...SHARED_TEN }, deposit_cap: 1_000_000_000_000, ...RENT },
  ]);
  assert.equal(loadInstances(path)[0]!.params["settle_bounty_bps"], 25);
});

test("a suffix the constructor would reject is refused here, before a wasm upload is spent", () => {
  const path = writeInstances({
    shared: { ...SHARED_TEN, ...RENT, deposit_cap: 1_000_000_000_000 },
    instances: [{ suffix: "-LONG", params: SIX_A }],
  });
  // 5 bytes against the constructor's `token_suffix.len() <= 4`.
  assert.throws(() => loadInstances(path), /caps token_suffix\s+at 4/);
});

test("a deposit_cap below min_deposit is refused — validate_params would call it a vault nobody can enter", () => {
  const path = writeInstances({
    shared: { ...SHARED_TEN, ...RENT, deposit_cap: 1000 },
    instances: [{ suffix: "-A", params: SIX_A }],
  });
  assert.throws(() => loadInstances(path), /below min_deposit/);
});

test("an empty set does not pass by having nothing to refuse", () => {
  assert.throws(
    () => loadInstances(writeInstances({ shared: { ...SHARED_TEN, ...RENT }, instances: [] })),
    /carries no instances/,
  );
  assert.throws(
    () => loadInstances(writeInstances({ shared: { ...SHARED_TEN, ...RENT } })),
    /neither an array/,
  );
});

test("the committed instances.json loads, and every instance carries all sixteen", () => {
  const specs = loadInstances(new URL("../instances.json", import.meta.url).pathname);
  assert.equal(specs.length, 5, "02-CONTRACT-SPEC §1 deploys five (D-47/D-57)");
  assert.deepEqual(
    specs.map((s) => s.suffix),
    ["-A", "-B", "-C", "-D", "-E"],
  );
  for (const s of specs) {
    assert.deepEqual(Object.keys(s.params).sort(), Object.keys(EPOCH_PARAM_FIELDS).sort(), s.suffix);
    // The relations validate_params enforces against epoch_duration — the two that a *shared*
    // auction_duration and a per-instance epoch_duration could break, and the reason the shared
    // block was checked against the short epochs before it was written.
    assert.ok(
      s.params["auction_duration"]! <= Math.floor(s.params["epoch_duration"] / 24),
      `${s.suffix}: auction_duration > epoch_duration / 24`,
    );
    assert.ok(
      s.params["min_idle_gap"]! >= Math.floor(s.params["epoch_duration"] / 50),
      `${s.suffix}: min_idle_gap < epoch_duration / 50`,
    );
    assert.ok(
      s.params["unresolved_after"]! > s.params["oracle_dead_after"]!,
      `${s.suffix}: void branch unreachable`,
    );
    assert.ok(s.depositCap >= s.params["min_deposit"]!, `${s.suffix}: cap below min_deposit`);
  }
});

test("the rent pair is required and validate_rent's ordering is enforced before a wasm is spent", () => {
  const base = { ...SHARED_TEN, deposit_cap: 1_000_000_000_000 };
  // Absent: 03-STORAGE-TTL §2 tunes these and step 3b asserts the INTENDED value against the live
  // max_ttl, which presupposes an intention somebody reviewed rather than a script's pick.
  assert.throws(
    () => loadInstances(writeInstances({ shared: base, instances: [{ suffix: "-A", params: SIX_A }] })),
    /no positive integer "rent_threshold"/,
  );
  // Out of order: validate_rent requires 0 < threshold < extend_to, and reaching the constructor
  // to learn that means an upload has already been paid for.
  assert.throws(
    () =>
      loadInstances(
        writeInstances({
          shared: { ...base, rent_threshold: 518_400, rent_extend_to: 120_960 },
          instances: [{ suffix: "-A", params: SIX_A }],
        }),
      ),
    /validate_rent requires 0 < threshold < extend_to/,
  );
});

test("the committed instances.json carries the rent pair on every instance", () => {
  for (const s of loadInstances(new URL("../instances.json", import.meta.url).pathname)) {
    assert.ok(s.rentThreshold > 0 && s.rentThreshold < s.rentExtendTo, s.suffix);
  }
});

// -------------------------------------------------------------------------------------------
// D-86 — the settle-bounty margin. A warning, and the tests exist to keep it one.
// -------------------------------------------------------------------------------------------

test("the bounty margin is judged at the worst fill the parameters allow, not at a typical one", () => {
  // min_fill = 100 XLM cleared at instance E's 55 bps floor: the case D-86 measured.
  const m = bountyMargin({ ...A, premium_floor_bps: 55, min_fill: 1_000_000_000, settle_bounty_bps: 25 });
  assert.ok(m !== null);
  assert.equal(m.premium, 5_500_000); // 100 XLM × 55 bps
  assert.equal(m.bounty, 13_750); // × 25 bps
  assert.equal(m.fee, SETTLE_FEE_STROOPS);
  assert.equal(m.pays, false);
});

test("the margin flips at exactly the min_fill D-86 derived, and one stroop-tick below it does not", () => {
  const at = (minFill: number) =>
    bountyMargin({ ...A, premium_floor_bps: 55, min_fill: minFill, settle_bounty_bps: 25 });
  // 1 761 XLM at a 55 bps floor is the first fill whose bounty clears the measured fee.
  assert.equal(at(17_610_000_000)?.pays, true);
  assert.equal(at(17_600_000_000)?.pays, false);
  // And 968 bps at min_fill = 100 XLM is the figure that does NOT clear it: 242 000 < 242 033.
  const justUnder = bountyMargin({
    ...A,
    premium_floor_bps: 968,
    min_fill: 1_000_000_000,
    settle_bounty_bps: 25,
  });
  assert.equal(justUnder?.bounty, 242_000);
  assert.equal(justUnder?.pays, false);
  assert.equal(
    bountyMargin({ ...A, premium_floor_bps: 969, min_fill: 1_000_000_000, settle_bounty_bps: 25 })?.pays,
    true,
  );
});

// The premium that first pays for its own settlement, stated in XLM rather than in bps of a
// min_fill — because this is the figure a round is judged against, and A's round 1 landed inside
// the gap the old constant opened. It collected 9.4400047 XLM: above 9.123, the break-even under
// the 228 075 this constant used to carry, and below 9.68132, the break-even under what its own
// settle was actually charged. Pinned so the two numbers can never silently drift back together.
test("A's round 1 sits between the old constant's break-even and the real one", () => {
  const breakEven = (feeStroops: number) => feeStroops * (10_000 / 25);
  assert.equal(breakEven(228_075), 91_230_000);
  assert.equal(breakEven(SETTLE_FEE_STROOPS), 96_813_200);
  const aRound1Premium = 94_400_047;
  assert.ok(aRound1Premium > breakEven(228_075), "the old constant called it profitable");
  assert.ok(aRound1Premium < breakEven(SETTLE_FEE_STROOPS), "its own fee says it was not");
});

test("a caller who supplies only the gated five gets no margin rather than one off a default", () => {
  // Silence would be worse than either answer: it would look like a computed pass.
  assert.equal(bountyMargin(A), null);
  assert.equal(bountyMargin({ ...A, min_fill: 1_000_000_000 }), null);
  assert.equal(bountyMargin({ ...A, settle_bounty_bps: 25 }), null);
});

test("the margin never changes a verdict — this is the whole point of D-86", () => {
  const sigma = range(SIGMA_LOW, SIGMA_HIGH);
  // A floor so low that no bounty could ever pay, on a parameter set that passes every gate.
  const starved = { ...A, min_fill: 1, settle_bounty_bps: 1 };
  const out = checkSet([{ suffix: "-A", params: starved }], sigma);
  assert.equal(out.instances[0]!.bounty?.pays, false);
  assert.equal(out.passed, true);
  // And the converse: a bounty that pays handsomely rescues nothing.
  const rich = { ...A, premium_floor_bps: 76, min_fill: 100_000_000_000, settle_bounty_bps: 25 };
  const bad = checkSet([{ suffix: "-A", params: rich }], sigma);
  assert.equal(bad.instances[0]!.bounty?.pays, true);
  assert.equal(bad.passed, false);
});

test("every committed instance is below the line, which is why this warns instead of refusing", () => {
  const specs = loadInstances(new URL("../instances.json", import.meta.url).pathname);
  for (const spec of specs) {
    const m = bountyMargin(spec.params);
    assert.ok(m !== null, `${spec.suffix} carries min_fill and settle_bounty_bps`);
    assert.equal(m.pays, false, `${spec.suffix} would be refused by a gate, and should not be`);
  }
});
