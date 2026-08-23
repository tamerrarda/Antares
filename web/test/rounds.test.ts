/**
 * The fold that produces the round history, and with it the vault's public record.
 *
 * The Rounds page's whole claim is that nothing on it is computed by a server this project runs —
 * every field comes from an event the contract emitted. That claim is only worth anything if the
 * fold is right, and a fold is exactly the kind of code that is wrong quietly: a premium summed
 * where it should be replaced, a terminal event that loses its transaction, a round shown as still
 * running because its ending arrived in an event the reducer forgot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { VaultEvent } from "../lib/events.ts";
import { foldRounds, OUTCOME_LABEL } from "../lib/rounds.ts";

const at = new Date("2026-08-21T12:00:00Z");
const ev = (decoded: VaultEvent["decoded"], txHash = "tx"): VaultEvent => ({
  decoded,
  txHash,
  ledger: 1,
  at,
});

const opened = (round: number) =>
  ev({
    name: "epoch_opened",
    round,
    strike: 2_126_950n,
    expiry: 1_800_000_000,
    openedAt: 1_799_000_000,
    auctionEnd: 1_799_002_700,
    notionalOffered: 100_000_000n,
    openTwap: 2_065_000n,
    premiumStartBps: 450,
    premiumFloorBps: 40,
  });

const filled = (round: number, premium: bigint, soldAfter: bigint, bidder: string) =>
  ev({
    name: "bid_filled",
    round,
    bidder,
    notional: soldAfter,
    premiumBps: 90,
    premium,
    notionalSoldAfter: soldAfter,
  });

test("two fills in one round sum their premiums but do NOT sum the notional sold", () => {
  // `notionalSoldAfter` is a running total the contract already computed. Adding them would double
  // count and report a round as having sold more than it offered.
  const rounds = foldRounds([
    opened(3),
    filled(3, 1_000n, 40_000_000n, "A"),
    filled(3, 1_500n, 100_000_000n, "B"),
  ]);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.premium, 2_500n, "premiums accumulate");
  assert.equal(rounds[0]!.notionalSold, 100_000_000n, "the sold figure is the last running total");
  assert.equal(rounds[0]!.bidders, 2);
});

test("the same bidder filling twice is one bidder", () => {
  const rounds = foldRounds([opened(4), filled(4, 10n, 10n, "A"), filled(4, 10n, 20n, "A")]);
  assert.equal(rounds[0]!.bidders, 1);
});

test("each terminal event sets its outcome and keeps the transaction that ended the round", () => {
  const cases = [
    [
      {
        name: "settled",
        round: 1,
        spot: 2_200_000n,
        strike: 2_126_950n,
        notionalSold: 1n,
        payoutTotal: 77n,
        premium: 5n,
        fee: 0n,
        pps: 9_900_000n,
        wclaims: 0n,
      },
      "settled",
      "Settled",
    ],
    [
      { name: "epoch_lapsed", round: 1, notionalOffered: 1n, pps: 10_000_000n, wclaims: 0n },
      "lapsed",
      "No buyer",
    ],
    [
      {
        name: "epoch_voided",
        round: 1,
        reason: "FeedUnusable",
        premiumRefunded: 5n,
        pps: 10_000_000n,
        wclaims: 0n,
      },
      "voided",
      "Annulled",
    ],
    [
      {
        name: "epoch_unresolved",
        round: 1,
        premiumRetained: 5n,
        fee: 0n,
        pps: 10_000_000n,
        wclaims: 0n,
        oracleAnswered: false,
      },
      "unresolved",
      "Unresolved",
    ],
  ] as const;

  for (const [decoded, outcome, label] of cases) {
    const r = foldRounds([opened(1), ev(decoded, "ending")])[0]!;
    assert.equal(r.outcome, outcome);
    assert.equal(OUTCOME_LABEL[r.outcome], label);
    assert.equal(r.terminalTx, "ending", `${outcome} must keep its own transaction, not the opening one`);
    assert.equal(r.ppsAfter, decoded.pps);
  }
});

test("a settled round records what was paid out; an annulled one records what went back", () => {
  const settled = foldRounds([
    opened(1),
    ev({
      name: "settled",
      round: 1,
      spot: 2_200_000n,
      strike: 2_126_950n,
      notionalSold: 1n,
      payoutTotal: 77n,
      premium: 5n,
      fee: 0n,
      pps: 9n,
      wclaims: 0n,
    }),
  ])[0]!;
  assert.equal(settled.payout, 77n);
  assert.equal(settled.refunded, null, "a settled round refunds nothing");

  const voided = foldRounds([
    opened(1),
    ev({
      name: "epoch_voided",
      round: 1,
      reason: "InvalidPrice",
      premiumRefunded: 42n,
      pps: 9n,
      wclaims: 0n,
    }),
  ])[0]!;
  assert.equal(voided.refunded, 42n);
  assert.equal(voided.payout, null, "an annulled round pays out nothing");
});

test("a round with no ending yet is running, not silently closed", () => {
  const r = foldRounds([opened(7), filled(7, 5n, 5n, "A")])[0]!;
  assert.equal(r.outcome, "running");
  assert.equal(r.terminalTx, null);
});

test("a round whose opening fell outside the window still appears, with what is known", () => {
  // The RPC keeps seven days. A round that ended inside the window but opened before it has no
  // `epoch_opened` to fold — dropping it would report absence where there is only distance.
  const r = foldRounds([
    ev({ name: "epoch_lapsed", round: 2, notionalOffered: 1n, pps: 10_000_000n, wclaims: 0n }),
  ])[0]!;
  assert.equal(r.round, 2);
  assert.equal(r.outcome, "lapsed");
  assert.equal(r.openedAt, null, "unknown, and null rather than invented");
  assert.equal(r.strike, null);
});

test("rounds come back newest first, whatever order the events arrived in", () => {
  const rounds = foldRounds([opened(1), opened(3), opened(2)]);
  assert.deepEqual(
    rounds.map((r) => r.round),
    [3, 2, 1],
  );
});

test("an event that merely mentions a round does not create one", () => {
  // A deposit carries a round number but says nothing about the round AS a round — no terms, no
  // ending, no price. Folding it into a row would put a line on the history page with every field
  // empty and "Running" beside it, which reads as a round in progress rather than as no information.
  const rounds = foldRounds([
    ev({ name: "deposited", round: 1, user: "A", amount: 1n, sharesMinted: 1n, instant: true }),
  ]);
  assert.deepEqual(rounds, [], "only a round's own terms or its ending put it on the record");
});
