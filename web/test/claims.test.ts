/**
 * What a bidder's row means, which neither of its two fields says on its own.
 *
 * Measured against the live vault: an `Unresolved` round leaves a bidder with `claimable = 0` and
 * `claimed = false`, because nothing was ever owed — the premium stays with depositors and the buyer
 * gets nothing. Read either field alone and that row looks like money waiting to be collected. It is
 * the round's entire outcome that there is none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { claimState, totalUnclaimed, type ClaimRow } from "../lib/claims.ts";

const row = (over: Partial<ClaimRow>): ClaimRow => ({
  round: 1,
  notional: 100n,
  premiumPaid: 5n,
  claimable: 0n,
  claimed: false,
  archived: false,
  ...over,
});

test("money waiting is claimable", () => {
  assert.equal(claimState(row({ claimable: 42n })), "claimable");
});

test("money already taken is claimed, whatever the balance now reads", () => {
  assert.equal(claimState(row({ claimable: 0n, claimed: true })), "claimed");
});

test("zero and unclaimed is NOTHING OWED, not an uncollected balance", () => {
  // The live case: round 2 on the deployed vault closed unresolved.
  assert.equal(claimState(row({ claimable: 0n, claimed: false })), "nothing-owed");
});

test("the unclaimed total counts only what is actually owed", () => {
  const rows = [
    row({ round: 1, claimable: 100n }),
    row({ round: 2, claimable: 0n, claimed: false }),
    row({ round: 3, claimable: 0n, claimed: true }),
    row({ round: 4, claimable: 50n }),
  ];
  assert.equal(totalUnclaimed(rows), 150n, "a nothing-owed round must not inflate the figure");
});

test("an archived entry is still owed — archival is about storage, not about the money", () => {
  const r = row({ claimable: 7n, archived: true });
  assert.equal(claimState(r), "claimable");
  assert.equal(totalUnclaimed([r]), 7n);
});
