/**
 * The reader for `deployments/<network>.json` — the other exempt path, and the only place a
 * contract id is allowed to exist.
 *
 * `09-DEPLOYMENT.md` §1: *"Every deployed instance gets a committed record: contract ids, wasm
 * hashes, constructor args, deployer identity name, date, and the params used. Reproducibility over
 * memory."* §2 step 6 writes it; `DEV3.md` says *"every other tool reads its addresses from here"*,
 * and this module is what makes that literally true instead of a convention.
 *
 * **`deploy.ts` is the authority on the schema, not this file.** It is written in Phase 6 and it is
 * what produces the record; the types below are the shape those documents already specify, so that
 * the keeper, the bidder and all four UI pages can be compiled against something today rather than
 * waiting for Phase 6 to start. Where a field is required by a named step it is required here; where
 * a step is still unwritten the field is optional rather than invented.
 *
 * Note the file this does **not** read: `deployments/environment-testnet.json` is
 * `verify-environment.ts`'s measurement record (D-49, DEV2's file) and a different document with a
 * different lifecycle. Its numbers are evidence about the feed; these are addresses.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NetworkConfigError, type NetworkConfig, type NetworkName } from "./networks.ts";

/**
 * One vault instance. Five of these are deployed concurrently in product Phase 2 (D-47/D-57), each
 * with its own `token_suffix` — `09-DEPLOYMENT.md` §2 step 4d, and `08-OFFCHAIN.md` §3's rule that
 * *"five vaults are an experiment, not a menu"*.
 */
export interface DeployedInstance {
  /** `aXLM-A` … `aXLM-E`'s suffix: `A`…`E`, or the empty string for a lone deployment. */
  readonly tokenSuffix: string;
  readonly vaultId: string;
  /** The wasm hash this instance was deployed from — D-50's gate compares this and nothing else. */
  readonly vaultWasmHash: string;
  /** The `EpochParams` this instance was constructed with (`02-CONTRACT-SPEC.md` §1). */
  readonly params: Readonly<Record<string, number | string>>;
  /**
   * True when this instance was deployed from a `--fast-test` profile.
   *
   * `09-DEPLOYMENT.md` §2 step 0b: the profile *"stamps the deployment record as economically
   * meaningless (mechanism testing only, never demand evidence)"*, which is what **permanently
   * disqualifies it from Phase 6b**. It is a property of the record rather than of the operator's
   * memory precisely so that a fast-test round can never be presented as demand evidence later.
   */
  readonly economicallyMeaningless: boolean;
}

export interface DeploymentRecord {
  readonly network: NetworkName;
  /** ISO date of the deploy. */
  readonly deployedAt: string;
  /** The identity *name*, never a key (07-SECURITY §6). */
  readonly deployerIdentity: string;
  /** Shared across every instance in the set (`09-DEPLOYMENT.md` §2 step 4d). */
  readonly assetId: string;
  readonly oracleId: string;
  readonly oracleWasmHash: string;
  /**
   * The pinned Reflector contract, when the oracle is the real adapter rather than the mock.
   * Absent on fast-test deployments, which have *"no Reflector to interrogate"* (§2 step 3c).
   */
  readonly reflectorId?: string;
  readonly instances: readonly DeployedInstance[];
  /**
   * Reserved for the upgrade script's step 6, and **nothing writes it yet.**
   *
   * `upgrade.ts` is Phase 5's remaining tool and does not exist; the 2026-08-21 upgrade drill ran
   * without it and no record carries this field. It is optional for that reason rather than for a
   * semantic one, and the comment said "appended by" until 2026-08-23, which named a writer a
   * reader could not find.
   */
  readonly history?: readonly Readonly<Record<string, unknown>>[];
}

export class DeploymentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentNotFoundError";
  }
}

/**
 * Walk up from this module until a directory holds `pnpm-workspace.yaml`.
 *
 * Deliberately not a fixed number of `..` segments: this file is imported from `dist/` once built
 * and from source under `--experimental-strip-types`, and those sit at different depths. A relative
 * count that is right in one of them is silently wrong in the other.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new DeploymentNotFoundError(
    "Could not locate the repository root (no pnpm-workspace.yaml found above this module).",
  );
}

export function deploymentPath(
  network: NetworkName,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env["DEPLOYMENTS_DIR"];
  const dir = override !== undefined && override !== "" ? resolve(override) : join(repoRoot(), "deployments");
  return join(dir, `${network}.json`);
}

/**
 * Load and validate the record for a network.
 *
 * Fails loudly and with the reason when the file does not exist. That case is the ordinary one right
 * now — nothing is deployed — and the message names the step that creates it, because "ENOENT" sent
 * a reader to the wrong question the last time a tool in this repository did that.
 */
export function loadDeployment(
  net: NetworkConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentRecord {
  const path = deploymentPath(net.name, env);
  if (!existsSync(path)) {
    throw new DeploymentNotFoundError(
      `No deployment record at ${path}. Nothing is deployed on ${net.name} yet, or the record was ` +
        `never committed — 09-DEPLOYMENT §2 step 6 writes it and step 6 is the last step of deploy.ts. ` +
        `Contract ids live only here and in nothing else (06-TEST-PLAN §8), so there is deliberately ` +
        `no fallback to read instead.`,
    );
  }

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new DeploymentNotFoundError(`${path} is not a JSON object.`);
  }
  const record = parsed as DeploymentRecord;

  // The network the record claims must be the network we asked for. A record copied between files
  // is the one way a tool ends up sending a testnet id to a mainnet RPC while every value in the
  // process still says testnet.
  if (record.network !== net.name) {
    throw new NetworkConfigError(
      `${path} declares network "${String(record.network)}" but was loaded as "${net.name}".`,
    );
  }
  for (const field of ["deployedAt", "deployerIdentity", "assetId", "oracleId"] as const) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new DeploymentNotFoundError(`${path} is missing required field "${field}".`);
    }
  }
  if (!Array.isArray(record.instances) || record.instances.length === 0) {
    throw new DeploymentNotFoundError(`${path} carries no instances.`);
  }
  return record;
}

/**
 * One instance by `token_suffix`.
 *
 * The suffix is the identity `09-DEPLOYMENT.md` §2 step 5 asserts against (`symbol()` equals `aXLM`
 * plus the suffix that was passed), which makes it the right key: it is the one instance property
 * that is checked on-chain rather than only recorded off it.
 */
export function instanceBySuffix(record: DeploymentRecord, tokenSuffix: string): DeployedInstance {
  const found = record.instances.find((i) => i.tokenSuffix === tokenSuffix);
  if (found === undefined) {
    const known = record.instances.map((i) => `"${i.tokenSuffix}"`).join(", ");
    throw new DeploymentNotFoundError(
      `No instance with token_suffix "${tokenSuffix}" in this deployment. Known: ${known}.`,
    );
  }
  return found;
}

/**
 * Every vault id in the set.
 *
 * The keeper takes **contract ids, plural** — `08-OFFCHAIN.md` §1 and D-47: *"Phase 2 runs five
 * vaults from one process"*. A helper returning one id would make the singular the easy path and
 * the plural the thing somebody remembers, which is backwards.
 */
export function allVaultIds(record: DeploymentRecord): readonly string[] {
  return record.instances.map((i) => i.vaultId);
}
