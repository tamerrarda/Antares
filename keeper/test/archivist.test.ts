/**
 * The wiring, checked on its two refusals.
 *
 * `archive.ts`'s own suite covers the folding and the append. What is only testable here is what
 * the archive does when it is switched on **after** the chain has been running — which is the
 * situation it was actually switched on in, and the one that lost four rounds before anyone
 * noticed. Both refusals below are the difference between a partial record and a false one.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DecodedEvent } from "@antares/common/events";

import { EMPTY, fileStore, observe } from "../archive.ts";
import { closed, makeArchivist } from "../archivist.ts";
import type { EpochView } from "../decide.ts";
import type { EvidenceFile } from "../evidence.ts";
import type { RpcLike } from "../events-source.ts";
import type { Located } from "../record.ts";

const VAULT = "CVAULT";
const NET = "testnet";
const OPENED = 1_787_000_000;
const CLOSED = OPENED + 259_200;

const at = (event: DecodedEvent, txHash: string, ledger = 1): Located => ({ event, txHash, ledger });

const opened = (round: number): DecodedEvent => ({
  name: "epoch_opened",
  round,
  strike: 1_874_408n,
  expiry: CLOSED - 60,
  openedAt: OPENED,
  auctionEnd: OPENED + 2_700,
  notionalOffered: 2_000_001_000n,
  openTwap: 1_819_814n,
  premiumStartBps: 500,
  premiumFloorBps: 112,
});

const settled = (round: number): DecodedEvent => ({
  name: "settled",
  round,
  spot: 1_853_600n,
  strike: 1_874_408n,
  notionalSold: 2_000_001_000n,
  payoutTotal: 0n,
  premium: 94_400_047n,
  fee: 0n,
  pps: 10_470_819n,
  wclaims: 0n,
});

const view = (over: Partial<EpochView> = {}): EpochView => ({
  round: 1,
  phase: "Idle",
  outcomePending: false,
  expiry: CLOSED - 60,
  nextOpenAt: CLOSED + 14_400,
  epochDuration: 259_200,
  unresolvedAfter: 75_600,
  openedAt: OPENED,
  lastFinalizeTime: CLOSED,
  ...over,
});

const root = () => mkdtempSync(join(tmpdir(), "antares-archivist-"));

/** An RPC that records what it was asked for and returns nothing. */
const spyRpc = (oldestLedger: number) => {
  const asked: Array<{ startLedger?: number; cursor?: string }> = [];
  const rpc: RpcLike = {
    getHealth: () => Promise.resolve({ oldestLedger, latestLedger: oldestLedger + 100_000 }),
    getEvents: (request) => {
      asked.push({
        ...(request.startLedger === undefined ? {} : { startLedger: request.startLedger }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      return Promise.resolve({ events: [], latestLedger: oldestLedger + 100_000 });
    },
  };
  return { rpc, asked };
};

// ---------------------------------------------------------------------------------------------
// closed()
// ---------------------------------------------------------------------------------------------

test("a round is closed only when the view is Idle and something has finalized", () => {
  assert.equal(closed(view()), true);
  // Idle with no finalize time is a vault that has never closed a round, not a closed round.
  assert.equal(closed(view({ lastFinalizeTime: 0 })), false);
  assert.equal(closed(view({ phase: "Active" })), false);
  assert.equal(closed(view({ phase: "Auction" })), false);
});

// ---------------------------------------------------------------------------------------------
// collect — the horizon rule
// ---------------------------------------------------------------------------------------------

test("a first collect asks for the retention floor and never for anything below it", async () => {
  const r = root();
  const { rpc, asked } = spyRpc(4_387_212);
  await makeArchivist({ rpc, store: fileStore(r), root: r, network: NET }).collect(VAULT);
  assert.deepEqual(asked, [{ startLedger: 4_387_212 }]);
  // Because nothing older was requested, nothing was missed — and a round watched in full later
  // must not inherit `complete: false` from a start the keeper had no way to make earlier.
  assert.equal(fileStore(r).load(VAULT).missedLedgers, 0);
});

test("a later collect resumes from the cursor rather than the floor", async () => {
  const r = root();
  const store = fileStore(r);
  store.save(VAULT, { ...EMPTY, cursor: "c-1" });
  const { rpc, asked } = spyRpc(4_387_212);
  await makeArchivist({ rpc, store, root: r, network: NET }).collect(VAULT);
  assert.deepEqual(asked, [{ cursor: "c-1" }]);
});

// ---------------------------------------------------------------------------------------------
// close — the refusal that matters
// ---------------------------------------------------------------------------------------------

test("a round whose opening was never seen is not written, even though its close was", async () => {
  // Exactly the four rounds this keeper was switched on too late for: the settlement is still
  // inside the RPC window, the auction that produced it is not. A record built from this alone
  // would carry `complete: true` — nothing was requested and missed — and describe a round nobody
  // watched. That is worse than no record, because a reader cannot tell it from a real one.
  const r = root();
  const store = fileStore(r);
  store.save(VAULT, observe(EMPTY, [at(settled(1), "tx-settle")], "c-9", 0, []));
  const { rpc } = spyRpc(4_387_212);
  const a = makeArchivist({ rpc, store, root: r, network: NET });
  assert.equal(await a.close(VAULT, view()), null);
  // And the events are still held, so nothing is destroyed by the refusal.
  assert.equal(store.load(VAULT).rounds["1"]?.length, 1);
});

test("a round watched from its opening is written", async () => {
  const r = root();
  const store = fileStore(r);
  store.save(
    VAULT,
    observe(EMPTY, [at(opened(1), "tx-open"), at(settled(1), "tx-settle")], "c-9", 0, []),
  );
  const { rpc } = spyRpc(4_387_212);
  const path = await makeArchivist({ rpc, store, root: r, network: NET }).close(VAULT, view());
  assert.ok(path !== null);
  const file = JSON.parse(readFileSync(path, "utf8")) as EvidenceFile;
  assert.equal(file.epochs.length, 1);
  assert.equal(file.epochs[0]!.round, 1);
  assert.equal(file.epochs[0]!.historyGaps.complete, true);
  // The bucket is cleared, so a second pass over the same view does not write it twice.
  assert.equal(store.load(VAULT).rounds["1"], undefined);
});

test("an open round is not written, however much of it is held", async () => {
  const r = root();
  const store = fileStore(r);
  store.save(VAULT, observe(EMPTY, [at(opened(1), "tx-open")], "c-9", 0, []));
  const { rpc } = spyRpc(4_387_212);
  const a = makeArchivist({ rpc, store, root: r, network: NET });
  assert.equal(await a.close(VAULT, view({ phase: "Active", lastFinalizeTime: 0 })), null);
});

test("a round the archive holds nothing for is not written", async () => {
  const r = root();
  const { rpc } = spyRpc(4_387_212);
  const a = makeArchivist({ rpc, store: fileStore(r), root: r, network: NET });
  assert.equal(await a.close(VAULT, view({ round: 42 })), null);
});
