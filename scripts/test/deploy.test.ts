/**
 * Tests for the deploy's sequencing — `09-DEPLOYMENT.md` §2, `DEV3.md` §6.1.
 *
 * The stages themselves need a network. **The runner does not**, and the runner is where the
 * design lives: gates run in order, the first failure refuses, `--dry-run` stops at the first stage
 * that would change something, and a skip is announced rather than silent. Those are the properties
 * that make the sequence a gate instead of a report, so they are what is asserted here.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mkCheck, type Check } from "../lib/checks.ts";
import {
  ALLOWLIST_WINDOW_SECONDS,
  CALL_SIGNATURES,
  DeployRefused,
  STAGES,
  epochParamsJson,
  namedArgsFor,
  parseOptions,
  runStages,
  type Ctx,
  type Stage,
} from "../deploy.ts";

// A whole NetworkConfig rather than a cast: the runner never reads these, but a fixture that
// lies about a shared type is how a test keeps passing after the type moves under it.
const TESTNET = {
  name: "testnet",
  rpcUrl: "https://rpc",
  networkPassphrase: "pp",
  explorerTxBase: "https://x/tx",
  explorerContractBase: "https://x/contract",
} as const;

const ctx = (over: Partial<Ctx["opts"]> = {}): Ctx => ({
  root: "/tmp/root",
  net: TESTNET,
  netArgs: { rpcUrl: "https://rpc", networkPassphrase: "pp" },
  opts: {
    identity: "d",
    seriesPath: "s.json",
    paramsPath: "p.json",
    fastTest: false,
    experiment: false,
    dryRun: false,
    ...over,
  },
  wasm: {},
  instances: [],
  deployed: [],
});

const stage = (id: string, checks: Check[], mutates = false, skip?: string): Stage => ({
  id,
  title: `stage ${id}`,
  mutates,
  skipWhen: skip === undefined ? undefined : () => skip,
  run: () => Promise.resolve(checks),
});

const pass = (id: string): Check => mkCheck(id, "w", 1, 1, true);
const fail = (id: string): Check => mkCheck(id, "w", 1, 2, false);

// =================================================================================================
// The runner
// =================================================================================================

test("stages run in order and every check is collected", async () => {
  const seen: string[] = [];
  const { checks, stopped } = await runStages(
    [stage("0", [pass("a")]), stage("1", [pass("b"), pass("c")])],
    ctx(),
    (l) => seen.push(l),
  );
  assert.deepEqual(
    checks.map((c) => c.id),
    ["a", "b", "c"],
  );
  assert.equal(stopped, null);
  assert.equal(seen.filter((l) => l.includes("step 0")).length, 1);
  assert.equal(seen.filter((l) => l.includes("step 1")).length, 1);
});

test("the first failing gate refuses, and nothing after it runs", async () => {
  let ranLater = false;
  const later: Stage = {
    id: "2",
    title: "later",
    mutates: false,
    run: () => {
      ranLater = true;
      return Promise.resolve([]);
    },
  };
  await assert.rejects(
    () => runStages([stage("0", [pass("a")]), stage("1", [fail("b")]), later], ctx(), () => {}),
    (e: unknown) =>
      e instanceof DeployRefused && e.stage === "1" && /no flag to proceed/.test((e as Error).message),
  );
  assert.equal(ranLater, false, "a stage ran after a failed gate");
});

test("a failure names the checks that failed, not merely that the stage failed", async () => {
  await assert.rejects(
    () => runStages([stage("4", [pass("ok1"), fail("bad1"), fail("bad2")])], ctx(), () => {}),
    /bad1, bad2/,
  );
});

test("--dry-run stops at the first stage that changes the network, and names it", async () => {
  let mutated = false;
  const writer: Stage = {
    id: "2",
    title: "deploy something",
    mutates: true,
    run: () => {
      mutated = true;
      return Promise.resolve([pass("x")]);
    },
  };
  const lines: string[] = [];
  const { stopped } = await runStages(
    [stage("0", [pass("a")]), writer, stage("6", [pass("z")])],
    ctx({ dryRun: true }),
    (l) => lines.push(l),
  );
  assert.equal(stopped, "2");
  assert.equal(mutated, false, "--dry-run ran a stage that changes the network");
  assert.match(lines.join("\n"), /step 2 — deploy something\n\s+STOPPING: --dry-run/);
});

test("without --dry-run a mutating stage runs", async () => {
  let mutated = false;
  const writer: Stage = {
    id: "2",
    title: "w",
    mutates: true,
    run: () => {
      mutated = true;
      return Promise.resolve([pass("x")]);
    },
  };
  await runStages([writer], ctx(), () => {});
  assert.equal(mutated, true);
});

test("a skipped stage is announced with its reason and contributes no checks", async () => {
  const lines: string[] = [];
  const { checks } = await runStages(
    [stage("0a", [fail("would-have-failed")], false, "no Reflector under --fast-test")],
    ctx(),
    (l) => lines.push(l),
  );
  assert.deepEqual(checks, []);
  assert.match(lines.join("\n"), /SKIPPED: no Reflector under --fast-test/);
});

// =================================================================================================
// The sequence itself
// =================================================================================================

test("every gate runs before anything is deployed, and 3b precedes step 4", () => {
  const ids = STAGES.map((s) => s.id);
  const firstMutating = STAGES.findIndex((s) => s.mutates);
  // 0, 0a, 0b and 1 are all gates and all precede the first stage that spends anything.
  for (const gate of ["0", "0a", "0b", "1"]) {
    assert.ok(ids.indexOf(gate) < firstMutating, `${gate} runs after the first mutating step`);
  }
  // §2 says so in as many words: step 3b "must precede step 4" because it produces an argument
  // step 4 passes.
  assert.ok(ids.indexOf("3b") < ids.indexOf("4"), "3b must precede 4");
  assert.ok(ids.indexOf("3") < ids.indexOf("4"), "the asset must be resolved before the vault");
  assert.ok(ids.indexOf("2") < ids.indexOf("4"), "the oracle must exist before the vault names it");
  assert.ok(ids.indexOf("5") < ids.indexOf("6"), "the record is written only after verification");
});

test("the sequence covers every step 09-DEPLOYMENT §2 numbers", () => {
  const ids = new Set(STAGES.map((s) => s.id));
  for (const step of ["0", "0a", "0b", "1", "2", "3", "3b", "4", "5", "6"]) {
    assert.ok(ids.has(step), `§2 step ${step} has no stage`);
  }
});

// =================================================================================================
// Options and argument naming
// =================================================================================================

test("options parse, and flags are distinguished from values", () => {
  const o = parseOptions(["--identity", "deployer", "--dry-run", "--experiment", "--only", "-C"]);
  assert.equal(o.identity, "deployer");
  assert.equal(o.dryRun, true);
  assert.equal(o.experiment, true);
  assert.equal(o.only, "-C");
  assert.equal(o.fastTest, false);
});

test("a flag immediately before another flag is not swallowed as its value", () => {
  const o = parseOptions(["--fast-test", "--identity", "d"]);
  assert.equal(o.fastTest, true);
  assert.equal(o.identity, "d");
});

test("the identity may come from the environment but has no default", () => {
  assert.equal(parseOptions([], {}).identity, "");
  assert.equal(parseOptions([], { DEPLOY_IDENTITY: "ci" }).identity, "ci");
});

test("a call's arguments are named from a recorded signature, never guessed", () => {
  assert.deepEqual(namedArgsFor("deposit", ["GUSER", 10n]), { from: "GUSER", amount: 10n });
  assert.deepEqual(namedArgsFor("request_withdraw", ["GUSER", 10n, true]), {
    from: "GUSER",
    shares: 10n,
    require_idle: true,
  });
});

test("an unrecorded method is refused — a guess that parses is a call to the wrong parameter", () => {
  assert.throws(
    () => namedArgsFor("set_fee_bps", [30]),
    (e: unknown) => e instanceof DeployRefused,
  );
});

test("an arity mismatch is refused rather than silently truncated", () => {
  assert.throws(() => namedArgsFor("deposit", ["GUSER"]), /takes 2 arguments/);
  assert.throws(() => namedArgsFor("deposit", ["GUSER", 1n, 2n]), /takes 2 arguments/);
});

test("every recorded signature is non-empty and uniquely named", () => {
  for (const [method, names] of Object.entries(CALL_SIGNATURES)) {
    assert.ok(names.length > 0, method);
    assert.equal(new Set(names).size, names.length, `${method} repeats an argument name`);
  }
});

test("the constructor's params argument carries all sixteen fields in the contract's names", () => {
  const params = Object.fromEntries(
    [
      "epoch_duration",
      "auction_duration",
      "min_idle_gap",
      "strike_bps_otm",
      "premium_start_bps",
      "premium_floor_bps",
      "twap_window",
      "guard_window",
      "max_staleness",
      "max_deviation_bps",
      "oracle_dead_after",
      "settle_grace",
      "unresolved_after",
      "min_fill",
      "min_deposit",
      "settle_bounty_bps",
    ].map((n, i) => [n, i + 1]),
  );
  const json = epochParamsJson({
    suffix: "-A",
    params,
    depositCap: 1,
    rentThreshold: 1,
    rentExtendTo: 2,
  } as never);
  assert.equal(Object.keys(json).length, 16);
  assert.equal(json["settle_bounty_bps"], 16);
});

test("the genesis allowlist window is inside the constructor's thirty-day cap (D-63)", () => {
  assert.ok(ALLOWLIST_WINDOW_SECONDS > 0);
  assert.ok(ALLOWLIST_WINDOW_SECONDS <= 2_592_000, "the constructor would reject it");
});
