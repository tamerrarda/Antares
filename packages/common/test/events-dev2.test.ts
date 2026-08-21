/**
 * The five events DEV2 emits, decoded.
 *
 * A separate file from `common.test.ts` on purpose. `events.ts` invites each developer to register
 * their own events in it — *"DEV1's and DEV2's remaining events are theirs to register, in this
 * file"* — and the registrations are therefore shared, but the tests need not be: two people
 * appending to one test file collide, and this project has already spent a merge on that.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decodableEventNames,
  decodeEvent,
  EventDecodeError,
  hasRound,
  isTerminal,
  type EpochUnresolved,
  type EpochVoided,
  type RawEvent,
  type Settled,
} from "../events.ts";

const SETTLED: RawEvent = {
  topics: ["settled", 7],
  txHash: "tx-settled",
  ledger: 100,
  data: {
    spot: 1_700_000n,
    strike: 1_600_000n,
    notional_sold: 5_000_000_000n,
    payout_total: 294_117_647n,
    premium: 200_000_000n,
    fee: 0n,
    pps: 10_100_000n,
    wclaims: 0n,
  },
};

const VOIDED: RawEvent = {
  topics: ["epoch_voided", 9],
  txHash: "tx-voided",
  ledger: 101,
  data: { reason: "FeedUnusable", premium_refunded: 200_000_000n, pps: 10_000_000n, wclaims: 0n },
};

const UNRESOLVED: RawEvent = {
  topics: ["epoch_unresolved", 11],
  txHash: "tx-unresolved",
  ledger: 102,
  data: {
    premium_retained: 200_000_000n,
    fee: 5_000_000n,
    pps: 10_200_000n,
    wclaims: 0n,
    oracle_answered: false,
  },
};

test("all five are registered", () => {
  const names = decodableEventNames();
  for (const n of ["settled", "epoch_voided", "epoch_unresolved", "fee_accrued", "settle_bounty"]) {
    assert.ok(names.includes(n), `${n} must decode; an unregistered event throws, which is data loss`);
  }
});

test("settled carries every field the round record is rebuilt from", () => {
  const ev = decodeEvent(SETTLED) as Settled;
  assert.equal(ev.name, "settled");
  assert.equal(ev.round, 7);
  // `spot` is the median TWAP over the windows ending at expiry, not the price at close — the
  // property that makes every caller produce the same settlement (D-40).
  assert.equal(ev.spot, 1_700_000n);
  assert.equal(ev.payoutTotal, 294_117_647n);
  assert.equal(ev.pps, 10_100_000n);
  assert.ok(hasRound(ev));
  assert.ok(isTerminal(ev));
});

test("the void reason survives, because the two reasons are not interchangeable", () => {
  // D-60 exists because `FeedUnusable` and `InvalidPrice` mean different things about the feed. A
  // decoder that dropped the tag would leave an indexer unable to say why a round was annulled.
  const ev = decodeEvent(VOIDED) as EpochVoided;
  assert.equal(ev.reason, "FeedUnusable");
  assert.equal(ev.premiumRefunded, 200_000_000n);

  const other = decodeEvent({ ...VOIDED, data: { ...(VOIDED.data as object), reason: "InvalidPrice" } });
  assert.equal((other as EpochVoided).reason, "InvalidPrice");
});

test("an unknown void reason throws rather than decoding to undefined", () => {
  // A reason that decodes to nothing is worse than one that fails to decode: the first is a silent
  // gap in the record, the second is a visible one.
  assert.throws(
    () => decodeEvent({ ...VOIDED, data: { ...(VOIDED.data as object), reason: "Whatever" } }),
    EventDecodeError,
  );
});

test("a payloaded enum shape decodes too, since only VoidReason happens to be bare today", () => {
  // `scValToNative` renders a unit variant as a bare string and a payloaded one as ["Tag", …]. A
  // decoder that assumed one shape would return undefined for the other the day a variant gains a
  // field, and §10 is a frozen ABI where "invisible today" is not "addable later".
  const ev = decodeEvent({ ...VOIDED, data: { ...(VOIDED.data as object), reason: ["InvalidPrice"] } });
  assert.equal((ev as EpochVoided).reason, "InvalidPrice");
});

test("oracle_answered distinguishes D-64's two entrances", () => {
  // false: the clock alone resolved the round with no oracle call. true: the adapter answered
  // OutOfReach. It enters no computation and is the only record of which happened.
  const clock = decodeEvent(UNRESOLVED) as EpochUnresolved;
  assert.equal(clock.oracleAnswered, false);
  const answered = decodeEvent({
    ...UNRESOLVED,
    data: { ...(UNRESOLVED.data as object), oracle_answered: true },
  }) as EpochUnresolved;
  assert.equal(answered.oracleAnswered, true);
});

test("a missing oracle_answered throws rather than defaulting to false", () => {
  // Defaulting would report "the clock resolved it" for every malformed event — the more alarming
  // of the two readings, asserted as absent rather than assumed.
  const { oracle_answered: _drop, ...rest } = UNRESOLVED.data as Record<string, unknown>;
  assert.throws(() => decodeEvent({ ...UNRESOLVED, data: rest }), EventDecodeError);
});

test("fee_accrued and settle_bounty decode, and the bounty names its recipient", () => {
  const fee = decodeEvent({
    topics: ["fee_accrued", 7],
    data: { amount: 5_000_000n },
    txHash: "t",
    ledger: 1,
  });
  assert.equal(fee.name, "fee_accrued");
  assert.ok(hasRound(fee));

  const bounty = decodeEvent({
    topics: ["settle_bounty", 7],
    data: { to: "GKEEPER", amount: 500_000n },
    txHash: "t",
    ledger: 1,
  });
  assert.equal(bounty.name, "settle_bounty");
  assert.ok("to" in bounty && bounty.to === "GKEEPER");
});

test("exactly one terminal event exists per closed round, and the payments are not terminal", () => {
  // I10 in the indexer's vocabulary: settled / voided / unresolved / lapsed partition a round's
  // ending, and fee_accrued and settle_bounty ride alongside rather than being outcomes of their
  // own. The lapse is asserted with the other three in common.test.ts, where its decoder lives.
  assert.ok(isTerminal(decodeEvent(SETTLED)));
  assert.ok(isTerminal(decodeEvent(VOIDED)));
  assert.ok(isTerminal(decodeEvent(UNRESOLVED)));
  assert.ok(
    !isTerminal(decodeEvent({ topics: ["fee_accrued", 7], data: { amount: 1n }, txHash: "t", ledger: 1 })),
  );
  assert.ok(
    !isTerminal(
      decodeEvent({ topics: ["settle_bounty", 7], data: { to: "G", amount: 1n }, txHash: "t", ledger: 1 }),
    ),
  );
});
