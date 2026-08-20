/**
 * The evidence file, checked on the two properties that make it evidence rather than a log:
 * it appends, and it refuses to be rewritten.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendEpoch,
  evidencePath,
  EvidenceError,
  NO_GAPS,
  sigmaEvidence,
  type EpochEvidence,
} from "../evidence.ts";
import { realizedSigma, type Sample } from "../sigma.ts";

const NET = "testnet";
const CLOSED = 1_787_178_300; // 2026-08-19T22:25:00Z

const epoch = (round: number, over: Partial<EpochEvidence> = {}): EpochEvidence => ({
  vault: "CVAULTA",
  round,
  outcome: "Settled",
  openedAt: CLOSED - 604_800,
  expiry: CLOSED - 60,
  closedAt: CLOSED,
  txHashes: ["abc123"],
  events: [{ type: "settled", round }],
  fills: [{ bidder: "GBIDDER", notional: "5000000000", premium: "200000000", txHash: "def456" }],
  sigmaRealized: null,
  historyGaps: NO_GAPS,
  ...over,
});

const root = () => mkdtempSync(join(tmpdir(), "antares-evidence-"));

test("the filename is the UTC date and the network, not the machine's date", () => {
  const p = evidencePath("/e", NET, CLOSED);
  assert.equal(p, "/e/2026-08-19-testnet.json");
  // 23:59:59Z and 00:00:01Z the next day must land in different files whatever the local zone is.
  assert.equal(
    evidencePath("/e", NET, Date.UTC(2026, 7, 19, 23, 59, 59) / 1000),
    "/e/2026-08-19-testnet.json",
  );
  assert.equal(evidencePath("/e", NET, Date.UTC(2026, 7, 20, 0, 0, 1) / 1000), "/e/2026-08-20-testnet.json");
});

test("epochs append into one file per day rather than replacing it", () => {
  const r = root();
  const p = appendEpoch(r, NET, epoch(1));
  appendEpoch(r, NET, epoch(2));
  const file = JSON.parse(readFileSync(p, "utf8")) as { epochs: EpochEvidence[] };
  assert.equal(file.epochs.length, 2);
  assert.deepEqual(
    file.epochs.map((e) => e.round),
    [1, 2],
  );
});

test("rewriting a closed epoch is refused, even with a different outcome", () => {
  const r = root();
  appendEpoch(r, NET, epoch(7, { outcome: "Settled" }));
  assert.throws(
    () => appendEpoch(r, NET, epoch(7, { outcome: "Voided" })),
    (e: unknown) => e instanceof EvidenceError && /already recorded/.test(e.message),
  );
  // And the first record is intact — a refused write must not have half-applied.
  const file = JSON.parse(readFileSync(evidencePath(r, NET, CLOSED), "utf8")) as { epochs: EpochEvidence[] };
  assert.equal(file.epochs.length, 1);
  assert.equal(file.epochs[0]!.outcome, "Settled");
});

test("the same round number on a different vault is a different epoch", () => {
  const r = root();
  appendEpoch(r, NET, epoch(1, { vault: "CVAULTA" }));
  appendEpoch(r, NET, epoch(1, { vault: "CVAULTB" }));
  const file = JSON.parse(readFileSync(evidencePath(r, NET, CLOSED), "utf8")) as { epochs: EpochEvidence[] };
  assert.equal(file.epochs.length, 2, "five instances run from one process (D-47); the key is the pair");
});

test("the fill index survives the round trip, amounts as strings", () => {
  const r = root();
  const p = appendEpoch(r, NET, epoch(3));
  const file = JSON.parse(readFileSync(p, "utf8")) as { epochs: EpochEvidence[] };
  const fill = file.epochs[0]!.fills[0]!;
  assert.equal(fill.bidder, "GBIDDER");
  // i128 stroops exceed Number.MAX_SAFE_INTEGER at scale, so they are carried as strings. A number
  // here would round silently and the Claims page would owe somebody the wrong amount.
  assert.equal(typeof fill.notional, "string");
  assert.equal(fill.notional, "5000000000");
});

test("σ is published with the series it was computed from, not instead of it", () => {
  const samples: Sample[] = Array.from({ length: 10 }, (_, i) => ({
    ts: 1_787_000_000 + i * 300,
    price: 1 + (i % 2) * 0.01,
  }));
  const result = realizedSigma(samples, 300);
  const ev = sigmaEvidence(result, samples, { feedId: "CFEED", resolution: 300, decimals: 14 });

  const r = root();
  const p = appendEpoch(r, NET, epoch(4, { sigmaRealized: ev }));
  const file = JSON.parse(readFileSync(p, "utf8")) as { epochs: EpochEvidence[] };
  const back = file.epochs[0]!.sigmaRealized!;

  assert.equal(back.samples.length, 10, "the series is the evidence; a summary cannot be rechecked");
  assert.equal(back.resolution, 300);
  // Recomputing from the published series must reproduce the published σ exactly — that is the
  // property D-67 asks for, so it is asserted rather than described.
  assert.equal(realizedSigma(back.samples, back.resolution).sigma, back.sigma);
});

test("an absent series is recorded as null rather than omitted", () => {
  const r = root();
  const p = appendEpoch(r, NET, epoch(5, { sigmaRealized: null }));
  const raw = readFileSync(p, "utf8");
  assert.ok(
    /"sigmaRealized": null/.test(raw),
    '"we did not sample" and "the field does not exist" are different facts, and only one is a gap',
  );
});

test("the file is written in the shape prettier --check accepts", () => {
  const r = root();
  const p = appendEpoch(r, NET, epoch(6));
  const raw = readFileSync(p, "utf8");
  assert.ok(raw.endsWith("\n"), "a committed JSON file without a trailing newline fails the TS gate");
  assert.equal(raw, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
});
