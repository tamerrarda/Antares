/**
 * Tests for the events-only reconstruction and the diff it feeds.
 *
 * These run with no network and no deployment. That is the point rather than a convenience: the
 * live run in `scenario1.ts` can only ever exercise the paths a live round happens to take, and the
 * ones worth pinning are the refusals — a missing decoder, an internally inconsistent ABI, an
 * unclaimed credit — which a healthy round never produces.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { failedIds } from "@antares/common/checks";

import { diffAgainstEpoch, type ChainState } from "../diff.ts";
import {
  classifySkipped,
  DEAD_SHARES,
  phaseAt,
  reconstruct,
  STATE_AFFECTING_UNDECODED,
  type LocatedEvent,
} from "../reconstruct.ts";
import type { DecodedEvent } from "@antares/common/events";

let n = 0;
const at = (event: DecodedEvent): LocatedEvent => ({ event, txHash: `tx${(n += 1)}`, ledger: 100 + n });

const ALICE = "GALICE";
const BOB = "GBOB";

const opened = (over: Partial<Extract<DecodedEvent, { name: "epoch_opened" }>> = {}): LocatedEvent =>
  at({
    name: "epoch_opened",
    round: 1,
    strike: 175_000_000n,
    expiry: 1_700_000_600,
    openedAt: 1_700_000_000,
    auctionEnd: 1_700_000_020,
    notionalOffered: 1_000_000_000n,
    openTwap: 170_000_000n,
    premiumStartBps: 450,
    premiumFloorBps: 40,
    ...over,
  });

const fill = (bidder: string, notional: bigint, premium: bigint, soldAfter: bigint): LocatedEvent =>
  at({
    name: "bid_filled",
    round: 1,
    bidder,
    notional,
    premiumBps: 450,
    premium,
    notionalSoldAfter: soldAfter,
  });

const deposit = (amount: bigint, shares: bigint): LocatedEvent =>
  at({ name: "deposited", user: ALICE, round: 0, amount, sharesMinted: shares, instant: true });

const CHAIN: ChainState = {
  round: 1,
  phase: "Active",
  notionalOffered: 1_000_000_000n,
  notionalSold: 700_000_000n,
  premiumCollected: 31_500_000n,
  strike: 175_000_000n,
  openTwap: 170_000_000n,
  openedAt: 1_700_000_000,
  auctionEnd: 1_700_000_020,
  expiry: 1_700_000_600,
  sharesOutstanding: 10_000_000n,
  lastPps: 10_000_000n,
  // The deposit alone. The round is still OPEN, so its 31 500 000 of premium is held but belongs
  // to nobody yet — depositors on settle, the bidders back on void — and total_assets() excludes it.
  totalAssets: 10_000_000n,
  ledgerTime: 1_700_000_300,
};

// --- the fold ------------------------------------------------------------------------------------

test("a deposit and two partial fills reconstruct the round the chain reports", () => {
  const s = reconstruct([
    deposit(10_000_000n, 9_999_000n),
    opened(),
    fill(ALICE, 400_000_000n, 18_000_000n, 400_000_000n),
    fill(BOB, 300_000_000n, 13_500_000n, 700_000_000n),
  ]);

  assert.equal(s.round, 1);
  assert.equal(s.notionalSold, 700_000_000n);
  assert.equal(s.notionalSoldSummed, 700_000_000n);
  assert.equal(s.premiumCollected, 31_500_000n);
  // 9 999 000 credited + D-36's floor, which no event carries.
  assert.equal(s.sharesOutstanding, 9_999_000n + DEAD_SHARES);
  assert.equal(s.holdings, 10_000_000n + 31_500_000n);
  assert.equal(s.liabilities, 0n);
});

test("the dead-share floor is applied once, at the first mint, and declared as an assumption", () => {
  const first = reconstruct([deposit(10_000_000n, 9_999_000n)]);
  assert.equal(first.sharesOutstanding, 9_999_000n + DEAD_SHARES);
  assert.equal(first.assumptions.length, 1);
  assert.match(first.assumptions[0]!.what, /dead shares/);

  const second = reconstruct([deposit(5_000_000n, 5_000_000n)], [], first);
  assert.equal(second.sharesOutstanding, 9_999_000n + DEAD_SHARES + 5_000_000n);
  assert.equal(second.assumptions.length, 1, "the floor is paid for once, so it is claimed once");
});

test("a pending deposit mints nothing but the vault is still holding the capital", () => {
  const s = reconstruct([
    at({ name: "deposited", user: BOB, round: 1, amount: 7_000_000n, sharesMinted: 0n, instant: false }),
  ]);
  assert.equal(s.sharesOutstanding, 0n);
  assert.equal(s.holdings, 7_000_000n);
  assert.equal(s.assumptions.length, 0, "no mint happened, so D-36's floor is not claimed either");
});

test("an unclaimed credit nets out, and claiming it nets out again", () => {
  // The identity the diff rests on: a credit that has not been claimed appears in BOTH holdings and
  // liabilities, so `holdings - liabilities` cannot depend on which side of the line the contract
  // draws for it. If this ever stops holding, the model below it is wrong, not the vault.
  const base = reconstruct([
    deposit(10_000_000n, 9_999_000n),
    opened(),
    fill(ALICE, 400_000_000n, 18_000_000n, 400_000_000n),
  ]);
  const netBefore = base.holdings - base.liabilities;

  const settled = reconstruct(
    [
      at({
        name: "settled",
        round: 1,
        spot: 180_000_000n,
        strike: 175_000_000n,
        notionalSold: 400_000_000n,
        payoutTotal: 5_000_000n,
        premium: 18_000_000n,
        fee: 0n,
        pps: 10_100_000n,
        wclaims: 0n,
      }),
    ],
    [],
    base,
  );
  assert.equal(settled.holdings - settled.liabilities, netBefore - 5_000_000n);

  const claimed = reconstruct(
    [at({ name: "payout_claimed", round: 1, bidder: ALICE, amount: 5_000_000n })],
    [],
    settled,
  );
  assert.equal(
    claimed.holdings - claimed.liabilities,
    settled.holdings - settled.liabilities,
    "paying out a credit already recognised changes nothing net — it moves both terms together",
  );
  assert.equal(claimed.liabilities, 0n);
});

test("fee_accrued is not counted twice — settled.fee already carried it", () => {
  const base = reconstruct([
    at({
      name: "settled",
      round: 1,
      spot: 170_000_000n,
      strike: 175_000_000n,
      notionalSold: 400_000_000n,
      payoutTotal: 0n,
      premium: 18_000_000n,
      fee: 900_000n,
      pps: 10_100_000n,
      wclaims: 0n,
    }),
    at({ name: "fee_accrued", round: 1, amount: 900_000n }),
  ]);
  assert.equal(
    base.liabilities,
    900_000n,
    "§10 emits fee_accrued ALONGSIDE the terminal event, not instead of it",
  );
});

test("the settle bounty leaves the pool without ever having been a liability", () => {
  const s = reconstruct([at({ name: "settle_bounty", round: 1, to: BOB, amount: 250_000n })]);
  assert.equal(s.holdings, -250_000n);
  assert.equal(s.liabilities, 0n);
});

// --- phase ----------------------------------------------------------------------------------------

test("phase follows the ledger clock across a transition nothing emits", () => {
  const s = reconstruct([opened()]);
  assert.equal(phaseAt(s, 1_700_000_010), "Auction");
  assert.equal(phaseAt(s, 1_700_000_020), "Active", "auction_end is exclusive on the Auction side");
  assert.equal(phaseAt(s, 1_700_000_400), "Active");

  const closed = reconstruct(
    [
      at({
        name: "epoch_unresolved",
        round: 1,
        premiumRetained: 18_000_000n,
        fee: 0n,
        pps: 10_100_000n,
        wclaims: 0n,
        oracleAnswered: false,
      }),
    ],
    [],
    s,
  );
  assert.equal(phaseAt(closed, 1_700_000_999), "Idle");
  assert.equal(phaseAt(reconstruct([]), 1_700_000_999), "Idle", "a vault that never opened is Idle");
});

test("a lapsed round closes, credits the withdrawal queue, and moves nothing else", () => {
  // The empty auction. `lazy_finalize` only lapses when `notional_sold == 0`, so a lapse has no
  // payout, no fee and no premium to place — the withdrawal-queue credit is the only money that
  // moves, and `phaseAt` must call the vault Idle afterwards or an indexer will show a round that
  // is still open on a chain that has already moved on.
  const base = reconstruct([deposit(10_000_000n, 9_999_000n), opened()]);
  const lapsed = reconstruct(
    [
      at({
        name: "epoch_lapsed",
        round: 1,
        notionalOffered: 1_000_000_000n,
        pps: 10_000_000n,
        wclaims: 4_000_000n,
      }),
    ],
    [],
    base,
  );

  assert.equal(lapsed.closedBy, "epoch_lapsed");
  assert.equal(lapsed.lastPps, 10_000_000n);
  assert.equal(lapsed.liabilities, base.liabilities + 4_000_000n);
  assert.equal(lapsed.wclaimsOutstanding, base.wclaimsOutstanding + 4_000_000n);
  assert.equal(lapsed.holdings, base.holdings, "a lapse pays nobody, so nothing leaves the vault");
  assert.equal(lapsed.sharesOutstanding, base.sharesOutstanding);
  assert.equal(phaseAt(lapsed, 1_700_000_999), "Idle");
});

// --- the gap that decides whether any of it means anything -----------------------------------------

// A name no §10 event has and none will. The table is passed in as data because the real one is
// empty as of 2026-08-21, and naming a live event here would mean this test dies on the day
// somebody writes that event's decoder — the day the rule most needs to still hold.
const HYPOTHETICAL = { epoch_dissolved: "a finalization event that moves an amount" };

test("§10's SEP-41 mirror is skippable by the spec; a finalization event is not", () => {
  const { benign, blocking } = classifySkipped(["mint", "burn", "transfer", "epoch_dissolved"], HYPOTHETICAL);
  assert.deepEqual([...benign], ["mint", "burn", "transfer"]);
  assert.deepEqual(
    blocking.map((b) => b.name),
    ["epoch_dissolved"],
  );
});

test("the real table is empty, and every event that moves an amount is why", () => {
  // Not a tautology: this is the assertion that turns "we decoded them all" from a claim into a
  // check. `epoch_lapsed` was the last name on the list and came off on 2026-08-21; if a future
  // §10 event needs a decoder, putting it back here is the deliberate act the mechanism asks for.
  assert.deepEqual(Object.keys(STATE_AFFECTING_UNDECODED), []);
  assert.equal(classifySkipped(["epoch_lapsed"]).blocking.length, 0);
});

test("the withdrawal half is decodable now, so it no longer blocks a diff", () => {
  const { benign, blocking } = classifySkipped([
    "withdraw_requested",
    "withdraw_claimed",
    "pending_redeemed",
    "deposit_cancelled",
  ]);
  assert.equal(blocking.length, 0);
  assert.equal(benign.length, 4);
});

test("a withdrawal takes assets and shares out, and takes them out once", () => {
  const deposited = reconstruct([deposit(10_000_000n, 9_999_000n)]);
  const withdrawn = reconstruct(
    [
      at({ name: "withdraw_requested", user: ALICE, round: 0, shares: 9_999_000n }),
      at({ name: "withdraw_claimed", user: ALICE, round: 0, shares: 9_999_000n, amount: 9_999_000n }),
    ],
    [],
    deposited,
  );
  // Both events carry the same `shares` and §10 emits both in one transaction for an instant Idle
  // withdrawal, so counting both would halve the supply twice over.
  assert.equal(withdrawn.sharesOutstanding, DEAD_SHARES);
  assert.equal(withdrawn.holdings, 1_000n);
  assert.ok(
    withdrawn.assumptions.some((a) => /withdraw_claimed rather than at withdraw_requested/.test(a.what)),
  );
});

test("a cancelled pending deposit returns capital and mints nothing", () => {
  const s = reconstruct([
    at({ name: "deposited", user: BOB, round: 1, amount: 7_000_000n, sharesMinted: 0n, instant: false }),
    at({ name: "deposit_cancelled", user: BOB, round: 1, amount: 7_000_000n }),
  ]);
  assert.equal(s.holdings, 0n);
  assert.equal(s.sharesOutstanding, 0n);
});

test("a pending deposit redeemed later mints without moving capital again", () => {
  const s = reconstruct([
    at({ name: "deposited", user: BOB, round: 1, amount: 7_000_000n, sharesMinted: 0n, instant: false }),
    at({
      name: "pending_redeemed",
      user: BOB,
      round: 2,
      amount: 7_000_000n,
      shares: 6_930_000n,
      pps: 10_100_000n,
    }),
  ]);
  assert.equal(s.holdings, 7_000_000n, "the capital arrived at deposited and is not counted twice");
  assert.equal(s.sharesOutstanding, 6_930_000n);
});

test("an unrecognised name is reported rather than assumed harmless", () => {
  const { benign, blocking } = classifySkipped(["some_event_added_later"]);
  assert.deepEqual([...benign], ["some_event_added_later"]);
  assert.equal(blocking.length, 0);
});

test("a missing state-affecting decoder refuses the whole diff instead of reporting totals", () => {
  const s = reconstruct([deposit(10_000_000n, 9_999_000n), opened()], ["epoch_dissolved"]);
  const checks = diffAgainstEpoch(s, CHAIN, ["epoch_dissolved"], HYPOTHETICAL);
  assert.equal(checks.length, 1, "nothing is compared once a total has no defined meaning");
  assert.deepEqual(failedIds(checks), ["events.decoders_complete"]);
  assert.match(String(checks[0]!.note), /epoch_dissolved/);
});

// --- the diff ---------------------------------------------------------------------------------------

test("a faithful reconstruction agrees with the chain on every comparable field", () => {
  const s = reconstruct([
    deposit(10_000_000n, 10_000_000n - DEAD_SHARES),
    opened(),
    fill(ALICE, 400_000_000n, 18_000_000n, 400_000_000n),
    fill(BOB, 300_000_000n, 13_500_000n, 700_000_000n),
  ]);
  assert.deepEqual(failedIds(diffAgainstEpoch(s, CHAIN, ["mint", "transfer"])), []);
});

test("a contradiction inside bid_filled is caught without the chain being asked", () => {
  // Both sides come from §10, so this is a statement about the ABI. `epoch()` would agree with
  // itself under either value and could never surface it.
  const s = reconstruct([
    deposit(10_000_000n, 10_000_000n - DEAD_SHARES),
    opened(),
    fill(ALICE, 400_000_000n, 18_000_000n, 400_000_000n),
    fill(BOB, 299_999_999n, 13_500_000n, 700_000_000n),
  ]);
  assert.deepEqual(failedIds(diffAgainstEpoch(s, CHAIN)), ["events.notional_sold_self_consistent"]);
});

test("a share total short by the dead-share floor fails, and fails on the field that explains it", () => {
  // What an events-only indexer that had not read D-36 would produce.
  const s = reconstruct([
    deposit(10_000_000n, 10_000_000n - DEAD_SHARES),
    opened(),
    fill(ALICE, 400_000_000n, 18_000_000n, 400_000_000n),
    fill(BOB, 300_000_000n, 13_500_000n, 700_000_000n),
  ]);
  const naive = { ...s, sharesOutstanding: s.sharesOutstanding - DEAD_SHARES };
  const failed = failedIds(diffAgainstEpoch(naive, CHAIN));
  assert.deepEqual(failed, ["events.shares_outstanding"]);
});

test("pps is compared only once a round has closed", () => {
  const open = reconstruct([deposit(10_000_000n, 10_000_000n - DEAD_SHARES), opened()]);
  assert.equal(open.lastPps, null);
  assert.ok(!diffAgainstEpoch(open, CHAIN).some((c) => c.id === "events.last_pps"));
});

// --- the two terms the live chain taught this module, on 2026-08-21 -------------------------------

test("an instant withdrawal discharges no queue credit, because none was ever made", () => {
  // The deploy's own smoke round trip is exactly this shape, and the first version of the fold
  // subtracted from liabilities on every withdraw_claimed — driving them NEGATIVE by the whole
  // withdrawn amount and putting the reconstruction 9 999 000 stroops out against a live vault.
  const s = reconstruct([
    deposit(10_000_000n, 9_999_000n),
    at({ name: "withdraw_requested", user: ALICE, round: 0, shares: 9_999_000n }),
    at({ name: "withdraw_claimed", user: ALICE, round: 0, shares: 9_999_000n, amount: 9_999_000n }),
  ]);
  assert.equal(s.liabilities, 0n, "nothing credited it, so nothing is discharged");
  assert.equal(s.wclaimsOutstanding, 0n);
  assert.equal(s.holdings, 1_000n);
  assert.equal(s.holdings - s.liabilities - s.unsettledPremium, 1_000n);
});

test("a queued withdrawal DOES discharge the credit its finalization made", () => {
  const opened_ = reconstruct([deposit(100_000_000n, 99_999_000n), opened()]);
  const closed = reconstruct(
    [
      at({
        name: "settled",
        round: 1,
        spot: 170_000_000n,
        strike: 175_000_000n,
        notionalSold: 0n,
        payoutTotal: 0n,
        premium: 0n,
        fee: 0n,
        pps: 10_000_000n,
        wclaims: 4_000_000n,
      }),
    ],
    [],
    opened_,
  );
  assert.equal(closed.wclaimsOutstanding, 4_000_000n);
  assert.equal(closed.liabilities, 4_000_000n);

  const claimed = reconstruct(
    [at({ name: "withdraw_claimed", user: ALICE, round: 1, shares: 4_000_000n, amount: 4_000_000n })],
    [],
    closed,
  );
  assert.equal(claimed.liabilities, 0n, "the credit is discharged exactly once");
  assert.equal(claimed.wclaimsOutstanding, 0n);
});

test("premium from an open round is held but is not vault assets, and closing releases it", () => {
  const open = reconstruct([
    deposit(10_000_000n, 9_999_000n),
    opened(),
    fill(ALICE, 400_000_000n, 18_000_000n, 400_000_000n),
  ]);
  assert.equal(open.unsettledPremium, 18_000_000n);
  assert.equal(open.holdings - open.liabilities - open.unsettledPremium, 10_000_000n);

  const settled = reconstruct(
    [
      at({
        name: "settled",
        round: 1,
        spot: 170_000_000n,
        strike: 175_000_000n,
        notionalSold: 400_000_000n,
        payoutTotal: 0n,
        premium: 18_000_000n,
        fee: 0n,
        pps: 10_100_000n,
        wclaims: 0n,
      }),
    ],
    [],
    open,
  );
  assert.equal(settled.unsettledPremium, 0n);
  assert.equal(
    settled.holdings - settled.liabilities - settled.unsettledPremium,
    28_000_000n,
    "on settle the premium becomes depositors' assets",
  );
});

test("a voided round keeps the premium a debt rather than releasing it", () => {
  const open = reconstruct([
    deposit(10_000_000n, 9_999_000n),
    opened(),
    fill(ALICE, 400_000_000n, 18_000_000n, 400_000_000n),
  ]);
  const voided = reconstruct(
    [
      at({
        name: "epoch_voided",
        round: 1,
        reason: "FeedUnusable",
        premiumRefunded: 18_000_000n,
        pps: 10_000_000n,
        wclaims: 0n,
      }),
    ],
    [],
    open,
  );
  assert.equal(voided.unsettledPremium, 0n, "cleared as unsettled...");
  assert.equal(voided.liabilities, 18_000_000n, "...and re-entered as a named credit, never both");
  assert.equal(
    voided.holdings - voided.liabilities - voided.unsettledPremium,
    10_000_000n,
    "net is unchanged by a void — the premium was never depositors' money",
  );
});
