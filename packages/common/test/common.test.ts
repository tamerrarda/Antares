/**
 * `@antares/common`'s unit inventory.
 *
 * `DEV-PROTOCOL.md` §6: a section is not done until *"every guard has a test that drives it to
 * reject"*. DEV2's line after the grep failure is the standard held here — **a gate only ever
 * verified in the passing direction is a gate nobody has tested** — so every throw below is
 * asserted, not just the happy paths.
 *
 * Run: `node --experimental-strip-types --test test/*.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAINNET_ENABLED,
  NETWORK_NAMES,
  NetworkConfigError,
  explorerTxUrl,
  isNetworkName,
  networkConfig,
  resolveNetwork,
  resolveRpcUrl,
} from "../networks.ts";
import {
  DeploymentNotFoundError,
  allVaultIds,
  deploymentPath,
  instanceBySuffix,
  loadDeployment,
  type DeploymentRecord,
} from "../deployments.ts";
import {
  EventDecodeError,
  curveInputs,
  decodableEventNames,
  decodeEvent,
  eventName,
  hasRound,
  type EpochOpened,
  type RawEvent,
} from "../events.ts";
import { ConsecutiveFailures, DEFAULT_ALERT_AFTER, DEFAULT_MAX_DELAY_MS, withBackoff } from "../retry.ts";
import { Logger, formatStroops, scrub } from "../logging.ts";

// =================================================================================================
// networks.ts
// =================================================================================================

test("the two known networks and nothing else", () => {
  assert.deepEqual([...NETWORK_NAMES], ["testnet", "mainnet"]);
  assert.ok(isNetworkName("testnet"));
  assert.ok(!isNetworkName("futurenet"));
});

/**
 * **These assertions deliberately do not restate the passphrase, and the check is why.**
 *
 * The first run of `network-agnostic-ts.sh` against real code rejected this file: it carried
 * `assert.equal(net.networkPassphrase, "Test SDF Network ; September 2015")`. The check was right and
 * the test was wrong. A test that repeats the value is a **second home** for it — exactly what
 * 06-TEST-PLAN §8 exists to forbid — and it does not even catch what it looks like it catches: a wrong
 * passphrase written into `networks.ts` and copied into its own test is wrong in both places, by the
 * same author, in the same sitting.
 *
 * What actually verifies the value is a live network: `verify-environment.ts` (D-49) talks to testnet,
 * and no transaction signed with a wrong passphrase is ever accepted. So the *value* is checked against
 * reality and the *behaviour* is checked here.
 */
test("testnet resolves to a complete, well-formed network row", () => {
  const net = resolveNetwork({ NETWORK: "testnet" });
  assert.equal(net.name, "testnet");
  assert.ok(net.rpcUrl.startsWith("https://"), "the endpoint is https");
  assert.ok(net.networkPassphrase.length > 0, "a passphrase is present");
  assert.ok(net.explorerTxBase.startsWith("https://"), "the Rounds page and WALKTHROUGH.md need this");
  assert.ok(net.explorerContractBase.startsWith("https://"));
});

test("REJECT: NETWORK unset — there is deliberately no default", () => {
  assert.throws(() => resolveNetwork({}), NetworkConfigError);
  assert.throws(() => resolveNetwork({ NETWORK: "" }), NetworkConfigError);
});

test("REJECT: an unknown network name", () => {
  assert.throws(() => resolveNetwork({ NETWORK: "futurenet" }), NetworkConfigError);
});

test("REJECT: mainnet, through every door — the gate is one constant and this is its rejecting test", () => {
  // If MAINNET_ENABLED is ever flipped, this test fails and forces the reviewer to look at it.
  // That is the intent: the gate's own test must not pass silently once the gate is open.
  assert.equal(MAINNET_ENABLED, false, "mainnet is gated on the audit (09-DEPLOYMENT §1)");
  assert.throws(() => resolveNetwork({ NETWORK: "mainnet" }), NetworkConfigError);
  assert.throws(() => networkConfig("mainnet"), NetworkConfigError);
});

test("RPC_URL overrides the endpoint; the passphrase has no override at all", () => {
  const net = resolveNetwork({ NETWORK: "testnet" });
  const original = net.networkPassphrase;

  assert.equal(resolveRpcUrl(net, {}), net.rpcUrl, "no override leaves the table's endpoint");
  assert.equal(
    resolveRpcUrl(net, { RPC_URL: "http://localhost:8000/soroban/rpc" }),
    "http://localhost:8000/soroban/rpc",
    "pointing at another provider for the same network is ordinary operations",
  );

  // The asymmetry is the security-relevant half: an env-settable passphrase would let a process sign
  // for a *different network* while every other value still described this one. Asserted as "nothing
  // in the environment moves it" rather than by naming the value, which is the whole point of there
  // being one home for it.
  for (const hostile of ["NETWORK_PASSPHRASE", "PASSPHRASE", "STELLAR_NETWORK_PASSPHRASE"]) {
    const net2 = resolveNetwork({ NETWORK: "testnet", [hostile]: "anything at all" });
    assert.equal(net2.networkPassphrase, original, `${hostile} must not reach the passphrase`);
  }
});

test("explorer links are built from the network, not from a caller's literal", () => {
  const net = resolveNetwork({ NETWORK: "testnet" });
  assert.equal(explorerTxUrl(net, "abc123"), `${net.explorerTxBase}/abc123`);
});

// =================================================================================================
// deployments.ts
// =================================================================================================

const TESTNET = resolveNetwork({ NETWORK: "testnet" });

function writeRecord(record: unknown, filename = "testnet.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "antares-deploy-"));
  writeFileSync(join(dir, filename), JSON.stringify(record));
  return dir;
}

const VALID_RECORD: DeploymentRecord = {
  network: "testnet",
  deployedAt: "2026-08-19",
  deployerIdentity: "antares-deployer",
  assetId: "CXLMSAC",
  oracleId: "CADAPTER",
  oracleWasmHash: "deadbeef",
  instances: [
    {
      tokenSuffix: "A",
      vaultId: "CVAULTA",
      vaultWasmHash: "aaaa",
      params: { epoch_duration: 604800 },
      economicallyMeaningless: false,
    },
    {
      tokenSuffix: "B",
      vaultId: "CVAULTB",
      vaultWasmHash: "aaaa",
      params: { epoch_duration: 259200 },
      economicallyMeaningless: false,
    },
  ],
};

test("a valid record loads, and the plural is the easy path", () => {
  const dir = writeRecord(VALID_RECORD);
  const rec = loadDeployment(TESTNET, { DEPLOYMENTS_DIR: dir });
  assert.deepEqual([...allVaultIds(rec)], ["CVAULTA", "CVAULTB"]);
  assert.equal(instanceBySuffix(rec, "B").vaultId, "CVAULTB");
});

test("REJECT: no record at all — the ordinary case today, and the message names the step", () => {
  const dir = mkdtempSync(join(tmpdir(), "antares-empty-"));
  assert.throws(
    () => loadDeployment(TESTNET, { DEPLOYMENTS_DIR: dir }),
    (err: unknown) => err instanceof DeploymentNotFoundError && /09-DEPLOYMENT §2 step 6/.test(err.message),
  );
});

test("REJECT: a record whose declared network is not the one it was loaded as", () => {
  const dir = writeRecord({ ...VALID_RECORD, network: "mainnet" });
  assert.throws(() => loadDeployment(TESTNET, { DEPLOYMENTS_DIR: dir }), NetworkConfigError);
});

test("REJECT: a record missing a required field, one field at a time", () => {
  for (const field of ["deployedAt", "deployerIdentity", "assetId", "oracleId"]) {
    const broken: Record<string, unknown> = { ...VALID_RECORD };
    delete broken[field];
    const dir = writeRecord(broken);
    assert.throws(
      () => loadDeployment(TESTNET, { DEPLOYMENTS_DIR: dir }),
      (err: unknown) => err instanceof DeploymentNotFoundError && err.message.includes(field),
      `missing "${field}" must be rejected, and named`,
    );
  }
});

test("REJECT: a record with an empty instance set, and an unknown suffix", () => {
  const dir = writeRecord({ ...VALID_RECORD, instances: [] });
  assert.throws(() => loadDeployment(TESTNET, { DEPLOYMENTS_DIR: dir }), DeploymentNotFoundError);

  const ok = loadDeployment(TESTNET, { DEPLOYMENTS_DIR: writeRecord(VALID_RECORD) });
  assert.throws(() => instanceBySuffix(ok, "E"), DeploymentNotFoundError);
});

test("the default path is deployments/<network>.json at the repo root", () => {
  assert.match(deploymentPath("testnet", {}), /deployments\/testnet\.json$/);
});

// =================================================================================================
// events.ts — §10 is a frozen ABI, so a dropped field must be a failure, never a default
// =================================================================================================

const EPOCH_OPENED: RawEvent = {
  topics: ["epoch_opened", 7],
  data: {
    strike: 4_400_000n,
    expiry: 1_000_600,
    opened_at: 1_000_000,
    auction_end: 1_002_700,
    notional_offered: 100_000_0000000n,
    open_twap: 4_000_000n,
    premium_start_bps: 300,
    premium_floor_bps: 10,
  },
  txHash: "tx1",
  ledger: 42,
};

test("epoch_opened decodes, and every field survives", () => {
  const ev = decodeEvent(EPOCH_OPENED) as EpochOpened;
  assert.equal(ev.name, "epoch_opened");
  assert.equal(ev.round, 7);
  assert.equal(ev.strike, 4_400_000n);
  assert.equal(ev.premiumStartBps, 300);
  assert.equal(ev.premiumFloorBps, 10);
  assert.ok(hasRound(ev));
});

test("the curve's four inputs are recoverable from epoch_opened, auction_duration by subtraction", () => {
  const ev = decodeEvent(EPOCH_OPENED) as EpochOpened;
  const inputs = curveInputs(ev);
  // 05 §4's worked example runs at auction_duration = 2 700 (45 min); the payload carries no
  // duration field, so this is the derivation the claim in §10 actually rests on.
  assert.deepEqual(inputs, { startBps: 300, floorBps: 10, openedAt: 1_000_000, auctionDuration: 2_700 });
});

test("REJECT: an epoch_opened whose auction window is empty or inverted", () => {
  const bad: RawEvent = {
    ...EPOCH_OPENED,
    data: { ...(EPOCH_OPENED.data as object), auction_end: 1_000_000 },
  };
  assert.throws(() => curveInputs(decodeEvent(bad) as EpochOpened), EventDecodeError);
});

test("bid_filled decodes both topics and all four data fields", () => {
  const ev = decodeEvent({
    topics: ["bid_filled", 7, "GBIDDER"],
    data: {
      notional: 6_000_0000000n,
      premium_bps: 120,
      premium: 72_0000000n,
      notional_sold_after: 6_000_0000000n,
    },
    txHash: "tx2",
    ledger: 43,
  });
  assert.deepEqual(ev, {
    name: "bid_filled",
    round: 7,
    bidder: "GBIDDER",
    notional: 6_000_0000000n,
    premiumBps: 120,
    premium: 72_0000000n,
    notionalSoldAfter: 6_000_0000000n,
  });
});

test("fee_claimed carries a recipient and NO round — normative, not an omission", () => {
  const ev = decodeEvent({
    topics: ["fee_claimed", "GRECIPIENT"],
    data: { amount: 2_200_000n },
    txHash: "tx3",
    ledger: 44,
  });
  assert.deepEqual(ev, { name: "fee_claimed", recipient: "GRECIPIENT", amount: 2_200_000n });
  assert.ok(!hasRound(ev), "claim_fee spans rounds (§10), so nothing may read a round off it");
});

test("payout_claimed and refund_claimed both decode", () => {
  for (const name of ["payout_claimed", "refund_claimed"] as const) {
    const ev = decodeEvent({
      topics: [name, 7, "GBIDDER"],
      data: { amount: 720_0000000n },
      txHash: "t",
      ledger: 1,
    });
    assert.equal(ev.name, name);
    assert.equal((ev as { amount: bigint }).amount, 720_0000000n);
  }
});

test("REJECT: an unregistered event name throws rather than being skipped", () => {
  // Skipping is data loss dressed as tolerance: an indexer that ignores what it does not know
  // reports a consistent view of an incomplete history (08-OFFCHAIN §1).
  //
  // The fixture was `settled` — DEV2's, and unregistered when this was written. Registering it
  // turned this test red, which is the right kind of failure and the wrong place for it: the rule
  // under test is about *unknown* names, not about which are outstanding today. So the fixture is a
  // name that is not an event and never will be, and the assertion below states that requirement
  // rather than leaving the next registration to rediscover it.
  const NEVER_AN_EVENT = "not_an_event";
  assert.throws(
    () => decodeEvent({ topics: [NEVER_AN_EVENT, 7], data: {}, txHash: "t", ledger: 1 }),
    (err: unknown) => err instanceof EventDecodeError && /no decoder registered/.test(err.message),
  );
  assert.ok(
    !decodableEventNames().includes(NEVER_AN_EVENT),
    "this fixture must never name a real event, or the next developer to register theirs breaks it",
  );
});

test("REJECT: a missing data field, a non-integer amount, and a truncated topic list", () => {
  const base = EPOCH_OPENED.data as Record<string, unknown>;
  const { strike: _dropped, ...withoutStrike } = base;
  assert.throws(() => decodeEvent({ ...EPOCH_OPENED, data: withoutStrike }), EventDecodeError);
  assert.throws(() => decodeEvent({ ...EPOCH_OPENED, data: { ...base, strike: 4.4 } }), EventDecodeError);
  assert.throws(() => decodeEvent({ ...EPOCH_OPENED, topics: ["epoch_opened"] }), EventDecodeError);
  assert.throws(() => decodeEvent({ ...EPOCH_OPENED, data: null }), EventDecodeError);
  assert.throws(() => eventName({ ...EPOCH_OPENED, topics: [] }), EventDecodeError);
});

test("REJECT: bid_filled without its bidder topic", () => {
  assert.throws(
    () =>
      decodeEvent({
        topics: ["bid_filled", 7],
        data: { notional: 1n, premium_bps: 1, premium: 1n, notional_sold_after: 1n },
        txHash: "t",
        ledger: 1,
      }),
    EventDecodeError,
  );
});

// =================================================================================================
// retry.ts
// =================================================================================================

test("withBackoff returns on the first success without sleeping", async () => {
  let slept = 0;
  const out = await withBackoff(async () => "ok", { sleep: async () => void (slept += 1) });
  assert.equal(out, "ok");
  assert.equal(slept, 0);
});

test("withBackoff retries, then succeeds", async () => {
  let calls = 0;
  const delays: number[] = [];
  const out = await withBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return calls;
    },
    { initialDelayMs: 100, factor: 2, random: () => 1, sleep: async (ms) => void delays.push(ms) },
  );
  assert.equal(out, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("REJECT: exhausted attempts rethrow the last error", async () => {
  await assert.rejects(
    withBackoff(
      async () => {
        throw new Error("always");
      },
      { attempts: 3, initialDelayMs: 1, sleep: async () => {} },
    ),
    /always/,
  );
});

test("REJECT: a non-retryable error stops immediately — no sleeps at all", async () => {
  let slept = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        throw new Error("permanent");
      },
      { attempts: 5, isRetryable: () => false, sleep: async () => void (slept += 1) },
    ),
    /permanent/,
  );
  assert.equal(slept, 0, "a retry loop that cannot be told 'never' turns one error into five");
});

test("the delay is capped at ten minutes — 08-OFFCHAIN §1's number, asserted", async () => {
  const delays: number[] = [];
  await assert.rejects(
    withBackoff(
      async () => {
        throw new Error("x");
      },
      {
        attempts: 12,
        initialDelayMs: 1_000,
        factor: 4,
        random: () => 1,
        sleep: async (ms) => void delays.push(ms),
      },
    ),
  );
  assert.equal(DEFAULT_MAX_DELAY_MS, 600_000);
  assert.ok(Math.max(...delays) <= DEFAULT_MAX_DELAY_MS, `capped, got ${Math.max(...delays)}`);
  assert.ok(delays.at(-1) === DEFAULT_MAX_DELAY_MS, "and it actually reaches the cap in this schedule");
});

test("full jitter keeps five instances off one schedule", async () => {
  const delays: number[] = [];
  await assert.rejects(
    withBackoff(
      async () => {
        throw new Error("x");
      },
      { attempts: 2, initialDelayMs: 1_000, random: () => 0, sleep: async (ms) => void delays.push(ms) },
    ),
  );
  assert.deepEqual(delays, [500], "random()=0 must give delay/2, not delay");
});

test("ConsecutiveFailures alerts once per streak and a success resets it", () => {
  const c = new ConsecutiveFailures("close_round");
  assert.equal(DEFAULT_ALERT_AFTER, 3);
  assert.equal(c.fail(), false);
  assert.equal(c.fail(), false);
  assert.equal(c.fail(), true, "third consecutive failure alerts (08-OFFCHAIN §1)");
  assert.equal(c.fail(), false, "and stays quiet — a channel that re-fires every pass gets muted");
  assert.equal(c.count, 4);
  c.succeed();
  assert.equal(c.count, 0);
  assert.equal(c.fail(), false);
  assert.equal(c.fail(), false);
  assert.equal(c.fail(), true, "a fresh streak alerts again");
});

test("success noise resets the streak — WrongPhase must not alert", () => {
  // 08-OFFCHAIN §1: WrongPhase means somebody else did it first, which is expected on a
  // permissionless function. Counting it would make a healthy, busy vault alert.
  const c = new ConsecutiveFailures("open_epoch");
  c.fail();
  c.fail();
  c.succeed();
  assert.equal(c.fail(), false, "two real failures either side of success noise must not alert");
});

test("REJECT: nonsensical retry configuration", async () => {
  await assert.rejects(
    withBackoff(async () => 1, { attempts: 0 }),
    RangeError,
  );
  assert.throws(() => new ConsecutiveFailures("x", 0), RangeError);
});

// =================================================================================================
// logging.ts
// =================================================================================================

test("stroops format without ever touching a float", () => {
  assert.equal(formatStroops(0n), "0");
  assert.equal(formatStroops(10_000_000n), "1");
  assert.equal(formatStroops(2_200_000n), "0.22"); // 05 §4's bounty
  assert.equal(formatStroops(88_877_800_000n), "8887.78"); // 05 §4's assets_R
  assert.equal(formatStroops(100_000_0000000n), "100000"); // the deposit cap
  assert.equal(formatStroops(-1n), "-0.0000001");
  assert.equal(formatStroops(1n), "0.0000001");
});

test("scrub redacts credential-shaped keys and renders bigint as a string", () => {
  const out = scrub({
    amount: 72_0000000n,
    secretKey: "SABC",
    signerIdentity: "keeper-throwaway",
    nested: { password: "hunter2", ok: 1 },
  }) as Record<string, unknown>;
  assert.equal(out["amount"], "720000000");
  assert.equal(out["secretKey"], "[redacted]");
  assert.equal(out["signerIdentity"], "[redacted]");
  assert.deepEqual(out["nested"], { password: "[redacted]", ok: 1 });
});

test("a log line is one JSON object, and a bigint in it does not throw", () => {
  const lines: string[] = [];
  const log = new Logger({
    level: "debug",
    sink: (l) => lines.push(l),
    now: () => "2026-08-19T00:00:00.000Z",
  });
  log.child({ instance: "aXLM-A" }).info("filled", { premium: 72_0000000n, seed: "SNEVER" });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] as string), {
    ts: "2026-08-19T00:00:00.000Z",
    level: "info",
    msg: "filled",
    instance: "aXLM-A",
    premium: "720000000",
    seed: "[redacted]",
  });
});

test("level filtering drops below-threshold lines, and REJECT: an unknown level", () => {
  const lines: string[] = [];
  const log = new Logger({ level: "warn", sink: (l) => lines.push(l) });
  log.debug("no");
  log.info("no");
  log.warn("yes");
  log.error("yes");
  assert.equal(lines.length, 2);
  assert.throws(() => new Logger({ level: "trace" as never }), RangeError);
});

// ---------------------------------------------------------------- deposited ----
//
// DEV1's, registered 2026-08-20. The sweep's roster derives from the event shape,
// so depositors join it the day the decoder lands — and depositors are the larger
// half of the users this protocol has.

const DEPOSITED: RawEvent = {
  topics: ["deposited", "GDEPOSITOR"],
  data: {
    round: 7,
    amount: 100_0000000n,
    shares_minted: 99_9999000n,
    instant: true,
  },
  txHash: "txd",
  ledger: 43,
};

test("deposited decodes both the instant and the pending shape", () => {
  const now = decodeEvent(DEPOSITED);
  assert.deepEqual(now, {
    name: "deposited",
    user: "GDEPOSITOR",
    round: 7,
    amount: 100_0000000n,
    sharesMinted: 99_9999000n,
    instant: true,
  });

  // The mid-round case: D-18 mints nothing while a round is live, so the pending
  // deposit reports `shares_minted: 0` and `instant: false`. A consumer that reads
  // this as a mint reports share balances that do not exist yet.
  const pending = decodeEvent({
    ...DEPOSITED,
    data: { ...(DEPOSITED.data as Record<string, unknown>), shares_minted: 0n, instant: false },
  });
  assert.equal((pending as { instant: boolean }).instant, false);
  assert.equal((pending as { sharesMinted: bigint }).sharesMinted, 0n);
});

test("REJECT: `instant` is decoded strictly, because a coerced boolean is a wrong answer", () => {
  // Not pedantry. `undefined` coerced to `false` turns "the depositor holds shares
  // now" into "they hold a pending claim", and both are plausible readings of a
  // real deposit — so the mistake would not look like one downstream.
  const base = DEPOSITED.data as Record<string, unknown>;
  const { instant: _dropped, ...withoutInstant } = base;
  assert.throws(() => decodeEvent({ ...DEPOSITED, data: withoutInstant }), EventDecodeError);
  assert.throws(() => decodeEvent({ ...DEPOSITED, data: { ...base, instant: 1 } }), EventDecodeError);
  assert.throws(() => decodeEvent({ ...DEPOSITED, data: { ...base, instant: "true" } }), EventDecodeError);
});

test("deposited is round-scoped, so the sweep's roster picks it up", () => {
  const ev = decodeEvent(DEPOSITED);
  assert.ok(hasRound(ev), "a deposit names the round it landed in (§10)");
  assert.ok(decodableEventNames().includes("deposited"));
});
