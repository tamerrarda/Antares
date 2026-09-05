/**
 * The dispatch, and the two thresholds that are wrong in the obvious place.
 *
 * These are the rules a reasonable implementation gets subtly wrong: pausing the unpausable exit,
 * simulating the oracle to pick an outcome, and putting the "still Active" alert at the bound
 * rather than an hour past expiry. Each has its own test, and each names what the wrong version
 * would cost.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  alerts,
  decide,
  EXPIRY_ALERT_AFTER,
  runwayThreshold,
  type Action,
  type EpochView,
} from "../decide.ts";

const DAY = 86_400;
const NOW = 1_787_000_000;

/**
 * 02-CONTRACT-SPEC §1, default **and** shipped. Named rather than inlined because the first version
 * of this file used 73 200 — admissible, inside condition 3's window, and **not shipped** — while
 * the test that consumed it was called "matching the shipped instances". The arithmetic was right
 * and the input was never checked, which is the same shape as the provisional-close finding.
 */
const SHIPPED_UNRESOLVED_AFTER = 75_600;

const view = (over: Partial<EpochView> = {}): EpochView => ({
  round: 3,
  phase: "Active",
  outcomePending: false,
  expiry: NOW,
  nextOpenAt: NOW,
  epochDuration: 7 * DAY,
  unresolvedAfter: SHIPPED_UNRESOLVED_AFTER,
  // No branch in `decide` or `alerts` reads either; they are carried for the archive.
  openedAt: NOW - 7 * DAY,
  lastFinalizeTime: 0,
  ...over,
});

const kinds = (a: Action) => a.kind;

// ---------------------------------------------------------------------------------------------
// D-61 — the trap
// ---------------------------------------------------------------------------------------------

test("there is no action that names an outcome", () => {
  // D-61 collapsed settle / void_epoch / finalize_unresolved into one call so the caller *cannot*
  // choose. The keeper therefore has one action for a live expired round, whatever the oracle is
  // doing, and this test is the guard on that: the set of kinds is closed.
  const reachable = new Set<string>();
  for (const phase of ["Idle", "Auction", "Active"] as const) {
    for (const paused of [true, false]) {
      for (const now of [NOW - 1, NOW, NOW + 10 * DAY]) {
        reachable.add(kinds(decide(view({ phase }), { paused }, now)));
      }
    }
  }
  assert.deepEqual([...reachable].sort(), ["close_round", "open_epoch", "wait"]);
  for (const banned of ["settle", "void", "unresolved", "finalize"]) {
    assert.ok(!reachable.has(banned), `${banned} is the bug D-61 removed; it must not be an action`);
  }
});

test("an expired Active round is closed with one call regardless of anything oracle-shaped", () => {
  // The decision takes no oracle input at all — there is no parameter to pass one through. If a
  // future edit wants to consult the feed before closing, it has to change this signature, which
  // is the friction the design intends.
  assert.equal(decide(view({ phase: "Active", expiry: NOW }), { paused: false }, NOW).kind, "close_round");
  assert.equal(decide(view({ phase: "Active", expiry: NOW }), { paused: true }, NOW).kind, "close_round");
});

// ---------------------------------------------------------------------------------------------
// I8 — pause gates new risk, never the exit
// ---------------------------------------------------------------------------------------------

test("pause blocks open_epoch and never blocks close_round", () => {
  const paused = { paused: true };
  assert.equal(decide(view({ phase: "Idle", nextOpenAt: NOW }), paused, NOW).kind, "wait");
  // The load-bearing half: a keeper that skipped close_round while paused would turn the safety
  // switch into the fund-trapping mechanism it exists to avoid.
  assert.equal(
    decide(view({ phase: "Active", expiry: NOW - 1 }), paused, NOW).kind,
    "close_round",
    "pause stops new risk being written and never stops a round being closed (I8)",
  );
});

// ---------------------------------------------------------------------------------------------
// The ordinary dispatch
// ---------------------------------------------------------------------------------------------

test("Idle opens only once the idle gap has actually elapsed", () => {
  const unpaused = { paused: false };
  assert.equal(decide(view({ phase: "Idle", nextOpenAt: NOW + 1 }), unpaused, NOW).kind, "wait");
  assert.equal(decide(view({ phase: "Idle", nextOpenAt: NOW }), unpaused, NOW).kind, "open_epoch");
});

test("an unexpired Active round waits, and says how long", () => {
  const a = decide(view({ phase: "Active", expiry: NOW + 600 }), { paused: false }, NOW);
  assert.equal(a.kind, "wait");
  assert.match(a.kind === "wait" ? a.why : "", /600s/);
});

test("a live auction is nobody's job here", () => {
  // Bids are the public's and DEV3's bidder. The lazy lapse resolves through whatever touches the
  // vault next, including the open_epoch this returns once the view reads Idle.
  assert.equal(decide(view({ phase: "Auction" }), { paused: false }, NOW).kind, "wait");
});

test("the effective phase is taken from the view, not re-derived", () => {
  // `views.rs::effective_phase` already reports a stored Auction past auction_end as Active when it
  // sold and Idle when it did not. A keeper that re-derived it would be the second copy, and the
  // two would drift. Here: an Idle view with `outcomePending` is opened, which lapse-finalizes
  // first by construction.
  const a = decide(view({ phase: "Idle", outcomePending: true, nextOpenAt: NOW }), { paused: false }, NOW);
  assert.equal(a.kind, "open_epoch");
});

// ---------------------------------------------------------------------------------------------
// The two thresholds
// ---------------------------------------------------------------------------------------------

test("the still-Active alert fires an hour past expiry, not at the reachable bound", () => {
  const v = view({ phase: "Active", expiry: NOW });
  const feed = { expiresAt: NOW + 400 * DAY };
  assert.equal(alerts("CV", v, feed, NOW + EXPIRY_ALERT_AFTER - 1).length, 0);
  assert.equal(alerts("CV", v, feed, NOW + EXPIRY_ALERT_AFTER)[0]?.kind, "expiry_passed_still_active");

  // The bound is 20 h 15 m at shipped values. Firing there would fire at the moment the loss becomes
  // unavoidable rather than while it is still preventable, so the alert must already be up long
  // before it — asserted as an ordering rather than described.
  assert.ok(EXPIRY_ALERT_AFTER < 20.25 * 3600, "the alert must precede the reachable bound");
});

test("the runway threshold is one round's span plus an epoch, at the shipped values", () => {
  // A: 7-day epoch. D: 14-day. `unresolved_after` is the shipped 75 600, which sits inside the
  // admissible band (72 900, 80 100] that conditions 3 and 6 define at a 3 600 s guard window and a
  // 7 200 s settle_grace.
  const a = runwayThreshold({ epochDuration: 7 * DAY, unresolvedAfter: SHIPPED_UNRESOLVED_AFTER });
  const d = runwayThreshold({ epochDuration: 14 * DAY, unresolvedAfter: SHIPPED_UNRESOLVED_AFTER });
  assert.equal(a / DAY, 14.875, "instance A, at the shipped unresolved_after");
  assert.equal(d / DAY, 28.875, "instance D, at the shipped unresolved_after");

  // And the reason it is not a fixed week: at a 7-day epoch a "< 7 days" rule fires *after*
  // condition 7 has begun refusing to open rounds, i.e. after the event it exists to prevent.
  assert.ok(a > 7 * DAY, "a fixed 7-day threshold is inside one round's span and therefore too late");
});

test("the threshold follows unresolved_after rather than carrying a copy of it", () => {
  // Another admissible value from the same band. The figure moves with it, which is what makes the
  // shipped numbers above a *measurement* of the shipped set rather than two constants that happen
  // to be written down next to a formula.
  const other = runwayThreshold({ epochDuration: 7 * DAY, unresolvedAfter: 73_200 });
  assert.ok(Math.abs(other / DAY - 14.8472) < 0.0001);
  assert.notEqual(
    other,
    runwayThreshold({ epochDuration: 7 * DAY, unresolvedAfter: SHIPPED_UNRESOLVED_AFTER }),
  );
});

test("a low runway alerts, and an ample one does not", () => {
  const v = view({ phase: "Idle" });
  const threshold = runwayThreshold(v);
  assert.equal(alerts("CV", v, { expiresAt: NOW + threshold }, NOW).length, 0);
  const low = alerts("CV", v, { expiresAt: NOW + threshold - 1 }, NOW);
  assert.equal(low[0]?.kind, "feed_runway_low");
});

test("a feed with no expiry at all is the same alert, not a silent pass", () => {
  // `supports_round` reads a `None` expiry as an unfunded feed and refuses (condition 7). Treating
  // it as "no information" would leave the vault unable to open rounds with nothing raised.
  const out = alerts("CV", view({ phase: "Idle" }), { expiresAt: null }, NOW);
  const first = out[0];
  assert.ok(first, "an unfunded feed must raise something rather than passing silently");
  assert.equal(first.kind, "feed_runway_low");
  assert.match(first.message, /unfunded/);
});

test("an Idle vault raises no expiry alert however long it has been idle", () => {
  const out = alerts(
    "CV",
    view({ phase: "Idle", expiry: NOW - 100 * DAY }),
    { expiresAt: NOW + 400 * DAY },
    NOW,
  );
  assert.equal(out.length, 0, "there is no round to be late");
});
