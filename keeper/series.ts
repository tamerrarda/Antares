/**
 * The daily close series `check-params.ts` measures σ from — fetched on a schedule instead of by
 * hand.
 *
 * This closes a loop rather than adding a feature. DEV3's `check-params.ts` refused all five shipped
 * instances on its first real run, correctly: one large day on 2026-08-19 took 30-day σ from 33.7 %
 * to about 50 %, and gate 2 wanted a floor near 80 bps against a shipped 40. **The instance table
 * has been ruled illustrative and the deploy-time gate now governs (D-79) — but nothing in the
 * repository produced a price series on a schedule**, so running the check meant fetching 91 closes
 * by hand.
 *
 * The figures are given as approximations on purpose: the ones first published — **+10.85 %** and
 * **51.1 %** — came from a candle that had not closed yet. See `dropIncomplete` below. The refusal
 * they produced was right; the numbers were provisional, and the exact ones are +9.94 % and 49.01 %.
 *
 * # This is not σ_realized, and the two must not be conflated
 *
 * | | this file | `sigma.ts` |
 * |---|---|---|
 * | input | **daily closes**, one source | **5-minute ticks of the settling feed** |
 * | window | 30 / 60 / 90 days | one epoch, `[open_epoch, expiry]` |
 * | form | sample, `√365` | population, `√(365·24·12)` |
 * | read | once, at deploy | continuously, as the epoch runs |
 * | judges | an **input** — is this parameter set coherent | an **outcome** — did the auction clear near fair value |
 *
 * Same letter, different estimators, different jobs (D-79 §1). A number from one is not evidence
 * about the other, and the only reason they sit in one package is that one process has to produce
 * both.
 *
 * # Provenance is part of the artefact
 *
 * The committed file carries `source`, `measuredAt`, `firstClose` and `lastClose` alongside the
 * closes, and `check-params.ts` refuses a cadence it did not expect rather than rescaling it. A
 * series without its provenance is a column of numbers nobody can re-derive, which is the same
 * failure the σ evidence record exists to avoid.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class SeriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeriesError";
  }
}

/** The shape `check-params.ts::loadSeries` validates. Field names are its, not ours to rename. */
export interface PriceSeries {
  readonly _what: readonly string[];
  readonly asset: string;
  readonly cadence: "daily";
  readonly source: string;
  readonly measuredAt: string;
  readonly firstClose: string;
  readonly lastClose: string;
  readonly closes: readonly number[];
}

/** One kline row, reduced to what a close series needs. */
export interface Kline {
  /** Open time, milliseconds — Binance's own field 0. */
  readonly openTimeMs: number;
  /** Close time, milliseconds — field 6. Carried **only** to tell a finished candle from a live one. */
  readonly closeTimeMs: number;
  readonly close: number;
}

export const DEFAULT_SYMBOL = "XLMUSDT";

/**
 * 92, not 91, because the newest row is always the day in progress and is dropped.
 *
 * Found the hard way (2026-08-20). The committed series was fetched at 21:58 UTC on 2026-08-19 with
 * `limit=91`, so its last row was **that day's unfinished candle**: it recorded 0.1717 as the
 * 19 August close, and the real close — once the day ended — was **0.1703**. Every one of the other
 * 89 overlapping days matched to the last digit, so the provisional row was the only difference and
 * it was the newest one, every time.
 */
export const DEFAULT_LIMIT = 92;

/**
 * The narrowest useful window.
 *
 * `check-params.ts` measures 30-, 60- and 90-day windows, and an `n`-day window needs `n + 1`
 * closes. 91 is therefore the minimum that answers all three, and it is what DEV3 committed.
 */
export const MIN_CLOSES = 91;

const WHAT = [
  "Daily XLMUSDT closes, the input to check-params.ts's realized-volatility measurement.",
  "",
  "NOT σ_realized. That estimator is 5-minute log returns of the Reflector feed the round settles",
  "against, population form, over one epoch (D-67) — a different quantity with a different job, and",
  "the keeper produces both. This one judges whether a parameter set is coherent at deploy; that one",
  "judges whether an auction cleared near fair value. A number from one is not evidence about the",
  "other (D-79 §1).",
  "",
  "Written by `pnpm --filter @antares/keeper series`. Before that it was fetched by hand, which is",
  "how check-params.ts came to refuse all five instances on a σ nobody was sampling — and this file",
  "claimed to be written *on a schedule* until 2026-08-24, when the schedule turned out not to",
  "exist and the module to have no caller but its own test. A stale σ refuses a coherent set and",
  "passes an incoherent one, so the runner is the fix and the claim was the defect.",
];

/**
 * Shape rows into the committed artefact. Pure, so the validation is testable without a network.
 *
 * Refuses rather than truncates or pads: a short series is a failed fetch, and writing one over a
 * good file would replace a measurement with an artefact of the outage that produced it.
 */
export function toSeries(
  rows: readonly Kline[],
  symbol: string,
  source: string,
  measuredAt: string,
): PriceSeries {
  if (rows.length < MIN_CLOSES) {
    throw new SeriesError(
      `${rows.length} closes is fewer than the ${MIN_CLOSES} a 90-day window needs; refusing to ` +
        `write a series that cannot answer the widest gate rather than writing a short one.`,
    );
  }
  const sorted = [...rows].sort((a, b) => a.openTimeMs - b.openTimeMs);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.openTimeMs === sorted[i - 1]!.openTimeMs) {
      throw new SeriesError(`duplicate day at ${new Date(sorted[i]!.openTimeMs).toISOString()}`);
    }
  }
  for (const r of sorted) {
    if (!Number.isFinite(r.close) || r.close <= 0) {
      throw new SeriesError(
        `a non-positive close is not a price: ${r.close} at ` +
          `${new Date(r.openTimeMs).toISOString()}. check-params.ts refuses these too, and a ` +
          `series that reaches it malformed has already wasted the run.`,
      );
    }
  }
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    _what: WHAT,
    asset: symbol,
    cadence: "daily",
    source,
    measuredAt,
    firstClose: day(sorted[0]!.openTimeMs),
    lastClose: day(sorted[sorted.length - 1]!.openTimeMs),
    closes: sorted.map((r) => r.close),
  };
}

/**
 * Drop the candle that has not finished yet.
 *
 * **A close is not a close until the day ends.** A daily series fetched at any hour before midnight
 * UTC has a last row whose "close" is just the last trade so far, and writing it as a close records
 * a provisional number in a committed artefact — where everything downstream then inherits it. It
 * did: the 30-day σ that made `check-params.ts` refuse all five instances was **51.11 %** computed
 * from the provisional 0.1717, and **49.01 %** from the real 0.1703. The refusal survives the
 * correction; the number does not.
 *
 * Pure, and takes `now` rather than reading a clock, so the boundary is testable.
 */
export function dropIncomplete(rows: readonly Kline[], now: number): Kline[] {
  return rows.filter((r) => r.closeTimeMs <= now);
}

/**
 * Fetch daily klines, **complete ones only**.
 *
 * The endpoint is the one the committed series names, kept identical so the `source` line stays a
 * true description of how the file was produced rather than a description of how it used to be.
 */
export async function fetchKlines(symbol = DEFAULT_SYMBOL, limit = DEFAULT_LIMIT): Promise<Kline[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new SeriesError(`klines fetch failed with ${res.status}; the previous series is left alone`);
  }
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) throw new SeriesError("klines did not return an array");
  const rows = raw.map((row): Kline => {
    const r = row as unknown[];
    return { openTimeMs: Number(r[0]), closeTimeMs: Number(r[6]), close: Number(r[4]) };
  });
  return dropIncomplete(rows, Date.now());
}

export function sourceLine(symbol: string, limit: number): string {
  return `Binance spot klines, GET /api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
}

/** Write the artefact. Two-space JSON with a trailing newline, so it survives `prettier --check`. */
export function writeSeries(path: string, series: PriceSeries): void {
  writeFileSync(path, `${JSON.stringify(series, null, 2)}\n`);
}

// =================================================================================================
// Runner
// =================================================================================================

/**
 * Refresh the committed series.
 *
 * A separate command rather than a step inside the keeper's loop, and deliberately: the keeper runs
 * continuously against a vault, while this reads a public exchange once and writes a file the
 * *deploy* consumes. Folding it into the loop would make a deploy-time input depend on a process
 * that has no reason to be running.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const i = argv.indexOf("--out");
  // Resolved from this module rather than from the working directory: the committed artefact has
  // one home, and a relative default would write a second copy wherever the command was typed.
  const out =
    i === -1
      ? fileURLToPath(new URL("../deployments/xlm-price-series.json", import.meta.url))
      : (argv[i + 1] ?? "");
  if (out === "") {
    process.stderr.write("usage: series.ts [--out <path>]\n");
    return 2;
  }
  const rows = dropIncomplete(await fetchKlines(), Date.now());
  const series = toSeries(
    rows,
    DEFAULT_SYMBOL,
    sourceLine(DEFAULT_SYMBOL, DEFAULT_LIMIT),
    new Date().toISOString(),
  );
  writeSeries(out, series);
  process.stdout.write(
    `${series.closes.length} daily closes, ${series.firstClose} → ${series.lastClose}, written to ${out}\n`,
  );
  return 0;
}

if (process.argv[1]?.endsWith("series.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
