/**
 * The sweep, checked on the two things that make it maintenance rather than a job that runs once.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isDue, sweep, SWEEP_INTERVAL_SECONDS, type RestoreClient, type Roster } from "../sweep.ts";

const NOW = 1_787_000_000;

const roster = (addresses: readonly string[]): Roster => ({
  addresses: () => Promise.resolve(addresses),
});

const client = (fail: ReadonlySet<string> = new Set()): RestoreClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    id: "CVAULT",
    calls,
    restorePosition: (user: string) => {
      calls.push(user);
      return fail.has(user) ? Promise.reject(new Error(`no entry for ${user}`)) : Promise.resolve("tx");
    },
  };
};

test("a keeper that has never swept sweeps immediately", () => {
  // The alternative is that a fresh deployment waits a month before its first maintenance — the
  // exact window in which nobody is watching it yet.
  assert.equal(isDue({ lastSweptAt: null }, NOW), true);
});

test("the cadence is thirty days, at the boundary", () => {
  const last = NOW - SWEEP_INTERVAL_SECONDS;
  assert.equal(isDue({ lastSweptAt: last + 1 }, NOW), false);
  assert.equal(isDue({ lastSweptAt: last }, NOW), true);
});

test("every address is bumped once", async () => {
  const c = client();
  const r = await sweep(c, roster(["GA", "GB", "GC"]), NOW);
  assert.deepEqual(c.calls, ["GA", "GB", "GC"]);
  assert.equal(r.restored, 3);
  assert.equal(r.attempted, 3);
  assert.equal(r.failed.length, 0);
  assert.equal(r.sweptAt, NOW);
});

test("one failure does not stop the pass", async () => {
  // Each address is independent: a restore that fails for one user says nothing about the next, and
  // aborting would leave the rest of the roster unbumped because of somebody else's problem.
  const c = client(new Set(["GB"]));
  const r = await sweep(c, roster(["GA", "GB", "GC"]), NOW);
  assert.deepEqual(c.calls, ["GA", "GB", "GC"], "GC must still have been attempted after GB failed");
  assert.equal(r.restored, 2);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]?.address, "GB");
});

test("an empty roster is a completed sweep, not an error", async () => {
  // A vault with no depositors yet has nothing to maintain, and treating that as a failure would
  // alert on every pass of a brand-new instance.
  const r = await sweep(client(), roster([]), NOW);
  assert.equal(r.attempted, 0);
  assert.equal(r.failed.length, 0);
});

test("progress is reported per address, successes and failures alike", async () => {
  const seen: [string, boolean][] = [];
  await sweep(client(new Set(["GB"])), roster(["GA", "GB"]), NOW, (a, ok) => seen.push([a, ok]));
  assert.deepEqual(seen, [
    ["GA", true],
    ["GB", false],
  ]);
});
