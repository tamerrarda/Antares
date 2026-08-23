/**
 * Which screen the Vault page shows, which is the one derivation that can be wrong invisibly.
 *
 * Two rules here are not obvious and 08-OFFCHAIN records that earlier drafts got both of them
 * backwards:
 *
 *   - `Active` past expiry is **not** "the round is running". `close_round` is refusing on an oracle
 *     guard, and leaving the reader on "Active" for up to `oracle_dead_after` with no explanation is
 *     precisely the case the plan gives a first-class state of its own.
 *   - `next_open_at` is the authority **only** once `phase == Idle && !outcome_pending`. During a
 *     live round it still carries the PREVIOUS round's value — a past timestamp — and `epoch()`
 *     reports the *effective* phase, so an auction that closed empty already reads as `Idle` with
 *     `outcome_pending = true` while `last_finalize_time` still belongs to the round before.
 *     Switching on `Idle` alone shows a stale, usually negative countdown at the exact moment the
 *     window opens, in the lapse branch — which is the common one.
 */
import type { EpochInfo, Phase } from "@antares/bindings";
import assert from "node:assert/strict";
import { test } from "node:test";

import { faceOf, windowOpensAt } from "../lib/phase.ts";

const NOW = 1_800_000_000;

/** A round that opened an hour ago and expires in a week, with everything else out of the way. */
function epochWith(over: Partial<EpochInfo> & { phase: Phase }): EpochInfo {
  return {
    round: 12,
    outcome_pending: false,
    opened_at: BigInt(NOW - 3600),
    auction_end: BigInt(NOW - 900),
    expiry: BigInt(NOW + 604_800),
    // Deliberately in the PAST: this is what a live round's `next_open_at` looks like, because it
    // still belongs to the round before. Any code that reads it now is reading the wrong number.
    next_open_at: BigInt(NOW - 7200),
    last_finalize_time: BigInt(NOW - 11_000),
    notional_offered: 100n,
    notional_sold: 0n,
    premium_collected: 0n,
    current_premium_bps: 200,
    strike: 2_126_950n,
    open_twap: 2_065_000n,
    locked_assets: 100n,
    shares_outstanding: 100n,
    last_pps: 10_000_000n,
    void_available_at: 0n,
    params: {} as EpochInfo["params"],
    ...over,
  };
}

test("an auction is named by what it is offering, and says whether anyone has bought", () => {
  const quiet = faceOf(epochWith({ phase: { tag: "Auction", values: undefined } }), NOW);
  assert.equal(quiet.id, "auction");
  assert.match(quiet.note, /nobody has bought/);

  const partly = faceOf(epochWith({ phase: { tag: "Auction", values: undefined }, notional_sold: 40n }), NOW);
  assert.match(partly.note, /partly sold/);
});

test("a sold round before expiry is running", () => {
  const face = faceOf(epochWith({ phase: { tag: "Active", values: undefined } }), NOW);
  assert.equal(face.id, "active");
});

test("the same round PAST expiry is settlement being late, not a running round", () => {
  const e = epochWith({ phase: { tag: "Active", values: undefined }, expiry: BigInt(NOW - 1) });
  const face = faceOf(e, NOW);
  assert.equal(face.id, "delayed", "Active past expiry means close_round is refusing on the oracle");
  assert.match(face.label, /late/i);
  assert.match(face.note, /funds are safe/);
});

test("the boundary is inclusive: at exactly expiry the round can be closed, so it is already late", () => {
  const at = epochWith({ phase: { tag: "Active", values: undefined }, expiry: BigInt(NOW) });
  assert.equal(faceOf(at, NOW).id, "delayed");
  const oneBefore = epochWith({ phase: { tag: "Active", values: undefined }, expiry: BigInt(NOW + 1) });
  assert.equal(faceOf(oneBefore, NOW).id, "active");
});

test("Idle is the open window, and a pending outcome names the lapse it came from", () => {
  const settled = faceOf(epochWith({ phase: { tag: "Idle", values: undefined } }), NOW);
  assert.equal(settled.id, "window");
  assert.doesNotMatch(settled.note, /no buyer/);

  const lapsed = faceOf(epochWith({ phase: { tag: "Idle", values: undefined }, outcome_pending: true }), NOW);
  assert.equal(lapsed.id, "window");
  assert.match(lapsed.note, /found no buyer/);
});

test("next_open_at is refused while a round is live, however tempting the field looks", () => {
  for (const tag of ["Auction", "Active"] as const) {
    const e = epochWith({ phase: { tag, values: undefined } });
    assert.equal(
      windowOpensAt(e),
      null,
      `${tag} still carries the previous round's next_open_at; reading it shows a past timestamp`,
    );
  }
});

test("and refused in Idle too, until the lapse has actually been finalised", () => {
  // The trap: `epoch()` reports the EFFECTIVE phase, so an empty auction reads as Idle immediately
  // while `last_finalize_time` — and therefore `next_open_at` — still belongs to the round before.
  const pending = epochWith({ phase: { tag: "Idle", values: undefined }, outcome_pending: true });
  assert.equal(windowOpensAt(pending), null, "outcome_pending means the number has not moved yet");

  const finalised = epochWith({
    phase: { tag: "Idle", values: undefined },
    next_open_at: BigInt(NOW + 14_400),
  });
  assert.equal(windowOpensAt(finalised), BigInt(NOW + 14_400), "once finalised, it is the authority");
});

test("every face is named by consequence and none of them is an enum", () => {
  const all = [
    faceOf(epochWith({ phase: { tag: "Auction", values: undefined } }), NOW),
    faceOf(epochWith({ phase: { tag: "Active", values: undefined } }), NOW),
    faceOf(epochWith({ phase: { tag: "Active", values: undefined }, expiry: BigInt(NOW - 1) }), NOW),
    faceOf(epochWith({ phase: { tag: "Idle", values: undefined } }), NOW),
  ];
  for (const f of all) {
    assert.doesNotMatch(f.label, /^(Idle|Auction|Active)$/, `"${f.label}" is the enum, not a consequence`);
    assert.ok(f.label.length > 8, `"${f.label}" is too terse to be a sentence about consequence`);
  }
});
