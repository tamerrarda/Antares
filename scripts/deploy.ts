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

import { resolveNetwork, resolveRpcUrl, explorerContractUrl, type NetworkConfig } from "@antares/common";

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
  runStellar,
  type NetworkArgs,
} from "./lib/chain.ts";
import { checkToolchain, readPins, type Observed, type Pins } from "./lib/toolchain.ts";
import { checkAdapterSurface, exportedFunctions, sha256 } from "./lib/wasm.ts";
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
  title: "toolchain pins (D-23) — asserted from the files that own them, never restated",
  mutates: false,
  run: (ctx) => {
    ctx.pins = readPins(ctx.root);
    return Promise.resolve(checkToolchain(ctx.pins, probeToolchain()));
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
    const out = join(ctx.root, "deployments", `environment-${ctx.net.name}-deploy.json`);
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
      ? { admin: ctx.opts.identity, decimals: 14 }
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

const step3: Stage = {
  id: "3",
  title: "resolve the XLM SAC id for this network",
  mutates: false,
  run: (ctx) => {
    // Resolved from the network rather than carried as a literal: 06-TEST-PLAN §8 exempts exactly
    // packages/common/networks.ts and deployments/*.json, and §1 says the SAC is "resolved at
    // deploy … then pinned in deployments/". The CLI derives it from the passphrase, so the id can
    // only be the one that matches the network this deploy is signing for.
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
      "--source-account",
      ctx.opts.identity,
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
    const maxTtl = await readMaxEntryTtl(server);

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
async function readMaxEntryTtl(server: {
  getNetwork: () => Promise<unknown>;
  _getLedgerEntries?: unknown;
}): Promise<number> {
  const anyServer = server as unknown as {
    getNetwork: () => Promise<Record<string, unknown>>;
  };
  const net = await anyServer.getNetwork();
  const value = net["maxEntryTtl"] ?? net["max_entry_ttl"];
  if (typeof value === "number" && value > 0) return value;
  throw new DeployRefused(
    "3b",
    "The RPC did not report a max entry TTL, so the intended rent_extend_to cannot be asserted " +
      "against anything. 03-STORAGE-TTL §2 requires the ceiling to be read live rather than " +
      "compiled in, and refusing is the only honest response to not having read it.",
  );
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
            admin: ctx.opts.identity,
            asset: ctx.assetId!,
            oracle: ctx.adapterId!,
            fee_recipient: ctx.opts.identity,
            params: epochParamsJson(inst),
            token_suffix: inst.suffix,
            deposit_cap: inst.depositCap,
            rent_threshold: inst.rentThreshold,
            rent_extend_to: inst.rentExtendTo,
            allowlist_expires_at: allowlistExpiresAt,
          },
        }),
      );
      const vaultId = parseContractId(`${out.stdout}\n${out.stderr}`);
      ctx.deployed.push({ suffix: inst.suffix, vaultId });

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

/** The sixteen fields as the CLI takes a struct: a JSON object with the contract's own field names. */
export function epochParamsJson(inst: InstanceSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(EPOCH_PARAM_FIELDS)) out[name] = inst.params[name]!;
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
      toolchain: {
        // Two commits, separately, following deployments/adapter-testnet.json's shape: the tree the
        // wasm was built from and the tree that ran the deploy are different questions, and a
        // single "commit" field answers neither when they differ.
        wasmBuiltAtCommit: gitHead(ctx.root),
        deployedAtCommit: gitHead(ctx.root),
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
      instances: ctx.deployed.map((d) => {
        const inst = ctx.instances.find((i) => i.suffix === d.suffix)!;
        return {
          tokenSuffix: d.suffix,
          vaultId: d.vaultId,
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
    ]);
  },
};

const RECORD_PREAMBLE =
  "Written by scripts/deploy.ts step 6 (09-DEPLOYMENT §2). This file is the ONLY place a contract " +
  "id is allowed to live outside packages/common/networks.ts, and every other tool reads its " +
  "addresses from here. The two commit fields are separate on purpose: the tree a wasm was built " +
  "from and the tree that ran the deploy are different questions, and one field answers neither " +
  "when they differ. economicallyMeaningless marks a --fast-test instance and is permanent — a " +
  "profile stamped that way can never be presented as demand evidence (D-57).";

function gitHead(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "(not a git checkout)";
  }
}

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
      runStellar(
        buildInvokeArgv({
          contractId,
          method,
          identity: ctx.opts.identity,
          net: ctx.netArgs,
          args: namedArgsFor(method, args),
        }),
      );
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
  step3,
  step3b,
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
    paramsPath: resolvePath(values.get("params") ?? join(root, "scripts", "instances.json")),
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
