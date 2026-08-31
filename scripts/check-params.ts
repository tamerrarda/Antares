/**
 * `check-params.ts` — the parameter-coherence gate (09-DEPLOYMENT §2 step 0b, D-31/D-53/D-68).
 *
 * `02-CONTRACT-SPEC.md` §1b is the single home for the five gates and for the fast-test exemption;
 * this enforces them and restates neither. What lives here is the arithmetic §1b describes —
 * measured realized volatility, Black-Scholes fair value, and the five comparisons — plus the
 * refusal that stops a deploy.
 *
 * # Why this script exists at all
 *
 * `strike_bps_otm`, `epoch_duration` and the premium band are not independent. Get them wrong in
 * one direction and every epoch lapses while the vault looks alive; wrong in the other and it sells
 * options below fair value on every fill. The first version of §1b hard-coded σ ∈ [60 %, 100 %] as
 * though volatility were a constant, and the measurement that replaced it (D-53) showed the band
 * was wrong by a factor of two at the low end — which had priced the five planned vaults at
 * 7.3 bps against a 28 bps floor, so **not one of them could ever have been filled**.
 *
 * So the one rule this file will not bend: **σ is measured, never assumed.** It is computed here
 * from a price series, and the series is an input rather than a constant. A default baked into
 * this script would reintroduce exactly the defect it exists to prevent.
 *
 * # Gate 3 is the one that survives the fast-test exemption
 *
 * `max_deviation_bps < strike_bps_otm / 2` is duration-independent, and **this script is its only
 * enforcer anywhere** — the on-chain validation bounds the two parameters separately and never
 * against each other. A fast-test profile is exempt from gates 1, 2, 4 and 5 and never from 3,
 * because without it such a profile could ship a breaker wider than its own OTM buffer, which is a
 * strike set below the prevailing market at open (A-7).
 */

import { readFileSync } from "node:fs";

// --------------------------------------------------------------------------------------------
// The maths
// --------------------------------------------------------------------------------------------

/** Basis-point denominator, matching the contract's own `BPS`. */
export const BPS = 10_000;

const DAYS_PER_YEAR = 365;
const SECONDS_PER_DAY = 86_400;

/**
 * Standard normal CDF.
 *
 * Abramowitz & Stegun 26.2.17, whose absolute error is below 7.5e-8 — four orders of magnitude
 * finer than the basis point these gates compare in, so the approximation cannot move a verdict.
 * Written out rather than pulled from a dependency: this is the only numerical routine in the
 * script, and a deploy gate with a supply-chain edge for one function is a poor trade (D-24's
 * reasoning, applied off-chain).
 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * Black-Scholes value of the call this vault writes, as **basis points of notional**.
 *
 * `r = 0` deliberately: the position is XLM-denominated collateral against an XLM-denominated
 * strike, so there is no financing leg to discount. Adding a rate would be modelling a currency
 * pair this vault does not hold.
 *
 * The strike is `spot × (1 + otm)`, so spot cancels and the answer depends only on the OTM offset,
 * the horizon and σ — which is why the gates can be checked without a live price.
 *
 * Verified against §1b's own published table before use: 3 % OTM over 7 days at σ = 33.7 % gives
 * **75.59 bps** against the document's 75.6, and at σ = 98.4 % gives 414.5 against 414.3. A gate
 * whose arithmetic disagreed with the table it enforces would be worse than no gate.
 */
export function fairValueBps(strikeBpsOtm: number, epochDurationSeconds: number, sigma: number): number {
  const t = epochDurationSeconds / SECONDS_PER_DAY / DAYS_PER_YEAR;
  if (t <= 0 || sigma <= 0) return 0;
  const moneyness = 1 + strikeBpsOtm / BPS;
  const vol = sigma * Math.sqrt(t);
  const d1 = (-Math.log(moneyness) + (sigma * sigma * t) / 2) / vol;
  const d2 = d1 - vol;
  return (normalCdf(d1) - moneyness * normalCdf(d2)) * BPS;
}

/**
 * Annualized realized volatility from a series of closes, over the last `windowDays` observations.
 *
 * Log returns, sample standard deviation, scaled by `sqrt(365)`. Daily closes are assumed because
 * that is what §1b's own measurement used; the series carries its own cadence so a mismatch is a
 * refusal rather than a silent rescaling.
 */
export function realizedVolatility(closes: readonly number[], windowDays: number): number {
  const slice = closes.slice(-(windowDays + 1));
  if (slice.length < 3) {
    throw new ParamError(
      `a ${windowDays}-day window needs at least 3 closes and the series supplied ${slice.length}`,
    );
  }
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1]!;
    const cur = slice[i]!;
    if (prev <= 0 || cur <= 0) {
      throw new ParamError("a non-positive close is not a price; the series is malformed");
    }
    returns.push(Math.log(cur / prev));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(DAYS_PER_YEAR);
}

export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

// --------------------------------------------------------------------------------------------
// The gates
// --------------------------------------------------------------------------------------------

export interface CoherenceParams {
  readonly epoch_duration: number;
  readonly strike_bps_otm: number;
  readonly premium_start_bps: number;
  readonly premium_floor_bps: number;
  readonly max_deviation_bps: number;
}

export interface SigmaRange {
  /** The lowest measured window — §1b's `σ_low`. */
  readonly low: number;
  /** The highest measured window — `σ_high`. */
  readonly high: number;
  /** Every window that was measured, for the record. */
  readonly windows: ReadonlyArray<{ days: number; sigma: number }>;
}

export interface GateResult {
  readonly gate: 1 | 2 | 3 | 4 | 5;
  readonly name: string;
  readonly passed: boolean;
  /** True when the gate was skipped because the profile is fast-test. */
  readonly exempt: boolean;
  readonly detail: string;
}

/**
 * The five gates of §1b, in order, against a measured σ range.
 *
 * `fastTest` exempts **1, 2, 4 and 5 — never 3**. That is §1b's rule and the asymmetry is not a
 * convenience: at a second-scale `epoch_duration` the fair value collapses toward zero, so gate 5
 * compares a positive floor against ~0 and gate 4's regime ratio explodes; gates 1 and 2 then pass
 * vacuously and are listed only for completeness. Gate 3 is duration-independent and this script
 * is its only enforcer.
 */
export function checkGates(
  params: CoherenceParams,
  sigma: SigmaRange,
  options: { fastTest?: boolean } = {},
): GateResult[] {
  const fastTest = options.fastTest ?? false;
  const fairLow = fairValueBps(params.strike_bps_otm, params.epoch_duration, sigma.low);
  const fairHigh = fairValueBps(params.strike_bps_otm, params.epoch_duration, sigma.high);
  const round = (n: number) => Math.round(n * 100) / 100;

  const exempted = (gate: 1 | 2 | 4 | 5, name: string): GateResult => ({
    gate,
    name,
    passed: true,
    exempt: true,
    detail: "exempt: --fast-test profile (§1b). The record is stamped economically meaningless.",
  });

  const results: GateResult[] = [];

  // 1 — the vault must not open below fair value at the top of the measured regime.
  results.push(
    fastTest
      ? exempted(1, "premium_start_bps >= fair(σ_high)")
      : {
          gate: 1,
          name: "premium_start_bps >= fair(σ_high)",
          passed: params.premium_start_bps >= fairHigh,
          exempt: false,
          detail: `start ${params.premium_start_bps} bps vs fair(σ_high=${round(sigma.high * 100)}%) = ${round(fairHigh)} bps`,
        },
  );

  // 2 — the floor is a reserve price, not a giveaway.
  results.push(
    fastTest
      ? exempted(2, "premium_floor_bps >= fair(σ_low) / 2")
      : {
          gate: 2,
          name: "premium_floor_bps >= fair(σ_low) / 2",
          passed: params.premium_floor_bps >= fairLow / 2,
          exempt: false,
          detail: `floor ${params.premium_floor_bps} bps vs fair(σ_low)/2 = ${round(fairLow / 2)} bps`,
        },
  );

  // 3 — never exempt. The breaker must stay inside its own OTM buffer.
  results.push({
    gate: 3,
    name: "max_deviation_bps < strike_bps_otm / 2",
    passed: params.max_deviation_bps < params.strike_bps_otm / 2,
    exempt: false,
    detail:
      `max_deviation ${params.max_deviation_bps} bps vs strike_bps_otm/2 = ` +
      `${params.strike_bps_otm / 2} bps` +
      (fastTest ? "  (NOT exempt for fast-test profiles — §1b, and this script is its only enforcer)" : ""),
  });

  // 4 — the band has to be able to span the regime at all.
  results.push(
    fastTest
      ? exempted(4, "fair(σ_high)/fair(σ_low) <= start/floor")
      : {
          gate: 4,
          name: "fair(σ_high)/fair(σ_low) <= start/floor",
          passed:
            fairLow > 0 &&
            params.premium_floor_bps > 0 &&
            fairHigh / fairLow <= params.premium_start_bps / params.premium_floor_bps,
          exempt: false,
          detail:
            `regime ratio ${fairLow > 0 ? round(fairHigh / fairLow) : "∞"} vs band ` +
            `${round(params.premium_start_bps / params.premium_floor_bps)}`,
        },
  );

  // 5 — the reserve must sit below the option's own worth by the clearing gate's margin.
  results.push(
    fastTest
      ? exempted(5, "1.30 × premium_floor_bps <= 0.75 × fair(σ_low)")
      : {
          gate: 5,
          name: "1.30 × premium_floor_bps <= 0.75 × fair(σ_low)",
          passed: 1.3 * params.premium_floor_bps <= 0.75 * fairLow,
          exempt: false,
          detail: `1.30×floor = ${round(1.3 * params.premium_floor_bps)} vs 0.75×fair(σ_low) = ${round(0.75 * fairLow)}`,
        },
  );

  return results;
}

/**
 * `floor / fair` across the measured σ range — D-62's margin, printed per instance.
 *
 * Not a gate. It is the number the Phase-2 clearing gate depends on, and §1b records that at
 * 0.52–0.55 today a threshold of 0.5 would have been passed by an auction that never left the
 * floor. Printing it is what stops that being discovered after the fact.
 */
export function floorOverFair(
  params: CoherenceParams,
  sigma: SigmaRange,
): Array<{ days: number; sigma: number; fair: number; ratio: number }> {
  return sigma.windows.map(({ days, sigma: s }) => {
    const fair = fairValueBps(params.strike_bps_otm, params.epoch_duration, s);
    return { days, sigma: s, fair, ratio: fair > 0 ? params.premium_floor_bps / fair : Infinity };
  });
}

/**
 * The measured cost of one `close_round`, in stroops.
 *
 * Taken from testnet on 2026-08-31: instance C's round 1 closed in ledger 4 430 159
 * (`8829215a…`) for 228 075, and instance E's round 2 an hour earlier for 230 309. The **lower**
 * of the two is used, because a warning that overstates the fee would fire on instances that are
 * in fact fine.
 *
 * **A constant here where σ is an input, and the difference is deliberate.** σ varies by a factor
 * of two across the windows this script measures, which is why D-53 forbids a default for it. A
 * Soroban resource fee for one fixed call path does not vary that way, and the alternative —
 * making every operator supply it — would mean the margin below is usually not computed at all,
 * which is the worst of the three outcomes. `--settle-fee` overrides it and the figure used is
 * printed, so a stale constant is visible rather than load-bearing.
 */
export const SETTLE_FEE_STROOPS = 228_075;

/**
 * The two fields the bounty margin reads.
 *
 * Absent from `CoherenceParams` because no *gate* reads them, and widening that type would say
 * they were gated. `Partial` at the call site for the same reason: a caller that supplies only the
 * five gated fields gets no margin and is told so, rather than getting one computed off a default.
 */
export interface BountyParams {
  readonly min_fill: number;
  readonly settle_bounty_bps: number;
}

/**
 * Does closing a round on this instance pay for itself? — D-86, and **not a gate**.
 *
 * The bounty is `settle_bounty_bps` of the premium, so whether a third party closes a round
 * promptly depends on the premium, which depends on the fill. The binding case is therefore not
 * the round that happens to run but the **worst one the parameters allow**: a partial fill of
 * exactly `min_fill`, cleared at `premium_floor_bps`.
 *
 * **A refusal here would be wrong twice.** It would block exactly the small demonstration
 * instances this project exists to run — no shipped set is near the line — and it would claim a
 * safety property the bounty does not carry. When nobody closes a round, `settle.rs` step 2 closes
 * it on the clock at `expiry + unresolved_after` with byte-identical accounting, and every case
 * where *money* turns on the timing already has a party whose stake dwarfs the fee: an
 * in-the-money buyer loses the whole payout by waiting, and a refund after a dead oracle is the
 * bidder's to collect. What an unprofitable bounty costs is **latency** — idle collateral and
 * blocked withdrawals, bounded by a constant already in the parameters. So this warns, and the
 * sentence it prints is the useful part.
 */
export function bountyMargin(
  params: CoherenceParams & Partial<BountyParams>,
  settleFeeStroops: number = SETTLE_FEE_STROOPS,
): {
  minFill: number;
  floorBps: number;
  premium: number;
  bounty: number;
  fee: number;
  ratio: number;
  pays: boolean;
} | null {
  const minFill = params.min_fill;
  const bountyBps = params.settle_bounty_bps;
  if (minFill === undefined || bountyBps === undefined) return null;
  // Floored twice, exactly as the contract floors them.
  const premium = Math.floor((minFill * params.premium_floor_bps) / BPS);
  const bounty = Math.floor((premium * bountyBps) / BPS);
  return {
    // Carried rather than re-read from `params` at the call site: `InstanceCheck.params` is typed
    // as the gated five, and reaching past that type to print a sixth field is how a printed line
    // and the number it describes drift apart.
    minFill,
    floorBps: params.premium_floor_bps,
    premium,
    bounty,
    fee: settleFeeStroops,
    ratio: settleFeeStroops > 0 ? bounty / settleFeeStroops : Infinity,
    pays: bounty >= settleFeeStroops,
  };
}

// --------------------------------------------------------------------------------------------
// The series
// --------------------------------------------------------------------------------------------

export interface PriceSeries {
  readonly asset: string;
  readonly cadence: "daily";
  readonly source: string;
  readonly measuredAt: string;
  readonly closes: readonly number[];
}

/**
 * Load a committed price series and refuse anything that is not one.
 *
 * The series is an **input**, never a constant compiled into this file — D-53's whole finding was
 * that a hard-coded volatility band was wrong by a factor of two and took every parameter derived
 * from it down with it. Keeping it as a file also makes the measurement auditable: a reviewer can
 * see which closes produced which σ.
 */
export function loadSeries(path: string): PriceSeries {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new ParamError(`${path} is not a JSON object`);
  }
  const s = parsed as PriceSeries;
  if (s.cadence !== "daily") {
    throw new ParamError(
      `${path} declares cadence "${String(s.cadence)}"; the annualization here assumes daily closes ` +
        `(§1b measured from daily closes), so a different cadence is a refusal rather than a rescaling`,
    );
  }
  if (!Array.isArray(s.closes) || s.closes.length < 4) {
    throw new ParamError(`${path} carries too few closes to measure any window`);
  }
  return s;
}

/** The 30/60/90-day windows §1b names, from one series. */
export function sigmaRange(series: PriceSeries, windows: readonly number[] = [30, 60, 90]): SigmaRange {
  const measured = windows
    .filter((days) => series.closes.length >= days + 1)
    .map((days) => ({ days, sigma: realizedVolatility(series.closes, days) }));
  if (measured.length === 0) {
    throw new ParamError(
      `the series has ${series.closes.length} closes, too few for any of the ${windows.join("/")}-day windows`,
    );
  }
  const sigmas = measured.map((m) => m.sigma);
  return { low: Math.min(...sigmas), high: Math.max(...sigmas), windows: measured };
}

// --------------------------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------------------------

export interface InstanceCheck {
  readonly suffix: string;
  readonly params: CoherenceParams;
  readonly results: GateResult[];
  readonly margins: ReturnType<typeof floorOverFair>;
  /** D-86's latency margin. `null` when the caller supplied only the five gated fields. */
  readonly bounty: ReturnType<typeof bountyMargin>;
  readonly passed: boolean;
}

/**
 * Check every instance and refuse the **whole set** if any one fails (D-57).
 *
 * A partially-deployable experiment is how instances C and D reached review while being
 * un-deployable, so the verdict is over the set rather than per instance. That is why this returns
 * every instance's result and a single overall boolean rather than throwing on the first failure —
 * an operator who has to fix five parameter sets one deploy at a time will stop reading.
 */
export function checkSet(
  instances: ReadonlyArray<{ suffix: string; params: CoherenceParams & Partial<BountyParams> }>,
  sigma: SigmaRange,
  options: { fastTest?: boolean; settleFeeStroops?: number } = {},
): { instances: InstanceCheck[]; passed: boolean } {
  const checked = instances.map(({ suffix, params }) => {
    const results = checkGates(params, sigma, options);
    return {
      suffix,
      params,
      results,
      margins: floorOverFair(params, sigma),
      bounty: bountyMargin(params, options.settleFeeStroops),
      // D-86's margin is deliberately absent from this: it warns and never refuses.
      passed: results.every((r) => r.passed),
    };
  });
  return { instances: checked, passed: checked.every((i) => i.passed) };
}

function render(check: InstanceCheck, sigma: SigmaRange): string[] {
  const lines: string[] = [];
  lines.push(`\ninstance ${check.suffix}  —  ${check.passed ? "PASS" : "REFUSED"}`);
  lines.push(
    `  epoch ${check.params.epoch_duration}s  otm ${check.params.strike_bps_otm}bps  ` +
      `band [${check.params.premium_floor_bps}, ${check.params.premium_start_bps}]  ` +
      `deviation ${check.params.max_deviation_bps}bps`,
  );
  for (const r of check.results) {
    const mark = r.exempt ? "  --  " : r.passed ? "  ok  " : " FAIL ";
    lines.push(`  [${mark}] gate ${r.gate}  ${r.name}`);
    lines.push(`            ${r.detail}`);
  }
  // D-62's margin, printed whether or not the gates passed.
  lines.push("  floor / fair across the measured range (D-62 — the Phase-2 clearing margin):");
  for (const m of check.margins) {
    lines.push(
      `    ${String(m.days).padStart(3)}d  σ ${(m.sigma * 100).toFixed(1)}%  ` +
        `fair ${m.fair.toFixed(1)} bps  floor/fair ${m.ratio.toFixed(3)}`,
    );
  }
  // D-86's margin, printed whether or not the gates passed, and never able to change the verdict.
  const stroops = (n: number): string => (n / 10_000_000).toFixed(7);
  if (check.bounty === null) {
    lines.push(
      "  settle bounty margin (D-86): not computed — min_fill and settle_bounty_bps were not supplied.",
    );
  } else {
    const b = check.bounty;
    lines.push("  settle bounty at the worst allowed fill (D-86 — latency, not safety):");
    lines.push(
      `    min_fill ${stroops(b.minFill)} at floor ${b.floorBps} bps  ` +
        `→ premium ${stroops(b.premium)}  bounty ${stroops(b.bounty)}  fee ${stroops(b.fee)}`,
    );
    lines.push(
      b.pays
        ? `    covers ${(b.ratio * 100).toFixed(0)} % of the fee — closing a round here pays for itself.`
        : // Floored, not rounded: at 99.96 % a rounded figure prints "100.0 %" beside a sentence
          // saying it does not cover the fee, which reads as a contradiction of itself.
          `    covers ${(Math.floor(b.ratio * 1000) / 10).toFixed(1)} % of the fee — settling costs more than it pays, so\n` +
            `    rounds on this instance will often close on settle.rs's unresolved_after clock rather\n` +
            `    than promptly. That is a latency cost, not a safety one.`,
    );
  }
  const _ = sigma;
  return lines;
}

// =================================================================================================
// The instance set — `scripts/instances.json`, and the whole sixteen fields rather than the six
// this gate reads
// =================================================================================================

/**
 * Every field of `EpochParams` (`types.rs`), with the width the constructor takes it at.
 *
 * **Sixteen, and this gate judges six of them.** The other ten still have to be committed
 * somewhere machine-readable, because `deploy.ts` step 4 passes all sixteen and step 5 compares
 * what landed against what was gated — and a constructor argument that exists only in a markdown
 * table is one nobody diffs. 02-CONTRACT-SPEC §1 is their single home; this list is the shape,
 * never the values.
 *
 * The widths are here because `min_fill` and `min_deposit` are `i128` and everything else is a
 * `u64` or `u32`. A number that has to survive the round trip through JSON and back out of a
 * contract read is safer carried as the type the contract uses it at.
 */
export const EPOCH_PARAM_FIELDS: Readonly<Record<string, "u32" | "u64" | "i128">> = {
  epoch_duration: "u64",
  auction_duration: "u64",
  min_idle_gap: "u64",
  strike_bps_otm: "u32",
  premium_start_bps: "u32",
  premium_floor_bps: "u32",
  twap_window: "u64",
  guard_window: "u64",
  max_staleness: "u64",
  max_deviation_bps: "u32",
  oracle_dead_after: "u64",
  settle_grace: "u64",
  unresolved_after: "u64",
  min_fill: "i128",
  min_deposit: "i128",
  settle_bounty_bps: "u32",
};

/**
 * All sixteen fields, typed so that the six this gate reads are *statically* present.
 *
 * The intersection is not decoration. `checkGates` takes a `CoherenceParams`, and a plain
 * `Record<string, number>` satisfies it only by accident of having the right keys at run time —
 * which `--experimental-strip-types` would never notice, because it erases annotations without
 * checking them (06-TEST-PLAN §8). `tsc` is what notices, and this is the type that lets it.
 */
export type FullEpochParams = CoherenceParams & Readonly<Record<string, number>>;

export interface InstanceSpec {
  /** `-A` … `-E`. `symbol()` is `aXLM` plus this (D-52). */
  readonly suffix: string;
  readonly note?: string;
  /** All sixteen, shared values merged with this instance's overrides. */
  readonly params: FullEpochParams;
  readonly depositCap: number;
  /**
   * `03-STORAGE-TTL.md` §2's tuned values, and constructor arguments in their own right.
   *
   * They are committed here rather than chosen by `deploy.ts` because §2 step 3b's job is to
   * assert the *intended* `rent_extend_to` against the live `max_ttl` — which presupposes an
   * intention that somebody reviewed. A number the deploy script picks is one no reviewer saw.
   */
  readonly rentThreshold: number;
  readonly rentExtendTo: number;
}

/**
 * Read `instances.json` — either a bare array of instances, or `{ shared, instances }`.
 *
 * **The array form is kept working on purpose.** It is what the file was when DEV2 wrote it and
 * what the committed reproduction command in its own note exercises; breaking it would invalidate
 * a recorded result to gain nothing. The object form adds the two things the array cannot carry:
 * a `shared` block holding the ten fields identical across all five instances (02-CONTRACT-SPEC
 * §1: *"every other `EpochParams` field is identical across all five"*) plus `deposit_cap`, which
 * §1 also states is the same on every instance, and a `_why` so the
 * reasoning sits with the data instead of in a document the code repository never sees — which is
 * what DEV2's note on instance A asked for.
 *
 * **A missing or unknown field is a refusal, not a default.** Defaulting is how a typo'd key
 * becomes a silently different vault: `unresolved_afer` would leave `unresolved_after` at whatever
 * the code chose, the gate would pass, and the deployed instance would differ from the reviewed
 * one in a field nobody looked at. There is no default anywhere in this loader.
 */
export function loadInstances(path: string): InstanceSpec[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  let shared: Record<string, unknown> = {};
  let rows: unknown[];
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (isObject(raw) && Array.isArray(raw["instances"])) {
    rows = raw["instances"];
    const sh = raw["shared"];
    if (sh !== undefined) {
      if (!isObject(sh)) throw new ParamError(`${path}: "shared" is not an object.`);
      shared = sh;
    }
  } else {
    throw new ParamError(`${path} is neither an array of instances nor an object with an "instances" array.`);
  }
  if (rows.length === 0) {
    throw new ParamError(`${path} carries no instances. An empty set is not a set that passes.`);
  }

  const known = Object.keys(EPOCH_PARAM_FIELDS);
  return rows.map((row, index) => {
    if (!isObject(row)) throw new ParamError(`${path}: instance ${index} is not an object.`);
    const suffix = row["suffix"];
    if (typeof suffix !== "string") {
      throw new ParamError(`${path}: instance ${index} has no string "suffix".`);
    }
    // `token_suffix.len() <= 4` is a constructor rule (`vault.rs`), and a suffix that the
    // constructor rejects fails the deploy at step 4 rather than here — which is a wasted upload.
    if (suffix.length > 4) {
      throw new ParamError(
        `${path}: suffix "${suffix}" is ${suffix.length} bytes; the constructor caps token_suffix ` +
          `at 4 and would reject it.`,
      );
    }
    const own = row["params"];
    if (!isObject(own)) throw new ParamError(`${path}: instance "${suffix}" has no "params" object.`);

    const merged: Record<string, number> = {};
    const seen = new Set<string>();
    for (const source of [shared, own]) {
      for (const [key, value] of Object.entries(source)) {
        // `deposit_cap` is a constructor argument in its own right, not a field of `EpochParams`,
        // and it is identical across all five (02-CONTRACT-SPEC §1) — so it is allowed to sit in
        // `shared` beside the parameters without being merged into them.
        if (key === "deposit_cap" || key === "rent_threshold" || key === "rent_extend_to") continue;
        if (!Object.prototype.hasOwnProperty.call(EPOCH_PARAM_FIELDS, key)) {
          throw new ParamError(
            `${path}: instance "${suffix}" carries "${key}", which is not a field of EpochParams. ` +
              `The sixteen are: ${known.join(", ")}. A key nobody recognises is a typo that would ` +
              `otherwise leave the real field at a value nobody chose.`,
          );
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ParamError(`${path}: instance "${suffix}" field "${key}" is not a finite number.`);
        }
        merged[key] = value;
        seen.add(key);
      }
    }
    const missing = known.filter((k) => !seen.has(k));
    if (missing.length > 0) {
      throw new ParamError(
        `${path}: instance "${suffix}" is missing ${missing.join(", ")}. ` +
          `deploy.ts step 4 passes all sixteen fields and step 5 compares what landed against what ` +
          `this gate judged; a field absent here is one the gate never saw and nobody reviewed. ` +
          `Put values identical across all five in a "shared" block.`,
      );
    }

    const capRaw = row["deposit_cap"] ?? shared["deposit_cap"];
    if (typeof capRaw !== "number" || !Number.isFinite(capRaw) || capRaw < 0) {
      throw new ParamError(`${path}: instance "${suffix}" has no non-negative numeric "deposit_cap".`);
    }
    if (capRaw !== 0 && capRaw < merged["min_deposit"]!) {
      throw new ParamError(
        `${path}: instance "${suffix}" has deposit_cap ${capRaw} below min_deposit ` +
          `${merged["min_deposit"]!}. validate_params refuses that pair — it is a vault no deposit ` +
          `can enter.`,
      );
    }

    // The rent pair: `03-STORAGE-TTL.md` §2, and `validate_rent`'s `0 < threshold < extend_to`.
    // Refused here rather than at the constructor, because reaching the constructor means a wasm
    // upload has already been spent on a set that cannot deploy.
    const rentOf = (name: string): number => {
      const v = row[name] ?? shared[name];
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ParamError(
          `${path}: instance "${suffix}" has no positive integer "${name}". 03-STORAGE-TTL §2 tunes ` +
            `the pair and deploy.ts step 3b asserts the intended value against the live max_ttl — ` +
            `which presupposes an intention somebody reviewed, not a number a script picked.`,
        );
      }
      return v;
    };
    const rentThreshold = rentOf("rent_threshold");
    const rentExtendTo = rentOf("rent_extend_to");
    if (rentThreshold >= rentExtendTo) {
      throw new ParamError(
        `${path}: instance "${suffix}" has rent_threshold ${rentThreshold} >= rent_extend_to ` +
          `${rentExtendTo}. validate_rent requires 0 < threshold < extend_to.`,
      );
    }

    const note = row["note"];
    // The `missing` check immediately above is what makes this narrowing true: every one of the
    // sixteen names is present and numeric, so the six `CoherenceParams` requires are present.
    // Asserting it here rather than proving it to the compiler keeps the guarantee in one place —
    // the refusal — instead of splitting it between a refusal and a shape the refusal implies.
    const spec: InstanceSpec = {
      suffix,
      params: merged as FullEpochParams,
      depositCap: capRaw,
      rentThreshold,
      rentExtendTo,
    };
    return typeof note === "string" ? { ...spec, note } : spec;
  });
}

export function main(argv: readonly string[]): number {
  const args = new Map<string, string>();
  let fastTest = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--fast-test") fastTest = true;
    else if (a.startsWith("--")) {
      args.set(a.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }

  const seriesPath = args.get("series");
  const paramsPath = args.get("params");
  if (seriesPath === undefined || paramsPath === undefined) {
    console.error(
      "usage: check-params.ts --series <price-series.json> --params <instances.json> [--fast-test]\n" +
        "\n" +
        "  --series  daily closes for the underlying. σ is MEASURED from this and never assumed\n" +
        "            (D-53) — a default baked into the script is the defect the gate exists to stop.\n" +
        "  --params  one instance or an array of them, each { suffix, params }.\n" +
        "  --fast-test  exempts gates 1, 2, 4 and 5 — never gate 3 (§1b).\n" +
        "  --settle-fee <stroops>  overrides the measured close_round fee D-86's margin is judged\n" +
        "            against. Defaults to " +
        String(SETTLE_FEE_STROOPS) +
        ", measured on 2026-08-31. Warns; never refuses.",
    );
    return 2;
  }

  const series = loadSeries(seriesPath);
  const sigma = sigmaRange(series);
  const instances = loadInstances(paramsPath);

  console.log(`series: ${series.asset} from ${series.source}, measured ${series.measuredAt}`);
  console.log(
    `measured σ: ${sigma.windows.map((w) => `${w.days}d ${(w.sigma * 100).toFixed(1)}%`).join(", ")}` +
      `  →  range [${(sigma.low * 100).toFixed(1)}%, ${(sigma.high * 100).toFixed(1)}%]`,
  );
  if (fastTest) {
    console.log(
      "\n--fast-test: gates 1, 2, 4 and 5 exempt; gate 3 still enforced.\n" +
        "  The deployment record is stamped ECONOMICALLY MEANINGLESS — mechanism only, never\n" +
        "  demand evidence — and can never satisfy Phase 6b or feed the stop gate.",
    );
  }

  const feeRaw = args.get("settle-fee");
  const settleFeeStroops = feeRaw === undefined ? SETTLE_FEE_STROOPS : Number(feeRaw);
  if (!Number.isFinite(settleFeeStroops) || settleFeeStroops < 0) {
    console.error(`--settle-fee must be a non-negative number of stroops, got ${feeRaw ?? ""}`);
    return 2;
  }

  const { instances: checked, passed } = checkSet(instances, sigma, {
    fastTest,
    settleFeeStroops,
  });
  for (const c of checked) {
    for (const line of render(c, sigma)) console.log(line);
  }

  if (!passed) {
    const failed = checked.filter((c) => !c.passed).map((c) => c.suffix);
    console.error(
      `\nREFUSED. Instances ${failed.join(", ")} failed a coherence gate, so the WHOLE SET is\n` +
        `refused (D-57). A partially-deployable experiment is how instances C and D reached review\n` +
        `while being un-deployable.`,
    );
    return 1;
  }
  console.log(`\nall ${checked.length} instance(s) pass every applicable gate.`);
  return 0;
}

if (process.argv[1]?.endsWith("check-params.ts")) {
  process.exit(main(process.argv.slice(2)));
}
