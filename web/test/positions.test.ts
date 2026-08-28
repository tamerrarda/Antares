/**
 * The total on "My positions", which was wrong on the deployed build and wrong quietly.
 *
 * It read `position.shares` alone, so an address whose deposit was still waiting for a live round
 * to end saw "0.0 XLM in 0 of 1 vault" and a row that said "no position" — on the page whose
 * subtitle promises to say where their money is, while the vault page announced the same balance at
 * the same moment. Measured against the live app on 2026-08-28.
 *
 * Every case below is the shape a real address is in at some point in an ordinary epoch, and the
 * waiting one is the *common* shape: a deposit made during a round cannot mint until it ends.
 */
import type { EpochInfo, Position } from "@antares/bindings";
import assert from "node:assert/strict";
import { test } from "node:test";

import { summarise, shareWorth, waitingWorth, type Holding } from "../lib/positions.ts";

/** `last_pps` is all `summarise` reads from the round; the rest is out of the way. */
const epoch = (pps: bigint): EpochInfo => ({ last_pps: pps }) as unknown as EpochInfo;

const holding = (shares: bigint, pending: bigint, pps = 10_245_384n): Holding => ({
  epoch: epoch(pps),
  position: { shares, pending_deposit: pending } as unknown as Position,
});

test("a deposit waiting on a live round is money, and is counted", () => {
  // The address measured on the deployed app: 2 999 XLM pending, no shares yet.
  const only = summarise([holding(0n, 29_990_000_000n)]);
  assert.equal(only.total, 29_990_000_000n, "the page said 0 for exactly this address");
  assert.equal(only.waiting, 29_990_000_000n);
  assert.equal(only.vaults, 1, "a vault holding your money is a vault you are in");
});

test("shares and a pending deposit are added, and the pending half stays named", () => {
  const both = summarise([holding(1_500_000_000n, 29_990_000_000n)]);
  // 1 500 000 000 shares at 1.0245384 = 1 536 807 600, plus 29 990 000 000 waiting.
  assert.equal(both.total, 1_536_807_600n + 29_990_000_000n);
  assert.equal(
    both.waiting,
    29_990_000_000n,
    "folding it into the total alone would hide the half that carries no risk",
  );
});

test("an address holding nothing is still reported as nothing", () => {
  const empty = summarise([holding(0n, 0n)]);
  assert.equal(empty.total, 0n);
  assert.equal(empty.vaults, 0);
});

test("a vault that did not answer contributes nothing rather than throwing", () => {
  const unread: Holding = { epoch: null, position: null };
  assert.equal(shareWorth(unread), 0n);
  assert.equal(waitingWorth(unread), 0n);
  assert.deepEqual(summarise([unread]), { total: 0n, waiting: 0n, vaults: 0 });
});

test("totals add across vaults", () => {
  const many = summarise([holding(0n, 29_990_000_000n), holding(0n, 87_220_000_000n), holding(0n, 0n)]);
  assert.equal(many.total, 117_210_000_000n);
  assert.equal(many.vaults, 2);
});
