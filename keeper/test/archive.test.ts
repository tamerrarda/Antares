/**
 * The archive, checked on what it does across passes and across a crash.
 *
 * 09-DEPLOYMENT §3 wants this running before the first public epoch, so the tests are about the
 * cases that only appear over time: a restart that replays a cursor, a round whose opening the
 * retention window already dropped, and a failure between the write and the clear.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DecodedEvent } from "@antares/common/events";

import { ArchiveError, EMPTY, fileStore, finalize, observe, type Working } from "../archive.ts";
import type { EpochEvidence } from "../evidence.ts";
import type { Located } from "../record.ts";

const VAULT = "CVAULT";
const NET = "testnet";
const CLOSED = 1_787_178_300;

const at = (event: DecodedEvent, txHash: string, ledger = 1): Located => ({ event, txHash, ledger });

const fill = (bidder: string, round = 7): DecodedEvent => ({
  name: "bid_filled",
  round,
  bidder,
  notional: 1_000_000_000n,
  premiumBps: 300,
  premium: 40_000_000n,
  notionalSoldAfter: 1_000_000_000n,
});

const settled = (round = 7): DecodedEvent => ({
  name: "settled",
  round,
  spot: 1n,
  strike: 1n,
  notionalSold: 1n,
  payoutTotal: 0n,
  premium: 1n,
  fee: 0n,
  pps: 1n,
  wclaims: 0n,
});

const root = () => mkdtempSync(join(tmpdir(), "antares-archive-"));

const meta = (round = 7) => ({
  vault: VAULT,
  network: NET,
  round,
  openedAt: CLOSED - 604_800,
  expiry: CLOSED - 60,
  closedAt: CLOSED,
  sigmaRealized: null,
});

// ---------------------------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------------------------

test("events are bucketed by round", () => {
  const s = observe(EMPTY, [at(fill("GA", 7), "t1"), at(fill("GB", 8), "t2")], "c1", 0, []);
  assert.deepEqual(Object.keys(s.rounds).sort(), ["7", "8"]);
  assert.equal(s.cursor, "c1");
});

test("a replayed pass does not double an entry in the fill index", () => {
  // A restart or a replayed cursor overlaps the previous pass. The fill index is what the Claims
  // page pays from, so a doubled fill is a double payment.
  const once = observe(EMPTY, [at(fill("GA"), "t1")], "c1", 0, []);
  const twice = observe(once, [at(fill("GA"), "t1")], "c2", 0, []);
  assert.equal(twice.rounds["7"]?.length, 1);
});

test("the same bidder filling twice in different transactions is two fills", () => {
  // Deduplication keys on the transaction, not the bidder — partial fills are the normal case.
  const s = observe(observe(EMPTY, [at(fill("GA"), "t1")], "c1", 0, []), [at(fill("GA"), "t2")], "c2", 0, []);
  assert.equal(s.rounds["7"]?.length, 2);
});

test("an event with no round is dropped rather than filed under a placeholder", () => {
  // `fee_claimed` belongs to a recipient, not a round. Filing it anywhere would put it in an
  // evidence record it is not part of.
  const s = observe(EMPTY, [at({ name: "fee_claimed", recipient: "GF", amount: 1n }, "t1")], "c1", 0, []);
  assert.deepEqual(Object.keys(s.rounds), []);
});

test("lost ledgers and skipped names accumulate across passes", () => {
  const a = observe(EMPTY, [], "c1", 100, ["deposited"]);
  const b = observe(a, [], "c2", 50, ["deposited", "withdraw_requested"]);
  assert.equal(b.missedLedgers, 150);
  assert.deepEqual([...b.skipped].sort(), ["deposited", "withdraw_requested"]);
});

test("a null cursor leaves the previous one in place", () => {
  // An empty page must not reset the resume point back to the start of the window.
  const a = observe(EMPTY, [at(fill("GA"), "t1")], "c1", 0, []);
  assert.equal(observe(a, [], null, 0, []).cursor, "c1");
});

// ---------------------------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------------------------

test("finalizing writes the record and clears only that round", () => {
  const r = root();
  const store = fileStore(r);
  store.save(
    VAULT,
    observe(EMPTY, [at(fill("GA", 7), "t1"), at(settled(7), "t2"), at(fill("GB", 8), "t3")], "c", 0, []),
  );

  const { path, state } = finalize(r, store, meta(7));
  const file = JSON.parse(readFileSync(path, "utf8")) as { epochs: EpochEvidence[] };
  assert.equal(file.epochs.length, 1);
  assert.equal(file.epochs[0]?.fills.length, 1);
  assert.deepEqual(Object.keys(state.rounds), ["8"], "round 8 is still running and must survive");
});

test("a round with nothing held is refused rather than written empty", () => {
  // Either the keeper was not running while the round ran, or it was already finalized. Writing an
  // empty record would claim a history that was never observed.
  const r = root();
  assert.throws(() => finalize(r, fileStore(r), meta(7)), ArchiveError);
});

test("history gaps reach the record, and `complete` says so", () => {
  const r = root();
  const store = fileStore(r);
  store.save(VAULT, observe(EMPTY, [at(settled(7), "t1")], "c", 4_000, ["deposited"]));

  const { path } = finalize(r, store, meta(7));
  const file = JSON.parse(readFileSync(path, "utf8")) as { epochs: EpochEvidence[] };
  const gaps = file.epochs[0]!.historyGaps;
  assert.equal(gaps.missedLedgers, 4_000);
  assert.deepEqual(gaps.skipped, ["deposited"]);
  assert.equal(
    gaps.complete,
    false,
    "a reader who cannot tell a partial record from a whole one has nothing",
  );
});

test("a complete record says complete", () => {
  const r = root();
  const store = fileStore(r);
  store.save(VAULT, observe(EMPTY, [at(settled(7), "t1")], "c", 0, []));
  const { path } = finalize(r, store, meta(7));
  const file = JSON.parse(readFileSync(path, "utf8")) as { epochs: EpochEvidence[] };
  assert.equal(file.epochs[0]!.historyGaps.complete, true);
});

test("a second finalize of the same round is refused, and the bucket was already cleared", () => {
  const r = root();
  const store = fileStore(r);
  store.save(VAULT, observe(EMPTY, [at(settled(7), "t1")], "c", 0, []));
  finalize(r, store, meta(7));
  // Cleared, so the second attempt fails on the bucket rather than on the duplicate — either way it
  // refuses, which is the behaviour you want from something whose output is evidence.
  assert.throws(() => finalize(r, store, meta(7)), ArchiveError);
});

test("a crash between the append and the clear leaves the bucket, and the retry is refused loudly", () => {
  // `appendEpoch` refuses a duplicate rather than overwriting, so the round cannot be written twice
  // even though the state still says it is pending.
  const r = root();
  const store = fileStore(r);
  const held = observe(EMPTY, [at(settled(7), "t1")], "c", 0, []);
  store.save(VAULT, held);
  finalize(r, store, meta(7));

  store.save(VAULT, held); // simulate the clear never happening
  assert.throws(() => finalize(r, store, meta(7)), /already recorded/);
});

test("bigint amounts survive the working state's round trip", () => {
  const r = root();
  const store = fileStore(r);
  store.save(VAULT, observe(EMPTY, [at(fill("GA"), "t1"), at(settled(7), "t2")], "c", 0, []));
  const back: Working = store.load(VAULT);
  // JSON has no bigint, so they land as strings — and `epochRecord` stringifies amounts anyway.
  const { path } = finalize(r, store, meta(7));
  const file = JSON.parse(readFileSync(path, "utf8")) as { epochs: EpochEvidence[] };
  assert.equal(file.epochs[0]?.fills[0]?.notional, "1000000000");
  assert.ok(back.rounds["7"]);
});
