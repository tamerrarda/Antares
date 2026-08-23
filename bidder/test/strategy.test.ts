/**
 * Tests for the bid decision.
 *
 * Every rule in `decide` is a reason **not** to send, and each one exists because sending would
 * either lose money or spend a fee to be told something a read already said. So the tests are
 * mostly about refusals, and each names which of the two it is protecting.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decide, flatStrategy, type AuctionView, type Portfolio, type RiskCaps } from "../strategy.ts";

const XLM = 10_000_000n;

const view: AuctionView = {
  round: 4,
  phase: "Auction",
  currentPremiumBps: 80,
  notionalOffered: 1_000n * XLM,
  notionalSold: 0n,
  minFill: 100n * XLM,
};

const caps: RiskCaps = { maxNotional: 400n * XLM, maxPortfolioNotional: 900n * XLM };
const empty: Portfolio = { openNotional: 0n };
const strategy = flatStrategy(100);

const decision = (
  over: Partial<AuctionView> = {},
  c: RiskCaps = caps,
  p: Portfolio = empty,
  allowed = true,
) => decide({ ...view, ...over }, c, p, strategy, allowed);

test("bids the per-round cap when the curve has come down to the target", () => {
  const d = decision();
  assert.deepEqual(d, { kind: "bid", notional: 400n * XLM, maxPremiumBps: 100 });
});

test("bids at the target, not at the rate it observed", () => {
  // `max_premium_bps` is the bidder's own argument and is identical at simulation and execution
  // (D-84). Sending the observed rate would pin the bid to a number that was true one ledger ago.
  const d = decision({ currentPremiumBps: 42 });
  assert.equal(d.kind === "bid" && d.maxPremiumBps, 100);
});

test("waits while the curve is still above the target — patience, not rejection", () => {
  const d = decision({ currentPremiumBps: 101 });
  assert.equal(d.kind, "wait");
  assert.match(d.kind === "wait" ? d.why : "", /above the 100 bps target/);
});

test("refuses on its own when the allowlist excludes it, rather than paying to be refused", () => {
  const d = decision({}, caps, empty, false);
  assert.equal(d.kind, "wait");
  assert.match(d.kind === "wait" ? d.why : "", /allowlist/);
});

test("does not bid outside the Auction phase", () => {
  for (const phase of ["Idle", "Active"] as const) {
    assert.equal(decision({ phase }).kind, "wait");
  }
});

test("treats a zero rate as a closed window, which is also the one rate that can never fill", () => {
  // `premium_bps` returns 0 outside the window, and a fill whose premium rounds to nothing is
  // refused as `ZeroPremium`. Both readings forbid sending.
  const d = decision({ currentPremiumBps: 0 });
  assert.equal(d.kind, "wait");
  assert.match(d.kind === "wait" ? d.why : "", /window is closed/);
});

test("takes only what is left when the round is nearly sold", () => {
  const d = decision({ notionalSold: 800n * XLM });
  assert.deepEqual(d, { kind: "bid", notional: 200n * XLM, maxPremiumBps: 100 });
});

test("waits when the round is fully sold", () => {
  assert.equal(decision({ notionalSold: 1_000n * XLM }).kind, "wait");
});

test("the portfolio cap bounds the size, not just the per-round cap", () => {
  // 900 XLM of headroom minus 750 already held leaves 150, which is under the 400 per-round cap.
  const d = decision({}, caps, { openNotional: 750n * XLM });
  assert.deepEqual(d, { kind: "bid", notional: 150n * XLM, maxPremiumBps: 100 });
});

test("waits when the portfolio cap is already reached", () => {
  const d = decision({}, caps, { openNotional: 900n * XLM });
  assert.equal(d.kind, "wait");
  assert.match(d.kind === "wait" ? d.why : "", /portfolio cap/);
});

test("refuses a size under the minimum fill that would not clear the round", () => {
  // The contract rejects this as `BelowMinFill`. Sending it spends a fee to be told so.
  const d = decision({}, { maxNotional: 50n * XLM, maxPortfolioNotional: 900n * XLM });
  assert.equal(d.kind, "wait");
  assert.match(d.kind === "wait" ? d.why : "", /below the .* minimum fill/);
});

test("but takes a remainder under the minimum fill, which is the sliver the contract allows", () => {
  // `filled < min_fill` is legal when `filled == remaining`, and the sliver is fillable by anyone —
  // refusing it here would leave dust nobody clears.
  const d = decision({ notionalSold: 950n * XLM });
  assert.deepEqual(d, { kind: "bid", notional: 50n * XLM, maxPremiumBps: 100 });
});

test("the strategy cannot reach the risk caps", () => {
  // The seam is pricing only. A strategy that could raise its own limit is a strategy that can lose
  // more than its operator agreed to, so `targetBps` sees the auction and nothing else.
  const seen: unknown[] = [];
  const spy = {
    name: "spy",
    targetBps: (v: AuctionView) => {
      seen.push(v);
      return 100;
    },
  };
  decide(view, caps, { openNotional: 1n }, spy, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0] as object).sort(), Object.keys(view).sort());
});
