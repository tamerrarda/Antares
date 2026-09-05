/**
 * The three properties D-09 asks for, each asserted against the version that would be wrong.
 *
 * The point of a fake `VaultClient` here is not to avoid a network — it is that these rules are
 * about *what the keeper does with an answer*, and an integration test would prove them only for
 * whichever answers the chain happened to give that afternoon.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ConsecutiveFailures } from "@antares/common/retry";

import type { Alert, EpochView, VaultConfig } from "../decide.ts";
import { CODES } from "../errors.ts";
import { archivePass, loop, pass, type Sink, type VaultClient, type VaultReader } from "../runner.ts";

const NOW = 1_787_000_000;
const DAY = 86_400;

const VIEW: EpochView = {
  round: 4,
  phase: "Active",
  outcomePending: false,
  expiry: NOW - 60,
  nextOpenAt: NOW,
  epochDuration: 7 * DAY,
  unresolvedAfter: 75_600,
  openedAt: NOW - 7 * DAY,
  lastFinalizeTime: 0,
};

const contractError = (code: number) => new Error(`HostError: Error(Contract, #${code})`);

/**
 * No real sleeping. The backoff caps at ten minutes, so a suite that waits on it takes 52 seconds
 * to assert rules that have no time in them — measured, before this was injected.
 */
const NO_SLEEP = { sleep: () => Promise.resolve() };

interface Recorded {
  readonly debug: string[];
  readonly warn: string[];
  /** The structured half of a warning, where the cause lives. */
  readonly warnFields: (Record<string, unknown> | undefined)[];
  readonly info: string[];
  readonly alerts: Alert[];
}

function sink(): Sink & { recorded: Recorded } {
  const recorded: Recorded = { debug: [], warn: [], warnFields: [], info: [], alerts: [] };
  return {
    recorded,
    debug: (m) => recorded.debug.push(m),
    info: (m) => recorded.info.push(m),
    warn: (m, f) => {
      recorded.warn.push(m);
      recorded.warnFields.push(f);
    },
    alert: (a) => recorded.alerts.push(a),
  };
}

function client(over: Partial<VaultClient> & { submit?: VaultClient["submit"] } = {}): VaultClient {
  return {
    id: "CVAULT",
    epoch: () => Promise.resolve(VIEW),
    config: () => Promise.resolve<VaultConfig>({ paused: false }),
    feedExpiresAt: () => Promise.resolve(NOW + 400 * DAY),
    submit: () => Promise.resolve("tx-hash"),
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// WrongPhase is success-noise
// ---------------------------------------------------------------------------------------------

test("WrongPhase is debug noise and RESETS the streak", async () => {
  const s = sink();
  const failures = new ConsecutiveFailures("t");
  failures.fail();
  failures.fail();
  assert.equal(failures.count, 2, "a streak is in progress");

  const r = await pass(
    client({ submit: () => Promise.reject(contractError(CODES.WrongPhase)) }),
    failures,
    s,
    NOW,
    NO_SLEEP,
  );

  assert.equal(r.disposition?.kind, "benign");
  assert.equal(failures.count, 0, "somebody did the work; the operation succeeded");
  assert.equal(s.recorded.warn.length, 0, "a healthy vault with an active community loses races");
  assert.equal(s.recorded.alerts.length, 0);
  assert.ok(s.recorded.debug.some((d) => /was not needed/.test(d)));
});

test("three WrongPhase in a row never alert, however many there are", async () => {
  const s = sink();
  const failures = new ConsecutiveFailures("t");
  const c = client({ submit: () => Promise.reject(contractError(CODES.WrongPhase)) });
  for (let i = 0; i < 5; i++) await pass(c, failures, s, NOW, NO_SLEEP);
  assert.equal(s.recorded.alerts.length, 0, "this is the property the design is built on");
});

// ---------------------------------------------------------------------------------------------
// Oracle transients back off, and alert after three
// ---------------------------------------------------------------------------------------------

test("an oracle transient is retried and then counted, and the third one alerts", async () => {
  const s = sink();
  const failures = new ConsecutiveFailures("t");
  const c = client({ submit: () => Promise.reject(contractError(CODES.OracleUnreachable)) });

  await pass(c, failures, s, NOW, NO_SLEEP);
  await pass(c, failures, s, NOW, NO_SLEEP);
  assert.equal(s.recorded.alerts.length, 0, "two in a row is not yet a story");

  await pass(c, failures, s, NOW, NO_SLEEP);
  const alert = s.recorded.alerts.find((a) => a.kind === "failure_streak");
  assert.ok(alert, "three consecutive failures alert (08-OFFCHAIN §1)");
  assert.match(alert.message, /permissionless/, "the alert has to say a human can do it by hand");
});

test("OracleNotDeadYet is a transient too — the grace period is not a fault", async () => {
  const s = sink();
  const r = await pass(
    client({ submit: () => Promise.reject(contractError(CODES.OracleNotDeadYet)) }),
    new ConsecutiveFailures("t"),
    s,
    NOW,
    NO_SLEEP,
  );
  assert.equal(r.disposition?.kind, "transient");
});

// ---------------------------------------------------------------------------------------------
// The rejections with no event behind them
// ---------------------------------------------------------------------------------------------

test("a feed rejection is surfaced without counting as the keeper failing", async () => {
  const s = sink();
  const failures = new ConsecutiveFailures("t");
  const idle: EpochView = { ...VIEW, phase: "Idle", nextOpenAt: NOW };
  const c = client({
    epoch: () => Promise.resolve(idle),
    submit: () => Promise.reject(contractError(CODES.OracleStale)),
  });

  for (let i = 0; i < 4; i++) await pass(c, failures, s, NOW, NO_SLEEP);

  assert.equal(failures.count, 0, "the feed being stale is not the keeper failing");
  assert.equal(s.recorded.alerts.filter((a) => a.kind === "failure_streak").length, 0);
  assert.ok(
    s.recorded.warn.some((w) => /rejected by the feed/.test(w)),
    "the rejection writes nothing and emits no event, so simulation is the only signal",
  );
});

// ---------------------------------------------------------------------------------------------
// The rest
// ---------------------------------------------------------------------------------------------

test("an unexpected error counts and alerts on the third", async () => {
  const s = sink();
  const failures = new ConsecutiveFailures("t");
  const c = client({ submit: () => Promise.reject(new Error("connection reset")) });
  for (let i = 0; i < 3; i++) await pass(c, failures, s, NOW, NO_SLEEP);
  assert.equal(s.recorded.alerts.filter((a) => a.kind === "failure_streak").length, 1);
});

test("a successful send resets a streak and reports the hash", async () => {
  const s = sink();
  const failures = new ConsecutiveFailures("t");
  failures.fail();
  const r = await pass(client(), failures, s, NOW, NO_SLEEP);
  assert.equal(r.txHash, "tx-hash");
  assert.equal(failures.count, 0);
});

test("nothing is submitted when the decision is to wait", async () => {
  let submitted = 0;
  const s = sink();
  const c = client({
    epoch: () => Promise.resolve({ ...VIEW, phase: "Active", expiry: NOW + 600 }),
    submit: () => {
      submitted++;
      return Promise.resolve("nope");
    },
  });
  const r = await pass(c, new ConsecutiveFailures("t"), s, NOW, NO_SLEEP);
  assert.equal(r.action.kind, "wait");
  assert.equal(submitted, 0);
});

test("alerts from the read are raised even when the pass then does nothing", async () => {
  // An expired-but-unclosed round and a low feed runway both surface from the *read*. A pass that
  // decided to wait, or one whose send failed, must still have raised them.
  const s = sink();
  const c = client({
    epoch: () => Promise.resolve({ ...VIEW, phase: "Active", expiry: NOW - 2 * 3600 }),
    feedExpiresAt: () => Promise.resolve(NOW + 60),
    submit: () => Promise.reject(contractError(CODES.OracleUnreachable)),
  });
  const r = await pass(c, new ConsecutiveFailures("t"), s, NOW, NO_SLEEP);
  const kinds = r.alerts.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["expiry_passed_still_active", "feed_runway_low"]);
});

// ---------------------------------------------------------------------------------------------
// The archive is a second job, and it may never stop the first
// ---------------------------------------------------------------------------------------------

/** Records the calls and, optionally, throws the way a dead RPC would. */
function archivist(over: { throws?: boolean; path?: string; failFirst?: number } = {}) {
  const calls: string[] = [];
  let failures = over.failFirst ?? 0;
  return {
    calls,
    collect: (v: string) => {
      calls.push(`collect:${v}`);
      if (over.throws === true) return Promise.reject(new Error("rpc is down"));
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("rpc is down"));
      }
      return Promise.resolve();
    },
    close: (v: string) => {
      calls.push(`close:${v}`);
      return Promise.resolve(over.path ?? null);
    },
  };
}

test("every pass collects, then finalizes — in that order, and before the decision", async () => {
  const s = sink();
  const a = archivist();
  await pass(client(), new ConsecutiveFailures("t"), s, NOW, { ...NO_SLEEP, archivist: a });
  assert.deepEqual(a.calls, ["collect:CVAULT", "close:CVAULT"]);
});

test("an archive that throws is a warning, not a failed pass — the round still closes", async () => {
  // D-09 inverted would be a keeper that stopped settling because it could not write a file. The
  // round is the fact; the record is the account of it, and the account may never block the fact.
  const s = sink();
  const failures = new ConsecutiveFailures("t");
  let submitted = false;
  const result = await pass(
    client({
      epoch: () => Promise.resolve({ ...VIEW, expiry: NOW - 1 }),
      submit: () => {
        submitted = true;
        return Promise.resolve("tx-hash");
      },
    }),
    failures,
    s,
    NOW,
    { ...NO_SLEEP, archivist: archivist({ throws: true }) },
  );
  assert.equal(submitted, true, "the settlement went out anyway");
  assert.equal(result.txHash, "tx-hash");
  assert.equal(failures.count, 0, "an archive failure is not a keeper failure streak");
  assert.ok(s.recorded.warn.some((m) => m.includes("archiving failed")));
});

test("a written record is reported at info, so an operator sees the file appear", async () => {
  const s = sink();
  await pass(client(), new ConsecutiveFailures("t"), s, NOW, {
    ...NO_SLEEP,
    archivist: archivist({ path: "evidence/2026-09-04-testnet.json" }),
  });
  assert.ok(s.recorded.info.some((m) => m.includes("archived")));
});

test("a keeper with no archivist behaves exactly as it did before there was one", async () => {
  const s = sink();
  const result = await pass(client(), new ConsecutiveFailures("t"), s, NOW, NO_SLEEP);
  assert.equal(result.action.kind, "close_round");
  assert.equal(result.txHash, "tx-hash");
  assert.equal(s.recorded.warn.length, 0);
});

// ---------------------------------------------------------------------------------------------
// loop — because `--once` is `loop` with a `running` that is false after one sweep
// ---------------------------------------------------------------------------------------------

test("a running() that is true once sweeps every vault exactly once and never sleeps", async () => {
  // This is the contract `index.ts --once` rests on. Asserting it here rather than in the entry
  // point is the point: a cron and a daemon must execute the same `pass` in the same order, and
  // the way to guarantee that is for `--once` to have no code path of its own.
  const seen: string[] = [];
  let swept = false;
  let slept = 0;
  const v = (id: string): VaultClient => client({ id, submit: () => Promise.resolve(`tx-${id}`) });
  await loop([v("A"), v("B"), v("C")], sink(), {
    ...NO_SLEEP,
    sleep: () => {
      slept += 1;
      return Promise.resolve();
    },
    running: () => {
      if (swept) return false;
      swept = true;
      return true;
    },
    clock: () => NOW,
    archivist: {
      collect: (id) => {
        seen.push(id);
        return Promise.resolve();
      },
      close: () => Promise.resolve(null),
    },
  });
  assert.deepEqual(seen, ["A", "B", "C"], "each vault swept once, in order");
  assert.equal(slept, 0, "a single sweep must not wait for an interval it will never use");
});

test("one vault's pass throwing does not stop the rest of the sweep", async () => {
  // A keeper that exits on the first error is a keeper that is off — survivable by design (D-09)
  // but pointless by accident.
  const s = sink();
  const reached: string[] = [];
  const ok = (id: string): VaultClient =>
    client({
      id,
      epoch: () => {
        reached.push(id);
        return Promise.resolve(VIEW);
      },
    });
  const bad: VaultClient = client({ id: "B", epoch: () => Promise.reject(new Error("rpc down")) });
  let swept = false;
  await loop([ok("A"), bad, ok("C")], s, {
    ...NO_SLEEP,
    running: () => {
      if (swept) return false;
      swept = true;
      return true;
    },
    clock: () => NOW,
  });
  assert.deepEqual(reached, ["A", "C"]);
  assert.ok(s.recorded.warn.some((m) => m.includes("before a decision could be made")));
});

// ---------------------------------------------------------------------------------------------
// archivePass — the half that needs no key
// ---------------------------------------------------------------------------------------------

/** A reader is a client minus `submit`, which is the whole point of the split. */
const reader = (id: string, over: Partial<VaultReader> = {}): VaultReader => ({
  id,
  epoch: () => Promise.resolve(VIEW),
  config: () => Promise.resolve<VaultConfig>({ paused: false }),
  feedExpiresAt: () => Promise.resolve(NOW + 400 * DAY),
  ...over,
});

test("an archive pass collects and finalizes every vault and signs nothing", async () => {
  const a = archivist();
  await archivePass([reader("A"), reader("B")], sink(), a);
  assert.deepEqual(a.calls, ["collect:A", "close:A", "collect:B", "close:B"]);
});

test("a vault whose epoch cannot be read does not stop the others", async () => {
  const s = sink();
  const a = archivist();
  await archivePass(
    [reader("A"), reader("B", { epoch: () => Promise.reject(new Error("rpc down")) }), reader("C")],
    s,
    a,
  );
  // B is collected too — only its finalize is skipped, because that is the part that needs a view.
  assert.deepEqual(a.calls, ["collect:A", "close:A", "collect:B", "collect:C", "close:C"]);
  assert.ok(s.recorded.warn.some((m) => m.includes("no epoch to finalize against")));
});

test("an archive pass uses the same failure policy as a full pass, not a copy of it", async () => {
  // `archivePass` calls `pass`'s own archive step. If that ever became a second implementation,
  // this is the assertion that would notice: a throwing archivist is a warning in both.
  const s = sink();
  await archivePass([reader("A")], s, archivist({ throws: true }));
  assert.ok(s.recorded.warn.some((m) => m.includes("archiving failed")));
});

// ---------------------------------------------------------------------------------------------
// What the first real run taught it
// ---------------------------------------------------------------------------------------------

test("a collection that fails once is retried, not lost", async () => {
  // Measured: the first pass against the public RPC lost one vault of three to a transport
  // failure while the other two succeeded. Events are the half nobody can fetch again, so a
  // transient must not cost a pass its collection.
  const s = sink();
  const a = archivist({ failFirst: 1 });
  await archivePass([reader("A")], s, a);
  assert.deepEqual(a.calls, ["collect:A", "collect:A", "close:A"]);
  assert.equal(s.recorded.warn.length, 0, "a retry that succeeded is not a warning");
});

test("a collection that keeps failing reports what actually went wrong", async () => {
  // `classify(error).why` used to stand here and answered "a transport or signing failure" for
  // every transport error, discarding the message. The first failure this code had was diagnosed
  // by guessing because of it.
  const s = sink();
  await archivePass([reader("A")], s, archivist({ throws: true }));
  assert.ok(
    s.recorded.warnFields.some((f) => String(f?.["why"]).includes("rpc is down")),
    "the error's own message reaches the log",
  );
});

test("a vault whose epoch cannot be read is still collected", async () => {
  // Fetching events does not need the epoch; only finalizing does. An RPC that cannot answer
  // `epoch` must not also cost this pass the events.
  const s = sink();
  const a = archivist();
  await archivePass([reader("A", { epoch: () => Promise.reject(new Error("epoch is down")) })], s, a);
  assert.deepEqual(a.calls, ["collect:A"], "collected, and not finalized");
  assert.ok(s.recorded.warn.some((m) => m.includes("no epoch to finalize against")));
});
