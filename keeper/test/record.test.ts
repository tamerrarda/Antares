/**
 * The assembler, checked where it refuses.
 *
 * The evidence file exists to outlive the chain it came from, so the tests that matter are the ones
 * about what it declines to write: a round that has not closed, a round that closed twice, and
 * somebody else's fill in this round's index.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DecodedEvent } from "@antares/common/events";

import { epochRecord, fillIndex, RecordError, roster, terminalOf, type Located } from "../record.ts";

const VAULT = "CVAULT";
const ROUND = 7;

const at = (event: DecodedEvent, txHash: string, ledger = 1): Located => ({ event, txHash, ledger });

const fill = (bidder: string, notional: bigint, premium: bigint, round = ROUND): DecodedEvent => ({
  name: "bid_filled",
  round,
  bidder,
  notional,
  premiumBps: 300,
  premium,
  notionalSoldAfter: notional,
});

const settled = (round = ROUND): DecodedEvent => ({
  name: "settled",
  round,
  spot: 1_700_000n,
  strike: 1_600_000n,
  notionalSold: 5_000_000_000n,
  payoutTotal: 294_117_647n,
  premium: 200_000_000n,
  fee: 0n,
  pps: 10_100_000n,
  wclaims: 0n,
});

const voided = (round = ROUND): DecodedEvent => ({
  name: "epoch_voided",
  round,
  reason: "FeedUnusable",
  premiumRefunded: 200_000_000n,
  pps: 10_000_000n,
  wclaims: 0n,
});

const lapsed = (round = ROUND): DecodedEvent => ({
  name: "epoch_lapsed",
  round,
  notionalOffered: 5_000_000_000n,
  pps: 10_000_000n,
  wclaims: 4_000_000n,
});

const inputs = (events: readonly Located[]) => ({
  vault: VAULT,
  round: ROUND,
  openedAt: 1_000,
  expiry: 605_800,
  closedAt: 605_900,
  events,
  sigmaRealized: null,
});

test("a closed round assembles with its outcome, hashes, fills and events", () => {
  const r = epochRecord(
    inputs([
      at(fill("GA", 3_000_000_000n, 120_000_000n), "tx-bid-a"),
      at(fill("GB", 2_000_000_000n, 80_000_000n), "tx-bid-b"),
      at(settled(), "tx-close"),
    ]),
  );
  assert.equal(r.outcome, "Settled");
  assert.deepEqual(r.txHashes, ["tx-bid-a", "tx-bid-b", "tx-close"]);
  assert.equal(r.fills.length, 2);
  assert.equal(r.events.length, 3);
});

test("amounts in the fill index are strings", () => {
  // i128 stroops pass Number.MAX_SAFE_INTEGER at scale. A number here rounds silently and the
  // Claims page then owes somebody the wrong amount.
  const f = fillIndex([at(fill("GA", 9_007_199_254_740_993n, 1n), "tx")]);
  assert.equal(typeof f[0]?.notional, "string");
  assert.equal(f[0]?.notional, "9007199254740993", "the value must survive exactly");
});

test("an empty auction is a closed round, and reaches the record as one", () => {
  // The lapse was not in `isTerminal` until 2026-08-21, so this record could not be written at all:
  // `terminalOf` reported an empty auction as a round that "has not closed", on a chain where
  // `finalize_round` had already set `phase = Idle`. An auction that clears empty is a data point
  // about demand (ARCHITECTURE §10), and it is exactly the round a reader wants explained.
  const r = epochRecord(inputs([at(lapsed(), "tx-lapse")]));
  assert.equal(r.outcome, "Lapsed");
  assert.deepEqual(r.fills, [], "nobody bid, so the fill index is empty rather than absent");
  assert.deepEqual(r.txHashes, ["tx-lapse"]);
});

test("a round with no terminal event is refused, not written as closed", () => {
  assert.throws(
    () => epochRecord(inputs([at(fill("GA", 1n, 1n), "tx")])),
    (e: unknown) => e instanceof RecordError && /has not closed/.test(e.message),
  );
});

test("a round with two terminal events is refused rather than resolved", () => {
  // Two would mean I10 broke on-chain, or two rounds' events got mixed. Picking one hides which.
  assert.throws(
    () => terminalOf(ROUND, [at(settled(), "tx-a"), at(voided(), "tx-b")]),
    (e: unknown) => e instanceof RecordError && /I10/.test(e.message),
  );
});

test("another round's fill in this round's index is refused", () => {
  // The fill index is what the Claims page pays people from, so a stray fill is somebody else's
  // money appearing in this round's record.
  assert.throws(
    () => epochRecord(inputs([at(fill("GA", 1n, 1n, 8), "tx-a"), at(settled(), "tx-close")])),
    (e: unknown) => e instanceof RecordError && /somebody else's money/.test(e.message),
  );
});

test("transaction hashes are deduplicated but keep first-seen order", () => {
  // A set would lose the ordering that makes the list readable as a history — a reader comparing it
  // against an explorer is following a sequence, not a bag.
  const r = epochRecord(
    inputs([
      at(fill("GA", 1n, 1n), "tx-1"),
      at(fill("GB", 1n, 1n), "tx-1"),
      at(fill("GC", 1n, 1n), "tx-2"),
      at(settled(), "tx-3"),
    ]),
  );
  assert.deepEqual(r.txHashes, ["tx-1", "tx-2", "tx-3"]);
});

test("each terminal event maps to its own outcome name", () => {
  assert.equal(epochRecord(inputs([at(settled(), "t")])).outcome, "Settled");
  assert.equal(epochRecord(inputs([at(voided(), "t")])).outcome, "Voided");
  assert.equal(
    epochRecord(
      inputs([
        at(
          {
            name: "epoch_unresolved",
            round: ROUND,
            premiumRetained: 1n,
            fee: 0n,
            pps: 1n,
            wclaims: 0n,
            oracleAnswered: false,
          },
          "t",
        ),
      ]),
    ).outcome,
    "Unresolved",
  );
});

// ---------------------------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------------------------

test("the roster is first-seen order and deduplicated", () => {
  // Stable order matters: a sweep interrupted halfway resumes over the same sequence.
  const seen = roster([
    at(fill("GA", 1n, 1n), "t"),
    at(fill("GB", 1n, 1n), "t"),
    at(fill("GA", 1n, 1n), "t"),
    at({ name: "payout_claimed", round: ROUND, bidder: "GC", amount: 1n }, "t"),
  ]);
  assert.deepEqual(seen, ["GA", "GB", "GC"]);
});

test("the roster picks up every address-carrying event without naming them one by one", () => {
  // Derived from shape rather than from a list, so it grows on its own as events are registered —
  // which is how `deposited` joins it the day DEV1 registers it, with no edit here.
  const seen = roster([
    at({ name: "settle_bounty", round: ROUND, to: "GKEEPER", amount: 1n }, "t"),
    at({ name: "fee_claimed", recipient: "GFEE", amount: 1n }, "t"),
    at({ name: "refund_claimed", round: ROUND, bidder: "GBID", amount: 1n }, "t"),
  ]);
  assert.deepEqual(seen.sort(), ["GBID", "GFEE", "GKEEPER"]);
});

test("a roster built only from bidder events is short by every depositor, and visibly so", () => {
  // `deposited` is DEV1's and unregistered, so depositors are absent today. The count is the
  // evidence of that rather than an empty result pretending the vault has no users.
  const seen = roster([at(settled(), "t")]);
  assert.equal(seen.length, 0, "a settle names nobody; the roster's gap shows in its size");
});
