/**
 * Paging, and the horizon.
 *
 * The rules worth testing are not "does it fetch" — they are what it does when the answer is
 * incomplete, because a seven-day window against a fourteen-day epoch makes incomplete the normal
 * case rather than the exceptional one.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { cursorLedger, EventSourceError, fetchSince, MAX_PAGES, type RpcLike } from "../events-source.ts";

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
  assert.equal(r.requests.length, 3, "it stops when a page comes back with no cursor");
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

// ---------------------------------------------------------------------------------------------
// An empty page is not the end of the range — measured on testnet, 2026-09-05
// ---------------------------------------------------------------------------------------------

/** A TOID cursor at a given ledger: `ledger << 32 | txIndex << 12 | opIndex`. */
const toid = (ledger: number) => `${(BigInt(ledger) << 32n).toString()}-4294967295`;

test("empty pages with an open cursor do not end the scan", async () => {
  // The defect this replaced returned **nothing** from a contract whose events were plainly on
  // chain. RPC pages by a ledger window (~10 000 ledgers), not by a count of results, so a vault
  // with few events answers page after empty page while the cursor walks forward. Instance A's
  // 7-day window took 13 pages; the first eleven were empty and both settlement events arrived on
  // page twelve. A scan that stops at the first empty page reports a healthy, silent nothing.
  const r = rpc([
    { events: [], cursor: toid(OLDEST + 10_000) },
    { events: [], cursor: toid(OLDEST + 20_000) },
    { events: [settled(7)], cursor: toid(LATEST) },
  ]);
  const out = await fetchSince(r, [VAULT], { startLedger: "oldest" });
  assert.equal(out.events.length, 1, "the event on the third page is found");
  assert.equal(r.requests.length, 3);
});

test("the scan ends when the cursor reaches the tip, not when a page is empty", async () => {
  const r = rpc([
    { events: [settled(1)], cursor: toid(LATEST - 10_000) },
    { events: [], cursor: toid(LATEST) },
    { events: [settled(2)], cursor: toid(LATEST) },
  ]);
  const out = await fetchSince(r, [VAULT], { startLedger: "oldest" });
  assert.equal(r.requests.length, 2, "the third page is never asked for");
  assert.equal(out.events.length, 1);
  assert.equal(out.cursor, toid(LATEST));
});

test("a cursor that is not a TOID falls back to the undefined check and the page cap", async () => {
  // Opaque cursors are the vendor's to change. If one stops parsing, the scan must degrade to
  // "keep going until told to stop" rather than to "stop immediately", which is why neither the
  // `undefined` terminator nor MAX_PAGES was removed when the ledger check was added.
  assert.equal(cursorLedger("not-a-toid"), null);
  assert.equal(cursorLedger(""), null);
  assert.equal(cursorLedger(toid(4_507_695)), 4_507_695);
  const r = rpc([
    { events: [], cursor: "opaque-1" },
    { events: [settled(3)], cursor: "opaque-2" },
    { events: [] },
  ]);
  const out = await fetchSince(r, [VAULT], { startLedger: "oldest" });
  assert.equal(out.events.length, 1);
});

// ---------------------------------------------------------------------------------------------
// The floor is read once, here
// ---------------------------------------------------------------------------------------------

test('"oldest" starts at the horizon and reports no shortfall', async () => {
  // A caller that reads `getHealth` itself and passes the floor back re-reads a moving number: the
  // ledger that closed in between comes back as one lost ledger, which `Working.missedLedgers`
  // accumulates and never resets. Measured against testnet before this arm existed — the first
  // collect returned `missedLedgers: 1` on a vault that had lost nothing.
  const r = rpc([{ events: [settled(1)] }]);
  const out = await fetchSince(r, [VAULT], { startLedger: "oldest" });
  assert.equal(out.missedLedgers, 0);
  assert.equal((r.requests[0] as { startLedger?: number }).startLedger, OLDEST);
});
