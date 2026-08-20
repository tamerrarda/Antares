/**
 * Paging, and the horizon.
 *
 * The rules worth testing are not "does it fetch" — they are what it does when the answer is
 * incomplete, because a seven-day window against a fourteen-day epoch makes incomplete the normal
 * case rather than the exceptional one.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EventSourceError, fetchSince, MAX_PAGES, type RpcLike } from "../events-source.ts";

const VAULT = "CVAULT";
const OLDEST = 4_117_340;
const LATEST = 4_238_299;

const settled = (round: number) => ({
  topic: ["settled", round],
  value: {
    spot: 1n,
    strike: 1n,
    notional_sold: 1n,
    payout_total: 0n,
    premium: 1n,
    fee: 0n,
    pps: 1n,
    wclaims: 0n,
  },
  txHash: `tx-${round}`,
  ledger: OLDEST + round,
});

function rpc(pages: { events: unknown[]; cursor?: string }[]): RpcLike & { requests: unknown[] } {
  let i = 0;
  const requests: unknown[] = [];
  return {
    requests,
    getHealth: () => Promise.resolve({ oldestLedger: OLDEST, latestLedger: LATEST }),
    getEvents: (req) => {
      requests.push(req);
      const page = pages[i++] ?? { events: [] };
      return Promise.resolve({
        events: page.events as never,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        latestLedger: LATEST,
      });
    },
  };
}

test("pages follow the cursor until it runs out", async () => {
  const r = rpc([
    { events: [settled(1)], cursor: "c1" },
    { events: [settled(2)], cursor: "c2" },
    { events: [] },
  ]);
  const out = await fetchSince(r, [VAULT], { startLedger: OLDEST + 1 });
  assert.equal(out.events.length, 2);
  assert.equal(r.requests.length, 3, "it stops when a page comes back empty");
  // The second and third requests must carry the cursor, not the startLedger — otherwise every page
  // re-reads the first one and the loop never advances.
  assert.equal((r.requests[1] as { cursor?: string }).cursor, "c1");
  assert.equal((r.requests[2] as { cursor?: string }).cursor, "c2");
});

test("a start below the horizon is reported as lost ledgers, not clamped silently", async () => {
  // Clamping and carrying on returns a range that LOOKS complete. Nobody — not us, not a reviewer —
  // can recover what the window dropped, so the shortfall is a value the caller has to handle.
  const r = rpc([{ events: [settled(1)] }]);
  const out = await fetchSince(r, [VAULT], { startLedger: OLDEST - 5_000 });
  assert.equal(out.missedLedgers, 5_000);
  assert.equal(out.oldestLedger, OLDEST);
  assert.equal(
    (r.requests[0] as { startLedger?: number }).startLedger,
    OLDEST,
    "it still fetches what survives",
  );
});

test("a start inside the horizon reports no shortfall", async () => {
  const out = await fetchSince(rpc([{ events: [] }]), [VAULT], { startLedger: OLDEST + 10 });
  assert.equal(out.missedLedgers, 0);
});

test("another module's events are skipped by name and the names are returned", async () => {
  // decodeEvent throws on an unregistered name because skipping is data loss dressed as tolerance.
  // A keeper reading a vault that also emits DEV1's events must pass over them — but not silently,
  // so the caller can see exactly what it did not read.
  const foreign = { topic: ["deposited", 4], value: { amount: 1n }, txHash: "tx-d", ledger: OLDEST + 4 };
  const out = await fetchSince(rpc([{ events: [settled(1), foreign] }]), [VAULT], {
    startLedger: OLDEST + 1,
  });
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.skipped, ["deposited"]);
});

test("an event whose name cannot be read is counted, not dropped", async () => {
  // "We could not tell what this was" is information. Losing it would make a malformed event
  // indistinguishable from one that never happened.
  const broken = { topic: [], value: {}, txHash: "tx-x", ledger: OLDEST + 1 };
  const out = await fetchSince(rpc([{ events: [broken] }]), [VAULT], { startLedger: OLDEST + 1 });
  assert.deepEqual(out.skipped, ["<unnameable>"]);
  assert.equal(out.events.length, 0);
});

test("the cursor comes back so the next pass resumes rather than re-reading", async () => {
  const out = await fetchSince(rpc([{ events: [settled(1)], cursor: "c9" }, { events: [] }]), [VAULT], {
    startLedger: OLDEST + 1,
  });
  assert.equal(out.cursor, "c9");

  // And it is accepted as a starting point, without a startLedger.
  const r2 = rpc([{ events: [] }]);
  await fetchSince(r2, [VAULT], { cursor: "c9" });
  assert.equal((r2.requests[0] as { cursor?: string }).cursor, "c9");
  assert.equal((r2.requests[0] as { startLedger?: number }).startLedger, undefined);
});

test("a cursor that never stops advancing is cut off rather than spun on", async () => {
  // Against a shared public endpoint, an unbounded loop is the failure that takes the RPC down for
  // everybody else as well as us.
  const forever = Array.from({ length: MAX_PAGES + 2 }, (_, i) => ({
    events: [settled(i + 1)],
    cursor: `c${i}`,
  }));
  await assert.rejects(
    () => fetchSince(rpc(forever), [VAULT], { startLedger: OLDEST + 1 }),
    EventSourceError,
  );
});

test("the contract filter carries the ids it was given", async () => {
  const r = rpc([{ events: [] }]);
  await fetchSince(r, ["CA", "CB"], { startLedger: OLDEST + 1 });
  const req = r.requests[0] as { filters: { contractIds: string[] }[] };
  assert.deepEqual(req.filters[0]?.contractIds, ["CA", "CB"]);
});
