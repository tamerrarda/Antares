#!/usr/bin/env node
/**
 * `upgrade.ts` — replace the code behind the deployed vaults without moving them.
 *
 * `09-DEPLOYMENT.md` §4. Named by `deploy.ts`'s header long before it existed, because the two are
 * different operations and only one of them is reversible by doing it again.
 *
 * WHY THIS IS NOT A MODE OF `deploy.ts`. That script's job is to bring an instance into existence:
 * it builds, it calls a constructor, it asserts the live configuration against the arguments the
 * constructor was given, and it writes the id down. An upgrade has the opposite shape. The instance
 * already exists, its configuration is **not** supposed to change, and the thing being proved is a
 * negative — that nothing moved except the code. Folding that into `deploy.ts` would mean a flag
 * that turns off most of step 5 and adds assertions step 5 cannot express, which is two scripts
 * sharing a name.
 *
 * WHAT AN UPGRADE MUST NOT CHANGE, and why each one is checked rather than trusted. `upgrade`
 * writes the new executable and then `storage::set_state` and `storage::bump_instance`; it touches
 * `Config` nowhere and `AppVersion` nowhere — only `migrate` advances the schema. So a vault whose
 * `config()` differs across the call, or whose `app_version` moved, did not do what this script
 * asked it to, and the difference is the only warning anyone would get. The same argument covers
 * the phase and the round number: an upgrade is not a round event and must not look like one.
 *
 * WHY THE PROOF FETCHES BYTES BACK. The CLI reports a wasm hash on upload and the contract emits
 * `Upgraded` carrying the hash it was handed. Both are claims made by the thing being tested. So
 * verification here does what `profile-adapter.ts` does for D-50: `stellar contract fetch` pulls
 * the code the network now serves for that contract id and hashes it locally. Equal to the bytes
 * this checkout built means the upgrade landed; equal to anything else means it did not, whatever
 * the transaction said.
 *
 * WHY A DIRTY TREE IS REFUSED. Identical to `deploy.ts` step 0 and for the identical reason: the
 * record this writes names a commit, and a commit identifies the code that ran only if the tree was
 * clean when it ran. An upgrade from a dirty tree produces a `vaultWasmHash` that no checkout can
 * reproduce, which is D-50's gate turned into a comparison of two unrelated numbers.
 *
 * IDEMPOTENCE. A vault already serving the target hash is reported and skipped, not re-upgraded. A
 * re-run after a partial failure therefore finishes the job instead of paying for the part that
 * already succeeded.
 *
 * USAGE
 *   NETWORK=testnet node --experimental-strip-types scripts/upgrade.ts [options]
 *
 *   --only <suffix>     Restrict to one instance, keyed by tokenSuffix (e.g. `-A`).
 *   --identity <name>   Signing identity. Defaults to the record's deployerIdentity.
 *   --dry-run           Run every gate and every read, sign nothing, write nothing.
 *   --json <path>       Write the report as JSON as well as to stdout.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { explorerTxUrl, resolveNetwork, resolveRpcUrl, type NetworkConfig } from "@antares/common";
import { allPassed, failedIds, mkCheck, renderChecks, sameValue, type Check } from "@antares/common/checks";
import { buildInvokeArgv, parseTxHash, runStellar, type NetworkArgs } from "@antares/common/chain";
import {
  deploymentPath,
  loadDeployment,
  type DeployedInstance,
  type DeploymentRecord,
} from "@antares/common/deployments";

import { checkSourceTree, readSourceTree, type SourceTree } from "./lib/provenance.ts";
import { buildHost, checkToolchain, readPins, type Observed, type Pins } from "./lib/toolchain.ts";
import { sha256 } from "./lib/wasm.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const VAULT_WASM = join(ROOT, "target", "wasm32v1-none", "release", "antares_vault.wasm");
const GENERATED = join(ROOT, "packages", "bindings", "GENERATED.json");

/** `upgrade` leaves the schema alone; only `migrate` moves it. See `admin.rs`. */
const SCHEMA_UNCHANGED = true;

export class UpgradeError extends Error {
  override readonly name = "UpgradeError";
}

interface Options {
  readonly only?: string;
  readonly identity?: string;
  readonly dryRun: boolean;
  readonly jsonOut?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new UpgradeError(`${name} needs a value.`);
    }
    return v;
  };
  return {
    only: flag("--only"),
    identity: flag("--identity"),
    dryRun: argv.includes("--dry-run"),
    jsonOut: flag("--json"),
  };
}

/** What the vault says about itself, through the two views an upgrade must not disturb. */
interface VaultReading {
  readonly config: Readonly<Record<string, unknown>>;
  readonly phase: string;
  readonly round: number;
  readonly servingSha256: string;
}

function readJsonInvoke(contractId: string, method: string, identity: string, net: NetworkArgs): unknown {
  const { stdout } = runStellar(
    buildInvokeArgv({ contractId, method, identity, net, args: {}, readOnly: true }),
  );
  try {
    return JSON.parse(stdout);
  } catch {
    throw new UpgradeError(
      `\`${method}\` on ${contractId} did not return JSON. The CLI printed:\n${stdout.slice(0, 2000)}`,
    );
  }
}

/**
 * The sha256 of the code the network currently serves for a contract id.
 *
 * Fetched rather than read out of a ledger entry, so the number compared below is derived from the
 * same kind of artefact as the local one — bytes — and not from a hash the network reports about
 * bytes nobody looked at.
 */
function servingSha256(contractId: string, net: NetworkArgs): string {
  const dir = mkdtempSync(join(tmpdir(), "antares-upgrade-"));
  const out = join(dir, `${contractId}.wasm`);
  runStellar([
    "contract",
    "fetch",
    "--id",
    contractId,
    "--rpc-url",
    net.rpcUrl,
    "--network-passphrase",
    net.networkPassphrase,
    "--out-file",
    out,
  ]);
  return sha256(readFileSync(out));
}

function readVault(instance: DeployedInstance, identity: string, net: NetworkArgs): VaultReading {
  const config = readJsonInvoke(instance.vaultId, "config", identity, net) as Readonly<
    Record<string, unknown>
  >;
  const epoch = readJsonInvoke(instance.vaultId, "epoch", identity, net) as Readonly<Record<string, unknown>>;
  const phaseRaw = epoch["phase"];
  return {
    config,
    // `scValToNative` renders a unit variant as a one-element array, which is a shape and not a
    // name. Reduced here so every message below says `Idle` rather than `["Idle"]`.
    phase: Array.isArray(phaseRaw) ? String(phaseRaw[0]) : String(phaseRaw),
    round: Number(epoch["round"]),
    servingSha256: servingSha256(instance.vaultId, net),
  };
}

// =================================================================================================
// Gates — everything that must hold before a single transaction is signed
// =================================================================================================

/**
 * The built wasm is the one the committed bindings describe.
 *
 * Without this the script would happily upgrade to whatever happens to be in `target/`, which may
 * predate the source in the checkout or postdate the bindings the off-chain code is typed against.
 * `GENERATED.json` is the only file that records which build the committed bindings came from, so
 * it is the only thing that can tie the three together.
 */
function checkArtefact(localSha: string): Check[] {
  const checks: Check[] = [];
  if (!existsSync(GENERATED)) {
    return [
      mkCheck(
        "upgrade.bindings_recorded",
        "the committed bindings record which wasm they were generated from",
        "packages/bindings/GENERATED.json",
        "(missing)",
        false,
        "Run `pnpm bindings:write` and commit the result.",
      ),
    ];
  }
  const recorded = JSON.parse(readFileSync(GENERATED, "utf8")) as { wasmSha256?: string };
  checks.push(
    mkCheck(
      "upgrade.artefact_matches_bindings",
      "the wasm about to be installed is the one the committed bindings were generated from",
      recorded.wasmSha256,
      localSha,
      recorded.wasmSha256 === localSha,
      `A mismatch means \`target/\` and \`packages/bindings/\` describe different contracts. ` +
        `Run \`stellar contract build\` then \`pnpm bindings:write\`, and commit both.`,
    ),
  );
  return checks;
}

/** Per-vault gates. Each one is a reason not to send the transaction, named. */
function checkVault(
  instance: DeployedInstance,
  reading: VaultReading,
  identityAddress: string,
  targetSha: string,
): Check[] {
  const checks: Check[] = [];

  checks.push(
    mkCheck(
      `vault${instance.tokenSuffix}.phase_idle`,
      "the vault is Idle — 09-DEPLOYMENT §4 refuses an upgrade during a live round",
      "Idle",
      reading.phase,
      reading.phase === "Idle",
      `The contract itself permits an upgrade in any phase, deliberately: a live round is exactly ` +
        `when a fix may be needed. This is the policy half, and it lives here because policy does. ` +
        `Wait for the round to finalize, or decide consciously to override it.`,
    ),
  );

  // Narrowed rather than coerced: `config()` is parsed JSON, so every field is `unknown`, and
  // `String()` on an object yields "[object Object]" — which would compare unequal to the signer
  // and report the admin gate as failing for the wrong reason.
  const adminRaw = reading.config["admin"];
  const admin = typeof adminRaw === "string" ? adminRaw : "";
  checks.push(
    mkCheck(
      `vault${instance.tokenSuffix}.admin_is_signer`,
      "the signing identity is the vault's admin — `upgrade` calls `require_auth` on it",
      identityAddress,
      admin,
      admin === identityAddress,
      `Signing with anything else spends a fee and fails on authorization. The admin is a ` +
        `constructor argument; transfer_admin/accept_admin are the only things that move it.`,
    ),
  );

  checks.push(
    mkCheck(
      `vault${instance.tokenSuffix}.not_already_upgraded`,
      "the vault is not already serving the target code",
      `not ${targetSha.slice(0, 12)}…`,
      `${reading.servingSha256.slice(0, 12)}…`,
      reading.servingSha256 !== targetSha,
      "Already upgraded — this instance is skipped rather than paid for twice.",
    ),
  );

  checks.push(
    mkCheck(
      `vault${instance.tokenSuffix}.record_matches_chain`,
      "the recorded wasm hash is the one the network actually serves",
      instance.vaultWasmHash,
      reading.servingSha256,
      instance.vaultWasmHash === reading.servingSha256,
      `The record and the chain disagree BEFORE this script changed anything, which means the ` +
        `record was already wrong. Fix that first: an upgrade written on top of it would bury the ` +
        `discrepancy instead of reporting it.`,
    ),
  );

  return checks;
}

/**
 * The negative an upgrade is really asserting: code moved and nothing else did.
 *
 * `config()` is compared field by field rather than as a blob, so a failure names the field. The
 * round and the phase are in here too — an upgrade is not a round event and must not resemble one.
 */
function checkUnchanged(
  instance: DeployedInstance,
  before: VaultReading,
  after: VaultReading,
  targetSha: string,
): Check[] {
  const checks: Check[] = [
    mkCheck(
      `vault${instance.tokenSuffix}.serves_target`,
      "the network now serves the code this checkout built, fetched back and hashed locally",
      targetSha,
      after.servingSha256,
      after.servingSha256 === targetSha,
    ),
    mkCheck(
      `vault${instance.tokenSuffix}.phase_unchanged`,
      "the phase is where it was — an upgrade is not a round event",
      before.phase,
      after.phase,
      before.phase === after.phase,
    ),
    mkCheck(
      `vault${instance.tokenSuffix}.round_unchanged`,
      "the round number did not move",
      before.round,
      after.round,
      before.round === after.round,
    ),
  ];

  const fields = [...new Set([...Object.keys(before.config), ...Object.keys(after.config)])].sort();
  for (const f of fields) {
    const same = sameValue(before.config[f], after.config[f]);
    checks.push(
      mkCheck(
        `vault${instance.tokenSuffix}.config.${f}`,
        `config().${f} survived the upgrade unchanged`,
        before.config[f],
        after.config[f],
        same,
        f === "app_version" && SCHEMA_UNCHANGED
          ? `\`upgrade\` must not advance the schema — only \`migrate\` does, and this upgrade ` +
              `carries no migration. A moved app_version means the new code migrated on load.`
          : `\`upgrade\` replaces the executable and touches Config nowhere. A changed field here ` +
              `is the new code rewriting configuration on load, which no reader would otherwise see.`,
      ),
    );
  }
  return checks;
}

// =================================================================================================
// The run
// =================================================================================================

interface UpgradeOutcome {
  readonly tokenSuffix: string;
  readonly vaultId: string;
  readonly status: "upgraded" | "already-current" | "skipped";
  readonly txHash?: string;
  readonly explorer?: string;
  readonly fromWasmHash: string;
  readonly toWasmHash: string;
}

function identityAddress(identity: string): string {
  // `stellar keys address` resolves the name to the G… it will actually sign with. Asking the CLI
  // rather than reading a config file means the answer comes from the same place the signature
  // will, which is the only version of it that matters.
  return execFileSync("stellar", ["keys", "address", identity], { encoding: "utf8" }).trim();
}

function uploadWasm(identity: string, net: NetworkArgs, localSha: string): string {
  const { stdout, stderr } = runStellar([
    "contract",
    "upload",
    "--wasm",
    VAULT_WASM,
    "--source-account",
    identity,
    "--rpc-url",
    net.rpcUrl,
    "--network-passphrase",
    net.networkPassphrase,
  ]);
  const found = [...new Set(`${stdout}\n${stderr}`.match(/\b[0-9a-f]{64}\b/g) ?? [])];
  const hash = found.find((h) => h === localSha);
  if (hash === undefined) {
    throw new UpgradeError(
      `The upload did not report the hash of the bytes it was given (${localSha}). Hashes seen: ` +
        `${found.join(", ") || "(none)"}.\nstdout:\n${stdout.slice(0, 1500)}`,
    );
  }
  return hash;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const net: NetworkConfig = resolveNetwork();
  const netArgs: NetworkArgs = {
    rpcUrl: resolveRpcUrl(net),
    networkPassphrase: net.networkPassphrase,
  };

  if (!existsSync(VAULT_WASM)) {
    throw new UpgradeError(
      `No wasm at ${VAULT_WASM}. Run \`stellar contract build\` — an upgrade installs the artefact ` +
        `this repository builds, never one found lying around.`,
    );
  }
  const localSha = sha256(readFileSync(VAULT_WASM));

  const record: DeploymentRecord = loadDeployment(net);
  const identity = opts.identity ?? record.deployerIdentity;
  const signer = identityAddress(identity);

  const pins: Pins = readPins(ROOT);
  const observed: Observed = {
    rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }),
    stellar: execFileSync("stellar", ["--version"], { encoding: "utf8" }),
    installedTargets: execFileSync("rustup", ["target", "list", "--installed"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  };
  const sourceTree: SourceTree = readSourceTree(ROOT);

  const targets = record.instances.filter((i) => opts.only === undefined || i.tokenSuffix === opts.only);
  if (targets.length === 0) {
    throw new UpgradeError(
      `--only ${String(opts.only)} matched no instance. Recorded suffixes: ` +
        `${record.instances.map((i) => i.tokenSuffix).join(", ")}.`,
    );
  }

  // ---------------------------------------------------------------------- gates ---
  const gates: Check[] = [
    ...checkSourceTree(sourceTree),
    ...checkToolchain(pins, observed),
    ...checkArtefact(localSha),
  ];

  const readings = new Map<string, VaultReading>();
  for (const t of targets) {
    const reading = readVault(t, identity, netArgs);
    readings.set(t.tokenSuffix, reading);
    gates.push(...checkVault(t, reading, signer, localSha));
  }

  // `not_already_upgraded` is the one gate whose failure is not an error: a vault already serving
  // the target is finished, not broken. It is pulled out here so the rest can still refuse.
  const alreadyCurrent = new Set(
    targets.filter((t) => readings.get(t.tokenSuffix)!.servingSha256 === localSha).map((t) => t.tokenSuffix),
  );
  const blocking = gates.filter((c) => !c.ok && !c.id.endsWith(".not_already_upgraded"));

  console.log(renderChecks(`upgrade — gates (${net.name}, signing as ${identity})`, gates).join("\n"));
  if (blocking.length > 0) {
    throw new UpgradeError(
      `Refusing to upgrade: ${blocking.map((c) => c.id).join(", ")}. Nothing was signed.`,
    );
  }

  const todo = targets.filter((t) => !alreadyCurrent.has(t.tokenSuffix));
  console.log(
    `\n${todo.length} instance(s) to upgrade: ${todo.map((t) => t.tokenSuffix).join(", ") || "(none)"}` +
      `${alreadyCurrent.size > 0 ? `; already current: ${[...alreadyCurrent].join(", ")}` : ""}`,
  );
  console.log(`target wasm: ${localSha} (${readFileSync(VAULT_WASM).length} bytes)`);

  if (opts.dryRun) {
    console.log("\n--dry-run: every gate passed, nothing was signed and nothing was written.");
    return;
  }
  if (todo.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  // -------------------------------------------------------------------- upload ---
  // Once, not per vault: the code is a ledger entry keyed by its own hash, so three vaults share
  // one upload and the second would be refused as a duplicate anyway.
  const installed = uploadWasm(identity, netArgs, localSha);
  console.log(`\nuploaded: ${installed}`);

  // ------------------------------------------------------------------- upgrade ---
  const outcomes: UpgradeOutcome[] = [];
  const verification: Check[] = [];
  const transactions: { label: string; hash: string; explorer: string }[] = [];

  for (const t of todo) {
    const before = readings.get(t.tokenSuffix)!;
    const { stdout, stderr } = runStellar(
      buildInvokeArgv({
        contractId: t.vaultId,
        method: "upgrade",
        identity,
        net: netArgs,
        args: { new_wasm_hash: installed },
      }),
    );
    const txHash = parseTxHash(`${stdout}\n${stderr}`);
    const after = readVault(t, identity, netArgs);
    verification.push(...checkUnchanged(t, before, after, localSha));

    outcomes.push({
      tokenSuffix: t.tokenSuffix,
      vaultId: t.vaultId,
      status: "upgraded",
      ...(txHash === null ? {} : { txHash, explorer: explorerTxUrl(net, txHash) }),
      fromWasmHash: before.servingSha256,
      toWasmHash: after.servingSha256,
    });
    if (txHash !== null) {
      transactions.push({
        label: `upgrade:vault${t.tokenSuffix}`,
        hash: txHash,
        explorer: explorerTxUrl(net, txHash),
      });
    }
    console.log(`upgraded vault${t.tokenSuffix} (${t.vaultId}) tx=${txHash ?? "(unreported)"}`);
  }

  for (const s of alreadyCurrent) {
    const inst = targets.find((t) => t.tokenSuffix === s)!;
    outcomes.push({
      tokenSuffix: s,
      vaultId: inst.vaultId,
      status: "already-current",
      fromWasmHash: localSha,
      toWasmHash: localSha,
    });
  }

  console.log(`\n${renderChecks("upgrade — verification", verification).join("\n")}`);

  // -------------------------------------------------------------------- record ---
  // Written even when verification fails, and that is deliberate: the transactions landed, so a
  // record that omits them would describe a chain state that no longer exists. The failure is
  // raised after the write, not instead of it.
  const path = deploymentPath(net.name);
  const prior = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const upgradedAt = new Date().toISOString();
  const toolchain = {
    rust: pins.rust,
    stellarCli: pins.stellarCli,
    sorobanSdk: pins.sorobanSdk,
    target: pins.targets[0] ?? "(none)",
    node: process.version,
    buildHost: buildHost(),
  };

  const upgradedSuffixes = new Set(outcomes.filter((o) => o.status === "upgraded").map((o) => o.tokenSuffix));
  const instances = (prior["instances"] as Record<string, unknown>[]).map((inst) =>
    upgradedSuffixes.has(String(inst["tokenSuffix"]))
      ? { ...inst, vaultWasmHash: localSha, upgradedAt, sourceTree, toolchain }
      : inst,
  );

  const next = {
    ...prior,
    // Top-level `vaultWasmHash` describes the most recent run, exactly as `deployedAt` does. It is
    // wrong for an instance that was not in this run, which is why each instance carries its own.
    vaultWasmHash: localSha,
    instances,
    transactions: [...((prior["transactions"] as unknown[] | undefined) ?? []), ...transactions],
    upgrades: [
      ...((prior["upgrades"] as unknown[] | undefined) ?? []),
      {
        upgradedAt,
        fromWasmHash: [...new Set(outcomes.map((o) => o.fromWasmHash))],
        toWasmHash: localSha,
        instances: outcomes.map((o) => ({
          tokenSuffix: o.tokenSuffix,
          status: o.status,
          ...(o.txHash === undefined ? {} : { tx: o.txHash }),
        })),
        sourceTree,
        toolchain,
        verdict: allPassed(verification) ? "PASS" : "FAIL",
      },
    ],
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nrecorded -> ${path}`);

  if (opts.jsonOut !== undefined) {
    writeFileSync(
      opts.jsonOut,
      `${JSON.stringify({ tool: "scripts/upgrade.ts", network: net.name, upgradedAt, targetWasmHash: localSha, outcomes, gates, verification, sourceTree, toolchain }, null, 2)}\n`,
    );
    console.log(`report   -> ${opts.jsonOut}`);
  }

  if (!allPassed(verification)) {
    throw new UpgradeError(
      `The upgrade landed but verification failed: ${failedIds(verification).join(", ")}. The ` +
        `record was written because the transactions are real; read it, then decide.`,
    );
  }
}

// Mirrors `deploy.ts`: the module stays importable for tests, and only a direct run executes.
if (process.argv[1]?.endsWith("upgrade.ts")) {
  try {
    main();
  } catch (err) {
    console.error(`\nREFUSED. ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
