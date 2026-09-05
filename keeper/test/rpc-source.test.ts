/**
 * The adapter, checked on the one thing that broke it.
 *
 * `RpcLike` declares `topic: unknown[]`, so an adapter that forwards the SDK's `xdr.ScVal` objects
 * type-checks and then makes every event `<unnameable>` at `eventName`. Nothing in the type system
 * can catch that, and nothing did for the hours it existed. This is what catches it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";

import { eventName } from "@antares/common/events";

import { rpcSource } from "../rpc-source.ts";

/** The shape `rpc.Server` returns: ScVals, not natives. */
const scEvent = () => ({
  contractId: undefined,
  topic: [nativeToScVal("settled", { type: "symbol" }), nativeToScVal(7, { type: "u32" })],
  value: nativeToScVal({ premium: 1n }, { type: { premium: ["symbol", "i128"] } }),
  txHash: "tx-1",
  ledger: 4_507_695,
});

const server = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    getHealth: () => Promise.resolve({ oldestLedger: 1, latestLedger: 2, status: "healthy" }),
    getEvents: () => Promise.resolve({ events: [scEvent()], latestLedger: 2, cursor: "c1" }),
    ...over,
  }) as unknown as rpc.Server;

test("topics come back native, so `eventName` can read them", async () => {
  const out = await rpcSource(server()).getEvents({ filters: [{ type: "contract", contractIds: ["C"] }] });
  const e = out.events[0]!;
  assert.equal(typeof e.topic[0], "string", "an xdr.ScVal here is the defect this test exists for");
  assert.equal(e.topic[0], "settled");
  assert.equal(e.topic[1], 7);
  // The end-to-end statement: the decoder can name it. This is the assertion that failed in
  // production while every other test in the suite passed.
  assert.equal(eventName({ topics: e.topic, data: e.value, txHash: e.txHash, ledger: e.ledger }), "settled");
});

test("the value is native too, not an ScVal the decoders cannot read", async () => {
  const out = await rpcSource(server()).getEvents({ filters: [{ type: "contract", contractIds: ["C"] }] });
  assert.deepEqual(out.events[0]!.value, { premium: 1n });
});

test("health is narrowed to the two ledger bounds the pager uses", async () => {
  const h = await rpcSource(server()).getHealth();
  assert.deepEqual(h, { oldestLedger: 1, latestLedger: 2 });
});

test("a cursor request and a startLedger request take different arms of the SDK's union", async () => {
  const asked: unknown[] = [];
  const s = server({
    getEvents: (req: unknown) => {
      asked.push(req);
      return Promise.resolve({ events: [], latestLedger: 2 });
    },
  });
  const src = rpcSource(s);
  await src.getEvents({ startLedger: 100, filters: [{ type: "contract", contractIds: ["C"] }], limit: 5 });
  await src.getEvents({ cursor: "c9", filters: [{ type: "contract", contractIds: ["C"] }] });
  assert.equal((asked[0] as { startLedger?: number }).startLedger, 100);
  assert.equal((asked[0] as { cursor?: string }).cursor, undefined);
  assert.equal((asked[1] as { cursor?: string }).cursor, "c9");
  assert.equal((asked[1] as { startLedger?: number }).startLedger, undefined);
});

test("an absent cursor is absent, not present-and-undefined", async () => {
  // `exactOptionalPropertyTypes` is on, and `fetchSince` terminates on `res.cursor === undefined`.
  const s = server({ getEvents: () => Promise.resolve({ events: [], latestLedger: 2 }) });
  const out = await rpcSource(s).getEvents({ filters: [{ type: "contract", contractIds: ["C"] }] });
  assert.equal("cursor" in out, false);
});
