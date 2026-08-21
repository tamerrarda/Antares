/**
 * The shell every scenario in this directory runs inside.
 *
 * Extracted from `scenario1.ts` on 2026-08-21, when scenarios 4 and 5 arrived and the alternative
 * was three copies of the same runner. Nothing here is scenario-specific: a stage, the context a
 * stage reads, the transaction-hash recorder, and the rule that a thrown call is reported as a
 * failed `Check` with the contract's error code pulled to the front rather than as a stack trace.
 *
 * **That last one is the piece worth keeping shared.** Two of the first four live runs would
 * otherwise have ended with `Error(Contract, #13)` buried in eighteen lines of diagnostic events,
 * and the code is the whole answer.
 */

import { allPassed, failedIds, mkCheck, renderChecks, type Check } from "@antares/common/checks";
import type { NetworkArgs } from "@antares/common/chain";
import { isNetworkName, networkConfig, resolveRpcUrl } from "@antares/common/networks";

import { addressOf, makeReader, type Reader, type ResourceCost } from "./read.ts";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type { NetworkArgs };
export { allPassed, failedIds, mkCheck, renderChecks, type Check };

/**
 * Every flag any scenario in this directory takes.
 *
 * One type rather than three, because they are flags of one harness and a scenario that ignores a
 * field costs nothing — while three near-identical option types would be exactly the duplication
 * this file was extracted to remove.
 */
export interface Options {
  readonly network: string;
  readonly admin: string;
  readonly depositor: string;
  readonly bidderA: string;
  readonly bidderB: string;
  readonly record: string;
  readonly deposit: bigint;
  readonly notionalA: bigint;
  readonly notionalB: bigint;
  readonly maxPremiumBps: number;
  readonly preflight: boolean;
  readonly diffOnly: boolean;
  /** Scenario 5: the wasm hash to upgrade to. Defaults to the previous release in the record's history. */
  readonly markerWasm: string;
}

export function parseOptions(argv: readonly string[], root: string): Options {
  const value = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  const network = process.env["NETWORK"] ?? "";
  return {
    network,
    admin: value("admin", "antares-testnet"),
    depositor: value("depositor", value("admin", "antares-testnet")),
    bidderA: value("bidder-a", "antares-bidder-a"),
    bidderB: value("bidder-b", "antares-bidder-b"),
    record: value("record", join(root, "deployments", `${network || "testnet"}.json`)),
    deposit: BigInt(value("deposit", "100000000")),
    notionalA: BigInt(value("notional-a", "0")),
    notionalB: BigInt(value("notional-b", "0")),
    maxPremiumBps: Number(value("max-premium-bps", "10000")),
    preflight: argv.includes("--preflight"),
    diffOnly: argv.includes("--diff-only"),
    markerWasm: value("marker-wasm", ""),
  };
}

interface DeploymentRecord {
  readonly oracleId: string;
  readonly instances: readonly {
    readonly tokenSuffix: string;
    readonly vaultId: string;
    readonly createTx: string;
    readonly params: Readonly<Record<string, number>>;
    readonly economicallyMeaningless?: boolean;
  }[];
}

interface EpochView {
  readonly round: number;
  readonly phase: readonly string[] | string;
  readonly notional_offered: bigint;
  readonly notional_sold: bigint;
  readonly premium_collected: bigint;
  readonly strike: bigint;
  readonly open_twap: bigint;
  readonly opened_at: bigint;
  readonly auction_end: bigint;
  readonly expiry: bigint;
  readonly shares_outstanding: bigint;
  readonly last_pps: bigint;
}

export interface Ctx {
  readonly opts: Options;
  readonly net: NetworkArgs;
  readonly root: string;
  readonly reader: Reader;
  readonly vault: string;
  readonly oracle: string;
  readonly params: Readonly<Record<string, number>>;
  readonly createTx: string;
  readonly addresses: { admin: string; depositor: string; bidderA: string; bidderB: string };
  /** Every transaction this run submitted, so the report is re-derivable from hashes alone. */
  readonly txs: { label: string; hash: string }[];
  /**
   * Resource costs for the two entry points a standalone profile cannot reach.
   *
   * `scripts/profile-resources.ts` measures 26 of 38 by simulating against the deployed instance;
   * the twelve it misses are refused in a resting vault, and a refused simulation carries no
   * `transactionData` at all. `bid` and `close_round` are in that twelve AND are the two whose
   * cost grows with the round's contents, so they are measured here, where the state exists.
   */
  readonly costs: { bid?: ResourceCost | null; closeRound?: ResourceCost | null };
  round?: number;
  openedAt?: number;
  auctionEnd?: number;
  expiry?: number;
  strike?: bigint;
}

/** Record a transaction hash off the CLI's own output, so the run's evidence is hashes. */
function record(ctx: Ctx, out: { stdout: string; stderr: string }, label: string): void {
  const combined = `${out.stdout}\n${out.stderr}`;
  for (const m of combined.matchAll(/Signing transaction:\s*([0-9a-f]{64})\b/g)) {
    ctx.txs.push({ label, hash: m[1]! });
  }
}

export interface Stage {
  readonly id: string;
  readonly title: string;
  run(ctx: Ctx): Promise<Check[]>;
}

export class ScenarioRefused extends Error {
  // An explicit field rather than a parameter property: `erasableSyntaxOnly` forbids the latter,
  // because `--experimental-strip-types` erases types without emitting the assignment they imply.
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = "ScenarioRefused";
    this.stage = stage;
  }
}

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate the repository root.");
}

/**
 * A thrown call, reported the way every other result here is reported.
 *
 * The contract's error code is pulled to the front. `Error(Contract, #10)` buried in eighteen lines
 * of diagnostic events is the same information as "the vault refused with error 10", and only one of
 * the two can be read at a glance — which matters most at exactly the moment something failed.
 */
/** The contract's own error, pulled to the front of whatever the CLI printed around it. */
export function contractError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  return code === undefined ? (message.split("\n")[0] ?? "(no message)") : `Error(Contract, #${code})`;
}

/**
 * The diagnostic events, in the order worth reading them.
 *
 * A Soroban failure prints the innermost call last and the escalation first, so the line that says
 * WHY is usually in the middle of a wall of text. This lifts the oracle's answer out, because a feed
 * that cannot be read makes most entry points refuse and reading the vault's code first sends the
 * reader to the wrong module.
 */
export function diagnose(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const parts: string[] = [];
  const oracle = /fn_return, (reading|spot_check)\], data:\[?(\w+)/.exec(message);
  if (oracle !== null) parts.push(`The oracle answered \`${oracle[2]}\` to \`${oracle[1]}\`.`);
  const inner = [...message.matchAll(/topics:\[fn_call, \w+, (\w+)\]/g)].map((m) => m[1]);
  if (inner.length > 0) parts.push(`Call chain: ${[...new Set(inner)].reverse().join(" -> ")}.`);
  if (/ResourceLimitExceeded/.test(message)) {
    parts.push(
      "ResourceLimitExceeded. If this was a `fill` on mock-price-source, the cause is structural " +
        "rather than transient: the mock keeps EVERY record ever written in a single Map in " +
        "INSTANCE storage, so each fill reads the whole map, adds its ticks and writes the whole " +
        "map back. Successive primes write disjoint tick ranges, so the map grows monotonically — " +
        "about 240 entries per scenario run at this profile — and after a handful of runs one fill " +
        "no longer fits in one transaction. It cannot be pruned: the fixture exposes clear_price " +
        "for one tick and nothing that empties it. A repeatable harness therefore has to start " +
        "from a FRESHLY DEPLOYED mock, and the vault takes its oracle at construction with no " +
        "setter, so that means a fresh vault too.",
    );
  }
  // The whole message, trimmed rather than summarised. A submission failure carries its reason
  // across several lines — \`transaction submission failed: Some(...)\` is a prefix, not an answer —
  // and a regex that stops at the first newline turns the one useful line into a truncated one.
  parts.push(message.replace(/\s+/g, " ").slice(0, 2000));
  return parts.join(" ");
}

function asFailure(stage: Stage, err: unknown): Check {
  const message = err instanceof Error ? err.message : String(err);
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  const reading = /fn_return, reading\], data:\[(\w+)\]/.exec(message)?.[1];
  return mkCheck(
    `stage${stage.id}.threw`,
    `stage ${stage.id} completed without the chain refusing it`,
    "no refusal",
    code === undefined ? message.split("\n")[0] : `Error(Contract, #${code})`,
    false,
    [
      code === undefined ? null : `The vault refused with contract error ${code}.`,
      reading === undefined
        ? null
        : `The oracle answered \`${reading}\` — read that before reading the vault's code, because a feed that cannot be read makes almost every entry point refuse.`,
      message.slice(0, 1500),
    ]
      .filter((l): l is string => l !== null)
      .join(" "),
  );
}

/** The phase name, whether `scValToNative` hands back `["Idle"]` or `"Idle"`. */
export const phaseName = (p: EpochView["phase"]): string => (Array.isArray(p) ? String(p[0]) : String(p));

export type { DeploymentRecord, EpochView };

/** Everything a scenario needs before its first stage: the record, the identities, a reader. */
export async function makeCtx(opts: Options): Promise<Ctx | null> {
  if (!isNetworkName(opts.network)) return null;
  const cfg = networkConfig(opts.network);
  const net: NetworkArgs = { rpcUrl: resolveRpcUrl(cfg), networkPassphrase: cfg.networkPassphrase };
  const rec = JSON.parse(readFileSync(opts.record, "utf8")) as DeploymentRecord;
  const inst = rec.instances[0];
  if (inst === undefined) throw new ScenarioRefused("0", `${opts.record} names no instance to drive.`);
  const addresses = {
    admin: addressOf(opts.admin),
    depositor: addressOf(opts.depositor),
    bidderA: addressOf(opts.bidderA),
    bidderB: addressOf(opts.bidderB),
  };
  return {
    opts,
    net,
    root: repoRoot(),
    reader: await makeReader(net, addresses.admin),
    vault: inst.vaultId,
    oracle: rec.oracleId,
    params: inst.params,
    createTx: inst.createTx,
    addresses,
    txs: [],
    costs: {},
  };
}

/**
 * Run stages in order, stopping at the first that fails.
 *
 * Returns whether everything passed, so a caller can set an exit code without re-deriving it — and
 * prints the transactions afterwards either way, because the evidence of a FAILED run is worth as
 * much as the evidence of a passing one.
 */
export async function runStages(stages: readonly Stage[], ctx: Ctx): Promise<boolean> {
  let ok = true;
  for (const stage of stages) {
    console.log(`\nstage ${stage.id} — ${stage.title}`);
    const checks = await stage.run(ctx).catch((err: unknown) => [asFailure(stage, err)]);
    console.log(renderChecks("", checks).slice(1).join("\n"));
    if (!allPassed(checks)) {
      console.error(`\nREFUSED at stage ${stage.id}: ${failedIds(checks).join(", ")}`);
      ok = false;
      break;
    }
  }
  console.log(`\ntransactions this run submitted — the evidence, and all of it public:`);
  if (ctx.txs.length === 0) console.log("  (none — nothing was submitted)");
  for (const t of ctx.txs) console.log(`  ${t.label.padEnd(24)} ${t.hash}`);
  return ok;
}

export { record };

/** Structural, so `harness.ts` need not import the invoker it is handed. */
interface InvokeLike {
  readonly contractId: string;
  readonly method: string;
  readonly identity: string;
  readonly net: NetworkArgs;
  readonly args?: Readonly<Record<string, unknown>>;
}
interface RunLike {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Put the bidders on the allowlist if the gate is live, and do nothing if it is not.
 *
 * Shared because every scenario that bids needs it, and forgetting it fails as
 * `Error(Contract, #30)` — `AllowlistForbidden` — at the bid, four transactions after the point
 * where it could have been fixed. That is how scenario 4's first live run ended. The vault ships
 * with the allowlist ON and an expiry inside two weeks (D-63), so on a freshly deployed instance
 * this is never a no-op.
 *
 * Idempotent by construction: setting an already-allowed bidder is a call the contract accepts, so
 * this neither reads the entries first nor branches on them.
 */
export async function ensureAllowed(ctx: Ctx, invoke: (spec: InvokeLike) => RunLike): Promise<boolean> {
  const cfg = await ctx.reader.read<{ allowlist_enabled: boolean }>(ctx.vault, "config");
  if (!cfg.allowlist_enabled) return false;
  for (const [who, addr] of [
    ["bidder-a", ctx.addresses.bidderA],
    ["bidder-b", ctx.addresses.bidderB],
  ] as const) {
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "set_allowed",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { bidder: addr, allowed: true },
      }),
      `allow:${who}`,
    );
  }
  return true;
}
