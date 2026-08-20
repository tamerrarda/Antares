/**
 * deploy.ts — `09-DEPLOYMENT.md` §2, the deploy procedure, as a sequence a process performs.
 *
 * OWNER: DEV3 (`DEV-PROTOCOL.md` §3), Phase 6.
 *
 * **THE DESIGN IS ONE SENTENCE FROM `DEV3.md` §6.1: *"the gates run **in sequence, asserted by the
 * script**, not by the operator's memory."*** Every step below is a stage that returns comparisons;
 * the runner stops at the first stage that fails and refuses the deploy. There is no flag to
 * proceed past a failed gate, because a gate with an override is a gate that gets overridden at
 * three in the morning by whoever is trying to finish.
 *
 * **THE ORDER IS LOAD-BEARING AND IT IS NOT THE ORDER THE STEPS WERE WRITTEN IN.** Three things
 * happen before anything is deployed — the toolchain pins (step 0), the live environment battery
 * (0a) and the parameter coherence gate (0b) — and two live reads happen before the vault rather
 * than after it: step 3b *produces a constructor argument* (`rent_extend_to`, D-56) and step 3c
 * measures the feed the vault will settle against. §2 makes the point itself: *"Must precede step
 * 4"*. A gate that runs after the transaction that it was meant to prevent is a report.
 *
 * **WHAT `--dry-run` MEANS HERE.** It runs every stage that does not change the network and stops
 * at the first one that would, naming it. That is not a rehearsal of the deploy — it is the whole
 * of the deploy that can be checked without spending anything, and it is the mode this file is
 * exercised in until a testnet run.
 *
 * **THE MAINNET REFUSAL IS NOT IN THIS FILE.** It lives in `resolveNetwork` in
 * `packages/common/networks.ts`, which is the one door every tool comes through, so `upgrade.ts`,
 * the keeper and the bidder cannot each forget their own copy. `09-DEPLOYMENT.md`'s preamble is the
 * rule; lifting the gate is a reviewed one-line change to `MAINNET_ENABLED`, not an environment
 * variable somebody can set by accident.
 *
 * **NO SECRET KEY REACHES THIS PROCESS.** Signing happens in the `stellar` CLI against a named
 * identity (`07-SECURITY.md` §6, `lib/chain.ts`), which is also why the deployment record can carry
 * a deployer identity *name*: it is the only thing this script ever knew.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  explorerContractUrl,
  explorerTxUrl,
  resolveNetwork,
  resolveRpcUrl,
  type NetworkConfig,
} from "@antares/common";

import {
  EPOCH_PARAM_FIELDS,
  checkSet,
  loadInstances,
  loadSeries,
  sigmaRange,
  type InstanceSpec,
} from "./check-params.ts";
import { allPassed, failedIds, mkCheck, renderChecks, type Check } from "./lib/checks.ts";
import {
  buildDeployArgv,
  buildInvokeArgv,
  parseContractId,
  parseTxHashes,
  runStellar,
  type NetworkArgs,
  type RunResult,
} from "./lib/chain.ts";
import { checkSourceTree, readSourceTree, type SourceTree } from "./lib/provenance.ts";
import { checkToolchain, readPins, type Observed, type Pins } from "./lib/toolchain.ts";
import { checkAdapterSurface, exportedFunctions, sha256 } from "./lib/wasm.ts";
import { checkProfile } from "./check-oracle-profile.ts";
import type { ChainClient, ObservedEvent } from "./verify-deployment.ts";

// =================================================================================================
// Options
// =================================================================================================

export interface Options {
  readonly identity: string;
  readonly reflectorId?: string;
  readonly seriesPath: string;
  readonly paramsPath: string;
  readonly fastTest: boolean;
  readonly experiment: boolean;
  readonly dryRun: boolean;
  /** Restrict a non-`--experiment` run to one instance; defaults to the first. */
  readonly only?: string;
}

export class DeployRefused extends Error {
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = "DeployRefused";
    this.stage = stage;
  }
}

// =================================================================================================
// The stage runner
// =================================================================================================

export interface Ctx {
  readonly root: string;
  readonly net: NetworkConfig;
  readonly netArgs: NetworkArgs;
  readonly opts: Options;
  pins?: Pins;
  sourceTree?: SourceTree;
  /** Local wasm paths and their hashes, from step 1. */
  wasm: Record<string, { path: string; sha256: string; bytes: number }>;
  instances: InstanceSpec[];
  adapterId?: string;
  assetId?: string;
  rentExtendTo?: number;
  rentThreshold?: number;
  /** Chosen once for the whole set, so five instances do not drift apart by seconds (D-63). */
  allowlistExpiresAt?: number;
  /** The G… behind the identity NAME. Resolved once, from the CLI, never from a key. */
  deployerAddress?: string;
  /** The ledger before the first deploy, so a later event query can find this run's transactions. */
  startLedger?: number;
  deployed: { suffix: string; vaultId: string; txHash?: string }[];
  /**
   * Every transaction this deploy submitted, labelled and in order.
   *
   * **This is D2's evidence and it is perishable.** `09-DEPLOYMENT.md` §3 says a testnet reset
   * erases the transactions themselves, so a hash not written down here cannot be recovered later
   * by any amount of archaeology — and walking the deployer account's history to reconstruct them
   * only works while the account is young and the ledger still holds them. Recording at the moment
   * of submission is the only point at which this is free.
   */
  transactions: { label: string; hash: string; explorer: string }[];
}

export interface Stage {
  /** §2's own numbering — `0`, `0a`, `3b` — so a failure names the step in the document. */
  readonly id: string;
  readonly title: string;
  /** True when the stage changes the network. `--dry-run` stops at the first of these. */
  readonly mutates: boolean;
  /** Some stages do not apply to every profile; a skip is reported, never silent. */
  skipWhen?(ctx: Ctx): string | null;
  run(ctx: Ctx): Promise<Check[]>;
}

/**
 * Run stages in order and stop at the first failure.
 *
 * The `log` sink is a parameter so a caller can capture the transcript for the deployment record —
 * §1's *"reproducibility over memory"* wants the gate output kept, not just its verdict.
 */
export async function runStages(
  stages: readonly Stage[],
  ctx: Ctx,
  log: (line: string) => void,
): Promise<{ checks: Check[]; stopped: string | null }> {
  const all: Check[] = [];
  for (const stage of stages) {
    const skip = stage.skipWhen?.(ctx) ?? null;
    if (skip !== null) {
      log(`\nstep ${stage.id} — ${stage.title}\n  SKIPPED: ${skip}`);
      continue;
    }
    if (ctx.opts.dryRun && stage.mutates) {
      log(
        `\nstep ${stage.id} — ${stage.title}\n` +
          `  STOPPING: --dry-run, and this is the first step that changes the network.\n` +
          `  Everything checkable without spending has been checked and passed.`,
      );
      return { checks: all, stopped: stage.id };
    }
    const checks = await stage.run(ctx);
    all.push(...checks);
    log("\n" + renderChecks(`step ${stage.id} — ${stage.title}`, checks).join("\n"));
    if (!allPassed(checks)) {
      throw new DeployRefused(
        stage.id,
        `step ${stage.id} (${stage.title}) failed: ${failedIds(checks).join(", ")}. ` +
          `The deploy is refused. There is deliberately no flag to proceed past a failed gate.`,
      );
    }
  }
  return { checks: all, stopped: null };
}

/**
 * Record every transaction a CLI invocation submitted, labelled.
 *
 * `labels` names them in submission order. A `contract deploy` submits **two** against a wasm the
 * network has not seen — the upload, then the create — and only the create against one already
 * installed; the CLI says which case it was, so the labels are aligned from the END rather than the
 * start. Aligning from the start would mis-label every subsequent deploy in an `--experiment` run,
 * where only the first uploads.
 */
export function recordTx(ctx: Ctx, result: RunResult, ...labels: string[]): string[] {
  const combined = `${result.stdout}\n${result.stderr}`;
  const hashes = parseTxHashes(combined);
  const aligned = labels.slice(labels.length - hashes.length);
  hashes.forEach((hash, i) => {
    ctx.transactions.push({
      label: aligned[i] ?? `tx${ctx.transactions.length + 1}`,
      hash,
      explorer: explorerTxUrl(ctx.net, hash),
    });
  });
  return hashes;
}

// =================================================================================================
// Step 0 — the toolchain pins
// =================================================================================================

function probeToolchain(): Observed {
  const run = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return `(${cmd} did not answer)`;
    }
  };
  return {
    rustc: run("rustc", ["--version"]),
    stellar: run("stellar", ["--version"]),
    installedTargets: run("rustup", ["target", "list", "--installed"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const step0: Stage = {
  id: "0",
  title: "toolchain pins (D-23) and the source tree — the code that is about to run",
  mutates: false,
  run: (ctx) => {
    ctx.pins = readPins(ctx.root);
    ctx.sourceTree = readSourceTree(ctx.root);
    // The tree check belongs beside the pins because it answers the same question they do — WHICH
    // CODE IS ABOUT TO RUN — and it belongs before everything else for the same reason they do: a
    // refusal here costs nothing, and every later step writes something a reader will want to trace
    // back to a commit.
    return Promise.resolve([
      ...checkToolchain(ctx.pins, probeToolchain()),
      ...checkSourceTree(ctx.sourceTree),
    ]);
  },
};

// =================================================================================================
// Step 0a — the live environment battery (D-49)
// =================================================================================================

const step0a: Stage = {
  id: "0a",
  title: "environment verification gate (D-49) — every measured external fact, against the live network",
  mutates: false,
  skipWhen: (ctx) =>
    ctx.opts.fastTest
      ? "--fast-test deploys against mock-price-source; there is no Reflector to interrogate (§2 step 3c)"
      : ctx.opts.reflectorId === undefined
        ? null
        : null,
  run: (ctx) => {
    if (ctx.opts.reflectorId === undefined) {
      return Promise.resolve([
        mkCheck(
          "env.reflector_id",
          "the pinned Reflector contract is named, so the battery has something to measure",
          "--reflector <C...>",
          "(not supplied)",
          false,
          "09-DEPLOYMENT §2 step 0a runs scripts/verify-environment.ts against the live feed. A " +
            "documented value that has drifted must fail the deploy rather than the first settlement.",
        ),
      ]);
    }
    const script = join(ctx.root, "scripts", "verify-environment.ts");
    // A DEPLOY-SCOPED artefact, deliberately not `environment-<network>.json`.
    //
    // That file is DEV2's curated measurement record and it carries evidence a deploy cannot
    // reproduce: its tick-completeness figure accumulates across sweeps taken close together in
    // time (358 points at completeness 1, from two runs). Measured 2026-08-20: a plain re-run
    // downgrades `mode` to quick and nulls `unionOfSweeps` outright, replacing that accumulation
    // with one sweep's worth. Unioning instead is no better unattended — a sweep 26 hours after
    // the previous one spans more than the feed's ~21 h reach, so the union reports completeness
    // 0.91 for a perfectly healthy feed. Neither is a deploy's call to make about somebody else's
    // evidence, so it writes its own file. §2 step 3c asks to "record all in deployments/", not to
    // overwrite what is already there.
    // A dry run and a deploy produce different things and are named differently, because the
    // directory they land in is where committed records live. `-dryrun` is gitignored — a rehearsal
    // dressed as evidence is worse than no evidence, and an untracked file in `deployments/` is one
    // `git add -A` away from being committed as if it were a deploy's. `-deploy` is NOT ignored: it
    // is the battery reading that licensed a real deploy, and §2 step 0a wants it kept.
    const out = join(
      ctx.root,
      "deployments",
      `environment-${ctx.net.name}-${ctx.opts.dryRun ? "dryrun" : "deploy"}.json`,
    );
    let ok = true;
    let detail = "";
    try {
      // `--full` is not optional: §2 step 3c asks for the sweep by name — 256 point queries, about
      // a minute — and the reachable-depth cutoff falls out of it as a by-product. Without it the
      // battery writes a quick record with no tick-completeness evidence at all.
      execFileSync(process.execPath, ["--experimental-strip-types", script, "--full", "--json", out], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NETWORK: ctx.net.name,
          RPC_URL: ctx.netArgs.rpcUrl,
          NETWORK_PASSPHRASE: ctx.netArgs.networkPassphrase,
          REFLECTOR_ID: ctx.opts.reflectorId,
        },
      });
    } catch (e: unknown) {
      ok = false;
      const err = e as { stdout?: string; stderr?: string };
      detail = `${(err.stdout ?? "").trim().slice(-2000)}\n${(err.stderr ?? "").trim().slice(-1000)}`;
    }
    return Promise.resolve([
      mkCheck(
        "env.battery",
        "06-TEST-PLAN §7b's battery passes against the live network, and its record is written",
        "exit 0",
        ok ? "exit 0" : "non-zero",
        ok,
        `verify-environment.ts writes ${out}. ${detail}`,
      ),
    ]);
  },
};

// =================================================================================================
// Step 0b — the parameter coherence gate (D-31 / D-53 / D-57 / D-68)
// =================================================================================================

const step0b: Stage = {
  id: "0b",
  title: "parameter coherence gate — five gates against σ MEASURED today, never assumed",
  mutates: false,
  run: (ctx) => {
    ctx.instances = loadInstances(ctx.opts.paramsPath);
    const series = loadSeries(ctx.opts.seriesPath);
    const sigma = sigmaRange(series);

    const chosen = ctx.opts.experiment
      ? ctx.instances
      : ctx.instances.filter((i) => i.suffix === (ctx.opts.only ?? ctx.instances[0]?.suffix));
    ctx.instances = chosen;

    const { instances: judged, passed } = checkSet(chosen, sigma, { fastTest: ctx.opts.fastTest });
    const checks: Check[] = judged.map((c) =>
      mkCheck(
        `params${c.suffix}`,
        `instance ${c.suffix} clears every applicable coherence gate at the measured σ`,
        "all gates pass",
        c.results.filter((g) => !g.passed).map((g) => `gate ${g.gate} (${g.name})`),
        c.passed,
        `σ measured from ${ctx.opts.seriesPath}: [${(sigma.low * 100).toFixed(1)}%, ${(sigma.high * 100).toFixed(1)}%]. ` +
          `D-53: a σ baked into a script is what made every planned vault unfillable.`,
      ),
    );
    // D-57, stated as its own check rather than inferred from the others: the WHOLE SET is refused
    // if any one instance fails. A partially-deployable experiment is how C and D reached review.
    checks.push(
      mkCheck(
        "params.set",
        "the whole set is deployable, or none of it is (D-57)",
        "every instance passes",
        judged.filter((c) => !c.passed).map((c) => c.suffix),
        passed,
        "A partially-deployable experiment is what let instances C and D get as far as they did.",
      ),
    );
    return Promise.resolve(checks);
  },
};

// =================================================================================================
// Step 1 — build, and record what was built
// =================================================================================================

const CONTRACTS = ["antares_vault", "reflector_adapter", "mock_price_source"] as const;

const step1: Stage = {
  id: "1",
  title: "stellar contract build (workspace); record wasm hashes",
  mutates: false,
  run: (ctx) => {
    runStellar(["contract", "build"], "stellar");
    const dir = join(ctx.root, "target", "wasm32v1-none", "release");
    const checks: Check[] = [];
    for (const name of CONTRACTS) {
      const path = join(dir, `${name}.wasm`);
      const present = existsSync(path);
      if (present) {
        const bytes = readFileSync(path);
        ctx.wasm[name] = { path, sha256: sha256(bytes), bytes: bytes.length };
      }
      checks.push(
        mkCheck(
          `build.${name}`,
          `${name}.wasm was produced and hashed`,
          "present",
          present ? `${ctx.wasm[name]!.sha256.slice(0, 16)}… (${ctx.wasm[name]!.bytes} bytes)` : "missing",
          present,
          `D-50's gate compares this hash and nothing else. Expected at ${path}.`,
        ),
      );
    }
    return Promise.resolve(checks);
  },
};

/**
 * The adapter's export surface, checked against the **local** artefact before it is uploaded.
 *
 * §2 step 2 makes this assertion about the deployed adapter, and step 2 below repeats it against
 * the bytes the network serves — which is the one that counts, because it is checkable by someone
 * without this repository. This earlier copy exists because refusing before the upload costs
 * nothing and refusing after it has already published a contract with an admin on it.
 */
const step1b: Stage = {
  id: "1b",
  title: "the adapter's export surface, before it is uploaded (04-ORACLE §1)",
  mutates: false,
  skipWhen: (ctx) =>
    ctx.opts.fastTest ? "--fast-test deploys mock-price-source, which has setters by design" : null,
  run: (ctx) => {
    const built = ctx.wasm["reflector_adapter"];
    if (built === undefined) {
      return Promise.resolve([
        mkCheck("adapter.built", "reflector_adapter.wasm exists to inspect", "present", "missing", false),
      ]);
    }
    return Promise.resolve(checkAdapterSurface(exportedFunctions(readFileSync(built.path))));
  },
};

// =================================================================================================
// Step 2 — the oracle adapter, and the claim anyone can check without this repository
// =================================================================================================

const step2: Stage = {
  id: "2",
  title: "deploy the oracle adapter; assert its surface off the bytes the network serves",
  mutates: true,
  run: async (ctx) => {
    const which = ctx.opts.fastTest ? "mock_price_source" : "reflector_adapter";
    const built = ctx.wasm[which]!;
    const constructorArgs = ctx.opts.fastTest
      ? { admin: ctx.deployerAddress!, decimals: 14 }
      : { reflector: ctx.opts.reflectorId!, asset: "XLM" };

    const out = runStellar(
      buildDeployArgv({
        wasmPath: built.path,
        identity: ctx.opts.identity,
        net: ctx.netArgs,
        constructorArgs,
      }),
    );
    ctx.adapterId = parseContractId(`${out.stdout}\n${out.stderr}`);
    recordTx(ctx, out, `upload:${which}`, "create:oracle");

    // D-50 end to end, and 04-ORACLE §1's claim, both read back off the network. Until this call
    // the surface assertion was about a file in our tree; after it, it is about the contract users
    // would be trusting — and anyone can repeat it from the contract id alone.
    const served = await fetchContractWasm(ctx, ctx.adapterId);
    const checks: Check[] = [
      mkCheck(
        "adapter.deployed",
        "the adapter is deployed and its id was read unambiguously",
        "one contract id",
        ctx.adapterId,
        true,
        explorerContractUrl(ctx.net, ctx.adapterId),
      ),
      mkCheck(
        "adapter.wasm_hash",
        "the bytes the network serves are the bytes step 1 hashed (D-50)",
        built.sha256,
        sha256(served),
        sha256(served) === built.sha256,
        "stellar contract deploy defaults --optimize to true; this deploy passes --optimize=false " +
          "and this comparison is what makes that a guarantee rather than a hope.",
      ),
    ];
    if (!ctx.opts.fastTest) checks.push(...checkAdapterSurface(exportedFunctions(served)));
    return checks;
  },
};

// =================================================================================================
// Steps 3 / 3b — the XLM SAC, and the live limits that PRODUCE a constructor argument
// =================================================================================================

/**
 * Prime `mock-price-source` so the vault it will serve can actually open a round.
 *
 * Two things, and the first is not optional. The mock's constructor leaves `expires()` at `None`,
 * which **is** an unfunded feed: `supports_round` condition 7 answers false for any non-zero round
 * span, so the vault would construct happily — `validate_params` passes `round_span = 0` and skips
 * 7 — and then refuse *every* `open_epoch`. Verified against a live mock on 2026-08-20: unfunded,
 * the open path is rejected; funded past the round span, accepted.
 *
 * The records are the second. `reading()` looks on a grid whose oldest guard sample sits
 * `4 x guard_step` behind the anchor, and an empty window reads as a dead feed. This fills a band
 * comfortably wider than that.
 *
 * **What this does NOT do is keep the feed fed.** A full cycle needs records at settlement too, and
 * that belongs to whatever drives the cycle rather than to a deploy — a deploy that pre-filled the
 * future would be manufacturing the evidence the cycle is supposed to produce.
 */
const step2b: Stage = {
  id: "2b",
  title: "prime mock-price-source — an unfunded feed constructs fine and then never opens",
  mutates: true,
  skipWhen: (ctx) => (ctx.opts.fastTest ? null : "the real adapter reads a live Reflector feed"),
  run: (ctx) => {
    const now = Math.floor(Date.now() / 1000);
    const inst = ctx.instances[0]!;
    const roundSpan = inst.params["epoch_duration"] + inst.params["unresolved_after"]!;
    // Generous rather than exact: condition 7 wants the feed to outlive the round, and a testnet
    // profile that expires mid-experiment fails in a way that looks like a bug in the vault.
    const expiresAt = now + MOCK_FEED_LIFETIME_SECONDS;
    recordTx(
      ctx,
      runStellar(
        buildInvokeArgv({
          contractId: ctx.adapterId!,
          method: "set_expires",
          identity: ctx.opts.identity,
          net: ctx.netArgs,
          args: { at: expiresAt },
        }),
      ),
      "prime:set_expires",
    );
    recordTx(
      ctx,
      runStellar(
        buildInvokeArgv({
          contractId: ctx.adapterId!,
          method: "fill",
          identity: ctx.opts.identity,
          net: ctx.netArgs,
          args: { end: now, count: MOCK_FEED_RECORDS, price: MOCK_FEED_PRICE },
        }),
      ),
      "prime:fill",
    );
    return Promise.resolve([
      mkCheck(
        "mock.expires",
        "the mock's feed outlives the round span, so open_epoch's condition 7 can pass",
        `> now + ${roundSpan}`,
        `now + ${MOCK_FEED_LIFETIME_SECONDS}`,
        MOCK_FEED_LIFETIME_SECONDS > roundSpan,
        "The constructor leaves expires() at None, which IS an unfunded feed — the vault would " +
          "construct and then refuse every open, because validate_params passes round_span = 0 and " +
          "skips condition 7 while open_epoch enforces it.",
      ),
      mkCheck(
        "mock.records",
        "the feed carries records across the guard window",
        `>= 4 x guard_step`,
        MOCK_FEED_RECORDS,
        MOCK_FEED_RECORDS >= inst.params["guard_window"]!,
      ),
    ]);
  },
};

/** A day, against a fast-test round span of minutes. Deliberately not tight — see step 2b. */
const MOCK_FEED_LIFETIME_SECONDS = 86_400;
const MOCK_FEED_RECORDS = 240;
/** 0.17 at the mock's 14 decimals — the live XLM price, so a fast-test round is not absurd. */
const MOCK_FEED_PRICE = 17_000_000_000_000n;

/**
 * The profile against the deployed source's **own** eight conditions.
 *
 * This closes a gap that `validate_params` alone leaves open. The constructor calls
 * `supports_round` with `round_span = 0`, which **skips condition 7** so that a sponsorship
 * shortfall can never block the `set_epoch_params` call that repairs it. A vault can therefore
 * deploy cleanly and then refuse every `open_epoch` — which is exactly the shape of failure
 * §2 step 3c describes when it says the older `+ oracle_dead_after` form was *weaker than the
 * on-chain gate*, so *"a deploy could pass and the first `open_epoch` refuse."*
 *
 * It asks the deployed contract rather than recomputing: the eight conditions live once, in
 * `price-source-api`, and a second copy here would agree only on the day it was written.
 */
const step3c: Stage = {
  id: "3c",
  title: "the profile against the deployed source's eight supports_round conditions",
  mutates: false,
  run: (ctx) => {
    const src = { contractId: ctx.adapterId!, identity: ctx.opts.identity, net: ctx.netArgs };
    return Promise.resolve(ctx.instances.flatMap((inst) => checkProfile(src, inst)));
  },
};

const step3: Stage = {
  id: "3",
  title: "resolve the XLM SAC id for this network",
  mutates: false,
  run: (ctx) => {
    // Resolved from the network rather than carried as a literal: 06-TEST-PLAN §8 exempts exactly
    // packages/common/networks.ts and deployments/*.json, and §1 says the SAC is "resolved at
    // deploy … then pinned in deployments/". The CLI derives it from the passphrase, so the id can
    // only be the one that matches the network this deploy is signing for.
    // No `--source-account`: measured against the pinned CLI on 2026-08-20, `contract id asset`
    // does not accept one and rejects the invocation outright. It needs none — the id is DERIVED
    // from the asset and the passphrase, which is also why it can only be the id that matches the
    // network this deploy is signing for.
    const out = runStellar([
      "contract",
      "id",
      "asset",
      "--asset",
      "native",
      "--rpc-url",
      ctx.netArgs.rpcUrl,
      "--network-passphrase",
      ctx.netArgs.networkPassphrase,
    ]);
    ctx.assetId = parseContractId(`${out.stdout}\n${out.stderr}`);
    return Promise.resolve([
      mkCheck(
        "asset.resolved",
        "the XLM SAC id was derived from this network rather than carried as a literal",
        "one contract id",
        ctx.assetId,
        true,
        explorerContractUrl(ctx.net, ctx.assetId),
      ),
    ]);
  },
};

const step3b: Stage = {
  id: "3b",
  title: "live network limits — and the intended rent_extend_to, a constructor argument (D-56)",
  mutates: false,
  run: async (ctx) => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const server = new rpc.Server(ctx.netArgs.rpcUrl, {
      allowHttp: ctx.netArgs.rpcUrl.startsWith("http://"),
    });
    const ledger = await server.getLatestLedger();
    const maxTtl = await readMaxEntryTtl(ctx.netArgs.rpcUrl);

    // The intended values are committed in `instances.json` (03-STORAGE-TTL §2's tuned pair); this
    // step's job is to assert them against a ceiling read LIVE, because the network can lower it by
    // protocol vote. It is hygiene rather than the defence — the load-bearing one is the per-call
    // clamp in `storage::Rent::effective`, which holds after a vote this deploy could not foresee.
    const checks: Check[] = [];
    for (const inst of ctx.instances) {
      const ok = inst.rentExtendTo <= maxTtl && inst.rentThreshold < inst.rentExtendTo;
      checks.push(
        mkCheck(
          `limits.rent${inst.suffix}`,
          "the intended rent_extend_to is within the live max entry TTL",
          `<= ${maxTtl}`,
          inst.rentExtendTo,
          ok,
          `Read live at ledger ${ledger.sequence}. §2 step 3b must precede step 4 because it ` +
            `produces the argument step 4 passes. The stored value can still outlive a protocol ` +
            `vote that lowers max_ttl, which is why the clamp — not this check — is load-bearing.`,
        ),
      );
    }
    ctx.rentExtendTo = maxTtl;
    return checks;
  },
};

/**
 * The live `max_ttl`, read from the network's own configuration.
 *
 * Read rather than compiled in, per D-50 and `03-STORAGE-TTL.md` §2: a protocol vote can lower it,
 * and a constant here would let a deploy assert a ceiling the network no longer has.
 */
/**
 * The live `max_ttl`, read from the network's own state-archival configuration.
 *
 * **Not from `getNetwork()`**, which was this function's first draft and would have aborted the
 * first real deploy at step 3b: measured 2026-08-20, that call returns only `friendbotUrl`,
 * `passphrase` and `protocolVersion`. The ceiling lives in the `configSettingStateArchival` ledger
 * entry, which is where `profile-adapter.ts` already reads the compute limits from — the same
 * technique, against a different setting.
 *
 * Read live rather than compiled in, per D-50 and `03-STORAGE-TTL.md` §2: a protocol vote can lower
 * it, and a constant here would let a deploy assert a ceiling the network no longer has.
 */
async function readMaxEntryTtl(rpcUrl: string): Promise<number> {
  const { rpc, xdr } = await import("@stellar/stellar-sdk");
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const key = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival() }),
  );
  const entries = await server.getLedgerEntries(key);
  const setting = entries.entries[0]?.val.configSetting();
  const maxTtl = setting?.stateArchivalSettings().maxEntryTtl();
  if (typeof maxTtl !== "number" || maxTtl <= 0) {
    throw new DeployRefused(
      "3b",
      "The network did not report a max entry TTL, so the intended rent_extend_to cannot be " +
        "asserted against anything. 03-STORAGE-TTL §2 requires the ceiling to be read live rather " +
        "than compiled in, and refusing is the only honest response to not having read it.",
    );
  }
  return maxTtl;
}

async function fetchContractWasm(ctx: Ctx, contractId: string): Promise<Uint8Array> {
  const { rpc } = await import("@stellar/stellar-sdk");
  const server = new rpc.Server(ctx.netArgs.rpcUrl, {
    allowHttp: ctx.netArgs.rpcUrl.startsWith("http://"),
  });
  return await server.getContractWasmByContractId(contractId);
}

// =================================================================================================
// Step 4 / 4d — the vault, or five of them from one upload
// =================================================================================================

const step4: Stage = {
  id: "4",
  title: "deploy the vault(s) — ten constructor arguments, one transaction, no setter sequence",
  mutates: true,
  run: async (ctx) => {
    const checks: Check[] = [];
    const built = ctx.wasm["antares_vault"]!;
    // Noted BEFORE the first vault transaction, because step 5 finds the constructor's `Initialized`
    // event by asking RPC for the contract's events from this sequence onwards. Defaulting to the
    // latest ledger at the time step 5 runs would start the search after the event it is looking
    // for, and report a missing `Initialized` on a perfectly good deploy.
    const { rpc } = await import("@stellar/stellar-sdk");
    const ledgerServer = new rpc.Server(ctx.netArgs.rpcUrl, {
      allowHttp: ctx.netArgs.rpcUrl.startsWith("http://"),
    });
    ctx.startLedger = (await ledgerServer.getLatestLedger()).sequence;
    const now = Math.floor(Date.now() / 1000);
    // D-63's window, chosen once for the whole set so five instances do not drift apart by the
    // seconds between their transactions.
    const allowlistExpiresAt = now + ALLOWLIST_WINDOW_SECONDS;

    for (const inst of ctx.instances) {
      const out = runStellar(
        buildDeployArgv({
          wasmPath: built.path,
          identity: ctx.opts.identity,
          net: ctx.netArgs,
          constructorArgs: {
            // Addresses, not the identity NAME. The CLI would resolve an alias here, but step 5
            // compares config() against ctx.deployerAddress — so they must be the same value by
            // construction rather than because the CLI happened to resolve it the same way.
            admin: ctx.deployerAddress!,
            asset: ctx.assetId!,
            oracle: ctx.adapterId!,
            fee_recipient: ctx.deployerAddress!,
            params: epochParamsForCli(inst),
            token_suffix: inst.suffix,
            deposit_cap: inst.depositCap,
            rent_threshold: inst.rentThreshold,
            rent_extend_to: inst.rentExtendTo,
            allowlist_expires_at: allowlistExpiresAt,
          },
        }),
      );
      const vaultId = parseContractId(`${out.stdout}\n${out.stderr}`);
      const hashes = recordTx(ctx, out, "upload:antares_vault", `create:vault${inst.suffix}`);
      ctx.deployed.push({ suffix: inst.suffix, vaultId, txHash: hashes[hashes.length - 1] });

      const served = await fetchContractWasm(ctx, vaultId);
      checks.push(
        mkCheck(
          `vault${inst.suffix}.deployed`,
          `instance ${inst.suffix} is deployed`,
          "one contract id",
          vaultId,
          true,
          explorerContractUrl(ctx.net, vaultId),
        ),
        mkCheck(
          `vault${inst.suffix}.wasm_hash`,
          "the bytes the network serves are the bytes step 1 hashed (D-50)",
          built.sha256,
          sha256(served),
          sha256(served) === built.sha256,
        ),
      );
    }
    ctx.allowlistExpiresAt = allowlistExpiresAt;
    return checks;
  },
};

/** D-63's genesis window. Two weeks, inside the constructor's thirty-day cap. */
export const ALLOWLIST_WINDOW_SECONDS = 14 * 86_400;

/** The sixteen fields as plain numbers — for the deployment record and step 5's expectation. */
export function epochParamsJson(inst: InstanceSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(EPOCH_PARAM_FIELDS)) out[name] = inst.params[name]!;
  return out;
}

/**
 * The same sixteen fields, typed the way the CLI's JSON-to-ScVal conversion demands.
 *
 * **`i128` goes as a string; `u32` and `u64` go as numbers.** This is not a guess and it took two
 * rejections to stop guessing. A JSON number in an `i128` field is refused with *"invalid type:
 * number, expected string or map"*; correcting the `u64`s to strings as well then fails differently
 * — *"unknown variant `20`"*, serde reading the string as an ScVal type tag. The authority is the
 * CLI itself: `stellar contract deploy --wasm … -- --help` prints a worked example of every
 * argument, and for `EpochParams` it quotes exactly `min_deposit` and `min_fill` and nothing else.
 * Asking the tool beat two rounds of inference, which is the same lesson D-48 records about the
 * feed.
 *
 * This is why `EPOCH_PARAM_FIELDS` records a width per field. Nothing else needed it until now.
 *
 * It is deliberately NOT what step 5 compares against: `config()` decodes a `u32` to a `number` and
 * a `u64` to a `bigint`, so the expectation stays numeric and this shape exists only for the wire.
 */
export function epochParamsForCli(inst: InstanceSpec): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [name, width] of Object.entries(EPOCH_PARAM_FIELDS)) {
    const value = inst.params[name]!;
    out[name] = width === "i128" ? String(value) : value;
  }
  return out;
}

// =================================================================================================
// Step 5 — the post-deploy battery (verify-deployment.ts)
// =================================================================================================

const step5: Stage = {
  id: "5",
  title: "post-deploy verification — script asserts, not eyeballs",
  mutates: true,
  run: async (ctx) => {
    const { verifyDeployment } = await import("./verify-deployment.ts");
    const client = await makeChainClient(ctx);
    const checks: Check[] = [];
    for (const dep of ctx.deployed) {
      const inst = ctx.instances.find((i) => i.suffix === dep.suffix)!;
      const result = await verifyDeployment(
        client,
        {
          vaultId: dep.vaultId,
          admin: ctx.deployerAddress!,
          asset: ctx.assetId!,
          oracle: ctx.adapterId!,
          feeRecipient: ctx.deployerAddress!,
          tokenSuffix: inst.suffix,
          depositCap: BigInt(inst.depositCap),
          rentThreshold: inst.rentThreshold,
          rentExtendTo: inst.rentExtendTo,
          allowlistExpiresAt: ctx.allowlistExpiresAt!,
          params: epochParamsJson(inst),
        },
        Math.floor(Date.now() / 1000),
        await deployEventsOf(ctx, dep.vaultId),
        { account: ctx.deployerAddress!, assetId: ctx.assetId! },
      );
      // Re-labelled per instance so five sets of identical ids stay distinguishable in one report.
      checks.push(...result.checks.map((c) => ({ ...c, id: `${dep.suffix}:${c.id}` })));
    }
    return checks;
  },
};

// =================================================================================================
// Step 6 — the committed record
// =================================================================================================

const step6: Stage = {
  id: "6",
  title: "write deployments/<network>.json — reproducibility over memory",
  mutates: false,
  run: (ctx) => {
    const path = join(ctx.root, "deployments", `${ctx.net.name}.json`);
    const record = {
      _what: RECORD_PREAMBLE,
      network: ctx.net.name,
      deployedAt: new Date().toISOString(),
      // The identity NAME, never a key (07-SECURITY §6) — and the only thing this process knew.
      deployerIdentity: ctx.opts.identity,
      deployerAddress: ctx.deployerAddress,
      // ONE tree, not two commit fields, and the difference from adapter-testnet.json is real.
      // That record separates `wasmBuiltAtCommit` from `profiledAtCommit` because it profiles a
      // contract deployed earlier, so the two are genuinely different trees — 18dcef1a and
      // 256fbb3. This script BUILDS the wasm at step 1 of the same run, so the two questions have
      // one answer and writing it twice was two copies of the same value pretending to be evidence.
      // Step 2 and step 4 already prove the artefact independently, by comparing the bytes the
      // network serves against the local hash; this field says which source produced them.
      sourceTree: ctx.sourceTree,
      toolchain: {
        rust: ctx.pins!.rust,
        stellarCli: ctx.pins!.stellarCli,
        sorobanSdk: ctx.pins!.sorobanSdk,
        target: "wasm32v1-none",
        node: process.version,
      },
      assetId: ctx.assetId,
      oracleId: ctx.adapterId,
      oracleWasmHash: ctx.wasm[ctx.opts.fastTest ? "mock_price_source" : "reflector_adapter"]?.sha256,
      reflectorId: ctx.opts.fastTest ? undefined : ctx.opts.reflectorId,
      vaultWasmHash: ctx.wasm["antares_vault"]?.sha256,
      // The perishable half of the record. 09-DEPLOYMENT §3: a testnet reset erases the
      // transactions themselves, so a hash not written down here cannot be recovered afterwards by
      // any amount of archaeology — and reconstructing them from the deployer account's history
      // only works while that account is young. D2 is evidenced by these.
      transactions: ctx.transactions,
      instances: ctx.deployed.map((d) => {
        const inst = ctx.instances.find((i) => i.suffix === d.suffix)!;
        return {
          tokenSuffix: d.suffix,
          vaultId: d.vaultId,
          /** The transaction that created this instance — the one a reader follows first. */
          createTx: d.txHash,
          vaultWasmHash: ctx.wasm["antares_vault"]!.sha256,
          params: epochParamsJson(inst),
          depositCap: inst.depositCap,
          rentThreshold: inst.rentThreshold,
          rentExtendTo: inst.rentExtendTo,
          allowlistExpiresAt: ctx.allowlistExpiresAt,
          // D-57/§2 step 0b: a fast-test profile is stamped economically meaningless, permanently.
          // It is a property of the record rather than of anyone's memory precisely so that a
          // fast-test round can never be presented as demand evidence later.
          economicallyMeaningless: ctx.opts.fastTest,
          explorer: explorerContractUrl(ctx.net, d.vaultId),
        };
      }),
    };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return Promise.resolve([
      mkCheck(
        "record.written",
        "every deployed instance has a committed record: ids, hashes, args, identity, date",
        path,
        `${ctx.deployed.length} instance(s)`,
        ctx.deployed.length > 0,
        "09-DEPLOYMENT §1: reproducibility over memory. Commit this file — nothing else in the " +
          "repository is allowed to carry a contract id (06-TEST-PLAN §8).",
      ),
      // A check, not a hope. Without it a parser regression turns the evidence half of the record
      // into an empty array and the run still says DEPLOYED — and the omission only surfaces when
      // somebody needs the hashes, by which time a reset may have taken them.
      mkCheck(
        "record.transactions",
        "the transactions this deploy submitted are recorded, because a reset erases them",
        "at least one per contract created",
        ctx.transactions.map((t) => t.label),
        ctx.transactions.length >= ctx.deployed.length + 1,
        "09-DEPLOYMENT §3: a testnet reset erases the transactions, so a hash missing here cannot " +
          "be recovered later — not tediously, but at all. D2 is evidenced by these.",
      ),
      mkCheck(
        "record.create_tx",
        "every instance names the transaction that created it",
        "one hash each",
        ctx.deployed.map((d) => d.txHash ?? "(missing)"),
        ctx.deployed.every((d) => typeof d.txHash === "string" && d.txHash.length === 64),
      ),
    ]);
  },
};

const RECORD_PREAMBLE =
  "Written by scripts/deploy.ts step 6 (09-DEPLOYMENT §2). This file is the ONLY place a contract " +
  "id is allowed to live outside packages/common/networks.ts, and every other tool reads its " +
  "addresses from here. sourceTree names the code that ran and says whether the tree was clean: a " +
  "commit id identifies the code that ran ONLY if it was, and a deploy from a dirty tree is " +
  "refused at step 0 for exactly that reason. One tree rather than two commit fields, because this " +
  "script builds the wasm during the same run — deployments/adapter-testnet.json separates them " +
  "because it profiles a contract deployed earlier, where they are genuinely different trees. " +
  "economicallyMeaningless marks a --fast-test instance and is permanent — a profile stamped that " +
  "way can never be presented as demand evidence (D-57).";

// =================================================================================================
// The chain client step 5 runs against
// =================================================================================================

/**
 * Reads simulate through the SDK; writes go through the CLI and are then **read back off the
 * ledger**.
 *
 * The write path deserves its explanation. `stellar contract invoke` prints a human rendering of a
 * return value and prints no events at all, and it has no JSON output mode — measured against the
 * pinned 27.1.0 on 2026-08-20. Step 5 needs `scValToNative` shapes and it needs the events, so the
 * only honest source is the ledger: note the sequence before the call, submit, then ask RPC for the
 * contract's events from that point. The transaction hash arrives with them, which is what the
 * deployment record's explorer links are made of — so every value this reports is one an outsider
 * could re-derive from the record alone.
 */
async function makeChainClient(ctx: Ctx): Promise<ChainClient> {
  const { rpc, scValToNative, nativeToScVal, Contract, TransactionBuilder, Account } =
    await import("@stellar/stellar-sdk");
  const server = new rpc.Server(ctx.netArgs.rpcUrl, {
    allowHttp: ctx.netArgs.rpcUrl.startsWith("http://"),
  });

  const toScVal = (v: unknown): ReturnType<typeof nativeToScVal> => {
    if (typeof v === "string" && /^[GC][A-Z2-7]{55}$/.test(v)) {
      return nativeToScVal(v, { type: "address" });
    }
    if (typeof v === "bigint") return nativeToScVal(v, { type: "i128" });
    return nativeToScVal(v);
  };

  const eventsSince = async (
    contractId: string,
    startLedger: number,
  ): Promise<{ events: ObservedEvent[]; txHash: string | null }> => {
    const res = await server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: 200,
    });
    const events = res.events.map((e) => ({
      topics: e.topic.map((t) => scValToNative(t) as unknown),
      data: scValToNative(e.value) as unknown,
    }));
    return { events, txHash: res.events[res.events.length - 1]?.txHash ?? null };
  };

  return {
    async read<T>(contractId: string, method: string, args: readonly unknown[] = []): Promise<T> {
      // A simulation needs a source account to be built against; it never signs and never submits,
      // so the account only has to exist.
      const account = new Account(ctx.deployerAddress!, "0");
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: ctx.netArgs.networkPassphrase,
      })
        .addOperation(new Contract(contractId).call(method, ...args.map(toScVal)))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new DeployRefused("5", `${contractId}.${method}() failed to simulate: ${sim.error}`);
      }
      const retval = sim.result?.retval;
      if (retval === undefined) {
        throw new DeployRefused("5", `${contractId}.${method}() simulated without a return value.`);
      }
      return scValToNative(retval) as T;
    },

    async invoke<T>(contractId: string, method: string, args: readonly unknown[]) {
      const before = (await server.getLatestLedger()).sequence;
      const submitted = runStellar(
        buildInvokeArgv({
          contractId,
          method,
          identity: ctx.opts.identity,
          net: ctx.netArgs,
          args: namedArgsFor(method, args),
        }),
      );
      // Recorded here rather than only in step 6, because these two calls ARE the smoke test and
      // their hashes are what makes "a deposit and a withdraw round-tripped" checkable by someone
      // who was not watching.
      recordTx(ctx, submitted, `smoke:${method}`);
      const { events, txHash } = await eventsSince(contractId, before);
      if (txHash === null) {
        throw new DeployRefused(
          "5",
          `${contractId}.${method}() submitted but published no events, so its transaction cannot ` +
            `be located and its return value cannot be read. Every call step 5 makes publishes at ` +
            `least one event; none arriving means the call did not do what it was asked.`,
        );
      }
      // The RETURN VALUE, read off the transaction rather than inferred from a later view. A
      // deposit's return is the shares it minted, and re-reading total_assets would answer a
      // different question with a number that often happens to match.
      const tx = await server.getTransaction(txHash);
      const retval = tx.status === rpc.Api.GetTransactionStatus.SUCCESS ? tx.returnValue : undefined;
      if (retval === undefined) {
        throw new DeployRefused(
          "5",
          `${contractId}.${method}() (tx ${txHash}) did not succeed with a return value; status ` +
            `was ${tx.status}.`,
        );
      }
      return { value: scValToNative(retval) as T, events, txHash };
    },
  };
}

/**
 * The CLI takes contract arguments by name, and step 5's port passes them positionally.
 *
 * This is the seam between the two, and it is a small explicit table rather than something derived,
 * because the names are the contract's ABI: getting one wrong is rejected by the CLI, and *guessing*
 * one right is how a call ends up passing the correct value to the wrong parameter.
 */
export const CALL_SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  deposit: ["from", "amount"],
  request_withdraw: ["from", "shares", "require_idle"],
  claim_withdraw: ["from"],
  balance: ["id"],
};

export function namedArgsFor(method: string, args: readonly unknown[]): Record<string, unknown> {
  const names = CALL_SIGNATURES[method];
  if (names === undefined) {
    throw new DeployRefused(
      "5",
      `No argument names recorded for ${method}(). CALL_SIGNATURES is the seam between step 5's ` +
        `positional port and the CLI's named arguments; add the signature rather than guessing it, ` +
        `because a guess that parses is a call passing the right value to the wrong parameter.`,
    );
  }
  if (names.length !== args.length) {
    throw new DeployRefused(
      "5",
      `${method}() takes ${names.length} arguments (${names.join(", ")}) and was given ${args.length}.`,
    );
  }
  return Object.fromEntries(names.map((n, i) => [n, args[i]]));
}

/** The deploy transaction's own events, so `Initialized` can be checked against the arguments passed. */
async function deployEventsOf(ctx: Ctx, vaultId: string): Promise<ObservedEvent[]> {
  const { rpc, scValToNative } = await import("@stellar/stellar-sdk");
  const server = new rpc.Server(ctx.netArgs.rpcUrl, {
    allowHttp: ctx.netArgs.rpcUrl.startsWith("http://"),
  });
  const res = await server.getEvents({
    startLedger: ctx.startLedger ?? (await server.getLatestLedger()).sequence,
    filters: [{ type: "contract", contractIds: [vaultId] }],
    limit: 200,
  });
  return res.events.map((e) => ({
    topics: e.topic.map((t) => scValToNative(t) as unknown),
    data: scValToNative(e.value) as unknown,
  }));
}

// =================================================================================================
// The sequence, and the entry point
// =================================================================================================

/**
 * §2's steps, in §2's order.
 *
 * Two orderings here are not cosmetic and both are stated in the document. **Every gate runs before
 * anything is deployed** — 0, 0a, 0b and 1 all precede step 2, so a refusal costs nothing. **3b and
 * 3c precede step 4** because 3b *produces* a constructor argument and 3c measures the feed the
 * vault will settle against; §2 says so in as many words. A gate placed after the transaction it
 * exists to prevent is a report.
 */
export const STAGES: readonly Stage[] = [
  step0,
  step0a,
  step0b,
  step1,
  step1b,
  step2,
  step2b,
  step3,
  step3b,
  step3c,
  step4,
  step5,
  step6,
];

export function parseOptions(argv: readonly string[], env = process.env): Options {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(a.slice(2));
    } else {
      values.set(a.slice(2), next);
      i += 1;
    }
  }
  const root = repoRoot();
  return {
    identity: values.get("identity") ?? env["DEPLOY_IDENTITY"] ?? "",
    reflectorId: values.get("reflector") ?? env["REFLECTOR_ID"],
    seriesPath: resolvePath(values.get("series") ?? join(root, "deployments", "xlm-price-series.json")),
    // `--fast-test` points at the fast-test profile, because otherwise the flag points at nothing:
    // instances.json holds production parameter sets, whose seven-day epochs are the very thing the
    // profile exists to escape. An explicit `--params` still wins.
    paramsPath: resolvePath(
      values.get("params") ??
        join(root, "scripts", flags.has("fast-test") ? "instances-fast-test.json" : "instances.json"),
    ),
    fastTest: flags.has("fast-test"),
    experiment: flags.has("experiment"),
    dryRun: flags.has("dry-run"),
    only: values.get("only"),
  };
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new DeployRefused(
    "-",
    "Could not locate the repository root (no pnpm-workspace.yaml above this file).",
  );
}

const USAGE = `usage: NETWORK=testnet deploy.ts --identity <name> [options]

  09-DEPLOYMENT §2's deploy procedure. Every gate runs in sequence and the first failure
  refuses the deploy; there is deliberately no flag to proceed past one.

  --identity <name>   a stellar CLI identity NAME. The secret never reaches this process
                      (07-SECURITY §6), which is why the record can carry an identity name.
  --reflector <C...>  the pinned Reflector contract. Required unless --fast-test.
  --series <path>     daily closes; sigma is MEASURED from them, never assumed (D-53).
  --params <path>     the instance set (default scripts/instances.json).
  --experiment        deploy all five instances from one upload (D-47/D-57). Without it,
                      one instance is deployed: --only <suffix>, else the first.
  --fast-test         mock-price-source, second-scale durations. Exempts coherence gates
                      1, 2, 4 and 5 — never 3 — and stamps the record ECONOMICALLY
                      MEANINGLESS, permanently (D-57).
  --dry-run           run everything that does not change the network, then stop and name
                      the step that would have.

  NETWORK is required and mainnet is refused in packages/common/networks.ts, not here —
  one door, so no tool has to remember its own copy of the gate.

  Requires \`pnpm build\` once, so @antares/common resolves.`;

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseOptions(argv);
  if (opts.identity === "") {
    console.error(USAGE);
    return 2;
  }

  let net: NetworkConfig;
  try {
    net = resolveNetwork();
  } catch (e: unknown) {
    console.error(`\n${(e as Error).message}\n`);
    return 2;
  }

  const root = repoRoot();
  const ctx: Ctx = {
    root,
    net,
    netArgs: { rpcUrl: resolveRpcUrl(net), networkPassphrase: net.networkPassphrase },
    opts,
    wasm: {},
    instances: [],
    deployed: [],
    transactions: [],
  };

  // The identity's address, resolved from its NAME. This is the only thing about the signer this
  // process ever learns, and it is a public key.
  try {
    ctx.deployerAddress = runStellar(["keys", "public-key", opts.identity])
      .stdout.trim()
      .split("\n")
      .pop()
      ?.trim();
  } catch {
    ctx.deployerAddress = undefined;
  }
  if (ctx.deployerAddress === undefined || !/^G[A-Z2-7]{55}$/.test(ctx.deployerAddress)) {
    console.error(
      `\nNo stellar CLI identity named "${opts.identity}". \`stellar keys generate ${opts.identity}\` ` +
        `or \`stellar keys add\`. The name is passed to the CLI for signing; the secret never reaches ` +
        `this process (07-SECURITY §6).\n`,
    );
    return 2;
  }

  const transcript: string[] = [];
  const log = (line: string): void => {
    console.log(line);
    transcript.push(line);
  };

  log(
    `Antares deploy — 09-DEPLOYMENT §2\n` +
      `  network   ${net.name} via ${ctx.netArgs.rpcUrl}\n` +
      `  identity  ${opts.identity} (${ctx.deployerAddress})\n` +
      `  profile   ${opts.fastTest ? "FAST-TEST — economically meaningless, permanently" : "production parameters"}` +
      `${opts.experiment ? ", five-instance experiment (D-47/D-57)" : ""}` +
      `${opts.dryRun ? "\n  --dry-run: stops before the first step that changes the network" : ""}`,
  );

  try {
    const { stopped } = await runStages(STAGES, ctx, log);
    if (stopped !== null) {
      log(`\nDRY RUN COMPLETE. Every gate that can be checked without spending has passed.`);
      return 0;
    }
    log(
      `\nDEPLOYED. ${ctx.deployed.length} instance(s), every gate asserted:\n` +
        ctx.deployed.map((d) => `  ${d.suffix.padEnd(4)} ${d.vaultId}`).join("\n") +
        `\n\nCommit deployments/${net.name}.json — it is the only place a contract id may live.`,
    );
    return 0;
  } catch (e: unknown) {
    if (e instanceof DeployRefused) {
      console.error(`\nREFUSED at step ${e.stage}.\n${e.message}\n`);
      return 1;
    }
    console.error(`\nREFUSED. ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
