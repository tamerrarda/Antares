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

import { mkCheck, type Check } from "@antares/common/checks";
import {
  ALLOWLIST_WINDOW_SECONDS,
  CALL_SIGNATURES,
  DeployRefused,
  STAGES,
  USAGE,
  epochParamsJson,
  mergeInstances,
  namedArgsFor,
  parseOptions,
  recordTx,
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
  transactions: [],
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
  for (const step of ["0", "0a", "0b", "1", "2", "3", "3b", "3c", "4", "5", "6"]) {
    assert.ok(ids.has(step), `§2 step ${step} has no stage`);
  }
});

test("the feed is primed and its conditions checked before the vault names it", () => {
  const ids = STAGES.map((s) => s.id);
  // 2b primes the mock; without it `expires()` is None, which IS an unfunded feed. 3c then asks
  // the deployed source's own eight conditions — the constructor skips condition 7 (round_span = 0),
  // so a vault can deploy cleanly and refuse every open_epoch unless something checks it here.
  assert.ok(ids.indexOf("2") < ids.indexOf("2b"), "the mock must exist before it is primed");
  assert.ok(ids.indexOf("2b") < ids.indexOf("3c"), "condition 7 cannot pass on an unprimed feed");
  assert.ok(
    ids.indexOf("3c") < ids.indexOf("4"),
    "a vault must not be built on a profile its source refuses",
  );
});

test("--fast-test points the params at the fast-test profile rather than at nothing", () => {
  assert.match(parseOptions(["--fast-test", "--identity", "d"]).paramsPath, /instances-fast-test\.json$/);
  assert.match(parseOptions(["--identity", "d"]).paramsPath, /instances\.json$/);
  // An explicit --params still wins, so a one-off profile needs no code change.
  assert.match(
    parseOptions(["--fast-test", "--identity", "d", "--params", "/tmp/other.json"]).paramsPath,
    /other\.json$/,
  );
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

// =================================================================================================
// The transaction ledger — D2's evidence, and it is perishable
// =================================================================================================

const H1 = "e4266667e3e0887b117a30c31a310b81d7eda990249f9528f4fb6bfee1b271ee";
const H2 = "5836a47a207f55feb0a717983fe1988e18856905ca0e8dc8845cc50fe366216e";
const res = (stderr: string) => ({ stdout: "", stderr });

test("an upload and a create are both recorded, labelled in submission order", () => {
  const c = ctx();
  recordTx(
    c,
    res(`Signing transaction: ${H1}\nSigning transaction: ${H2}`),
    "upload:vault",
    "create:vault-A",
  );
  assert.deepEqual(
    c.transactions.map((t) => [t.label, t.hash]),
    [
      ["upload:vault", H1],
      ["create:vault-A", H2],
    ],
  );
  assert.equal(c.transactions[0]!.explorer, `https://x/tx/${H1}`);
});

test("when the wasm was already installed, the single hash is the CREATE, not the upload", () => {
  // Labels align from the END. Aligning from the start would label the create as an upload on
  // every deploy after the first — which in an --experiment run is four instances out of five,
  // and the record would then name no transaction that created them.
  const c = ctx();
  recordTx(
    c,
    res(`Skipping install because wasm already installed\nSigning transaction: ${H1}`),
    "upload:vault",
    "create:vault-B",
  );
  assert.deepEqual(
    c.transactions.map((t) => t.label),
    ["create:vault-B"],
  );
  assert.equal(c.transactions[0]!.hash, H1);
});

test("a call that submitted nothing records nothing", () => {
  const c = ctx();
  recordTx(c, res("Simulating transaction…\n1\n"), "read:resolution");
  assert.deepEqual(c.transactions, []);
});

test("hashes accumulate across a whole run rather than replacing each other", () => {
  const c = ctx();
  recordTx(c, res(`Signing transaction: ${H1}`), "prime:set_expires");
  recordTx(c, res(`Signing transaction: ${H2}`), "prime:fill");
  assert.deepEqual(
    c.transactions.map((t) => t.label),
    ["prime:set_expires", "prime:fill"],
  );
});

test("the parser holds against real CLI output, not just against hand-written fixtures", () => {
  // Verbatim from a `stellar contract deploy` on testnet, 2026-08-20. The wasm hash on the third
  // line is 64 hex characters and is NOT a transaction.
  const real = [
    "\u2139\uFE0F  Uploading contract WASM…",
    "\u2139\uFE0F  Skipping install because wasm already installed",
    "\u2139\uFE0F  Deploying contract using wasm hash 908dde6d80f16f3ccca3543c16e79e37a25c38dcda5cca1a10d5b68a258f3402",
    "\u2139\uFE0F  Simulating transaction…",
    `\u2139\uFE0F  Signing transaction: ${H1}`,
    "\uD83C\uDF0E Sending transaction…",
    "\u2705 Transaction submitted successfully!",
    `\uD83D\uDD17 https://stellar.expert/explorer/testnet/tx/${H1}`,
    "\u2705 Deployed!",
  ].join("\n");
  const c = ctx();
  recordTx(c, res(real), "upload:mock", "create:oracle");
  assert.deepEqual(
    c.transactions.map((t) => [t.label, t.hash]),
    [["create:oracle", H1]],
  );
});

/**
 * The merge, which is what makes `--only` safe.
 *
 * Step 6 wrote the whole record from one run until 2026-08-28. Deploying a second instance against
 * a file that already named one replaced it: the record shrank to the newer vault, and every reader
 * — `web/lib/deployment.ts` takes `instances[0]` — silently followed. The live vault kept the
 * deposits and lost the only file allowed to name it. These assert both directions of the fix,
 * because getting it backwards fails in two different ways and neither is visible at deploy time.
 */
const row = (tokenSuffix: string, vaultId: string) => ({ tokenSuffix, vaultId });

test("a new suffix is appended and the existing instances survive", () => {
  const merged = mergeInstances([row("-E", "C_E")], [row("-C", "C_C")]);
  assert.deepEqual(
    merged.map((m) => m["tokenSuffix"]),
    ["-E", "-C"],
    "the live instance is still in the record, and still first",
  );
  assert.equal(merged[0]?.["vaultId"], "C_E");
});

test("the same suffix deployed again replaces its own row rather than adding a second", () => {
  const merged = mergeInstances([row("-E", "OLD"), row("-C", "C_C")], [row("-E", "NEW")]);
  assert.equal(merged.length, 2, "one suffix must never occupy two rows");
  assert.equal(merged[0]?.["vaultId"], "NEW", "the newer deploy wins");
  assert.equal(merged[0]?.["tokenSuffix"], "-E", "and keeps its position, so instances[0] is stable");
  assert.equal(merged[1]?.["vaultId"], "C_C");
});

test("a first deploy, with nothing on disk, is just this run", () => {
  assert.deepEqual(
    mergeInstances([], [row("-A", "C_A")]).map((m) => m["tokenSuffix"]),
    ["-A"],
  );
});

test("a run that deploys nothing leaves the record exactly as it found it", () => {
  const prior = [row("-E", "C_E"), row("-C", "C_C")];
  assert.deepEqual(mergeInstances(prior, []), prior);
});

/**
 * `--oracle`, which is what keeps a five-instance experiment an experiment.
 *
 * Step 2 deployed a fresh adapter on every run. Adding `-C` to a set already running `-E` therefore
 * gave `-C` a different oracle from the instance it exists to be compared against, and the record's
 * one top-level `oracleId` could no longer describe both. The flag reuses instead — and step 2's
 * served-bytes assertion still runs, so an adapter that has drifted from the tree fails rather than
 * being adopted because it happened to be named.
 */
test("an adapter can be named, from a flag or the environment", () => {
  assert.equal(parseOptions(["--identity", "d", "--oracle", "C_ORACLE"]).oracleId, "C_ORACLE");
  assert.equal(parseOptions(["--identity", "d"], { ORACLE_ID: "C_ENV" }).oracleId, "C_ENV");
});

test("no adapter named means deploy one, which is the behaviour every prior run had", () => {
  assert.equal(parseOptions(["--identity", "d"], {}).oracleId, undefined);
});

test("the flag is documented, because an undocumented deploy flag is a private one", () => {
  assert.match(USAGE, /--oracle <C\.\.\.>/);
});
