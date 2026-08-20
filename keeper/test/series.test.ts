/**
 * The daily series, checked on the property that matters: it refuses rather than degrades.
 *
 * A short or malformed fetch that overwrites a good file replaces a measurement with an artefact of
 * the outage that produced it — and `check-params.ts` would then run against it and report a σ
 * nobody could account for.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  dropIncomplete,
  MIN_CLOSES,
  SeriesError,
  sourceLine,
  toSeries,
  writeSeries,
  type Kline,
} from "../series.ts";

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 4, 21);

const rows = (n: number, price = (i: number) => 0.15 + i * 0.0001): Kline[] =>
  Array.from({ length: n }, (_, i) => ({
    openTimeMs: START + i * DAY_MS,
    closeTimeMs: START + (i + 1) * DAY_MS - 1,
    close: price(i),
  }));

const shape = (r: readonly Kline[]) =>
  toSeries(r, "XLMUSDT", sourceLine("XLMUSDT", 91), "2026-08-20T00:00:00+00:00");

test("the shape is the one check-params.ts validates", () => {
  const s = shape(rows(MIN_CLOSES));
  assert.equal(s.cadence, "daily", "loadSeries refuses any other cadence rather than rescaling it");
  assert.equal(s.closes.length, MIN_CLOSES);
  assert.equal(s.asset, "XLMUSDT");
  assert.equal(s.firstClose, "2026-05-21");
  assert.match(s.source, /api\/v3\/klines/);
  assert.ok(s.measuredAt.length > 0);
});

test("a short series is refused, not padded or written", () => {
  // 91 closes is the minimum a 90-day window needs (n + 1). Fewer cannot answer the widest gate.
  assert.throws(() => shape(rows(MIN_CLOSES - 1)), SeriesError);
  assert.doesNotThrow(() => shape(rows(MIN_CLOSES)));
});

test("a non-positive close is refused here rather than at check-params", () => {
  const bad = rows(MIN_CLOSES);
  bad[40] = { openTimeMs: bad[40]!.openTimeMs, closeTimeMs: bad[40]!.closeTimeMs, close: 0 };
  assert.throws(() => shape(bad), SeriesError);
});

test("a duplicated day is refused", () => {
  const dup = rows(MIN_CLOSES);
  dup[10] = { openTimeMs: dup[9]!.openTimeMs, closeTimeMs: dup[9]!.closeTimeMs, close: 0.16 };
  assert.throws(() => shape(dup), SeriesError);
});

test("rows arrive sorted whatever order they came in", () => {
  const shuffled = [...rows(MIN_CLOSES)].reverse();
  const s = shape(shuffled);
  assert.equal(s.firstClose, "2026-05-21");
  for (let i = 1; i < s.closes.length; i++) {
    assert.ok(s.closes[i]! > s.closes[i - 1]!, "the generator is monotone; sorting must preserve it");
  }
});

test("the _what block says what this series is NOT", () => {
  // Same letter, different estimators: this judges an input at deploy, σ_realized judges an
  // outcome per round. The file has to say so, because both live in one package and the confusion
  // is the kind that produces a number nobody can account for.
  const s = shape(rows(MIN_CLOSES));
  const what = s._what.join(" ");
  assert.match(what, /NOT σ_realized/);
  assert.match(what, /D-67/);
});

test("the written file survives prettier --check", () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-series-"));
  const p = join(dir, "xlm-price-series.json");
  writeSeries(p, shape(rows(MIN_CLOSES)));
  const raw = readFileSync(p, "utf8");
  assert.ok(raw.endsWith("\n"));
  assert.equal(raw, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
});

test("the day in progress is dropped — a close is not a close until the day ends", () => {
  // The committed series was fetched at 21:58 UTC and recorded that day's unfinished candle as its
  // close: 0.1717 where the real close was 0.1703. Every other overlapping day matched exactly, so
  // the provisional row was the only difference and it was always the newest one.
  const r = rows(MIN_CLOSES + 1);
  const lastOpen = r[r.length - 1]!.openTimeMs;

  // Mid-candle: the newest row has not finished.
  const midday = lastOpen + DAY_MS / 2;
  assert.equal(dropIncomplete(r, midday).length, MIN_CLOSES, "the live candle must not survive");

  // After it closes, it counts.
  assert.equal(dropIncomplete(r, lastOpen + DAY_MS).length, MIN_CLOSES + 1);
});

test("the fetch limit leaves 91 complete closes after the live one is dropped", () => {
  // 92 rather than 91, because the newest row is always in progress. Fetching 91 and dropping one
  // would leave 90 — one short of what a 90-day window needs, and `toSeries` would refuse.
  const r = rows(92);
  const kept = dropIncomplete(r, r[r.length - 1]!.openTimeMs + DAY_MS / 2);
  assert.equal(kept.length, MIN_CLOSES);
  assert.doesNotThrow(() => shape(kept));
});
