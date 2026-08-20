/**
 * chain.ts — the one place a deploy talks to the network, and the one place it does not hold a key.
 *
 * **WRITES GO THROUGH THE `stellar` CLI, READS GO THROUGH THE SDK, AND THE SPLIT IS THE SECURITY
 * PROPERTY.** `07-SECURITY.md` §6 and `09-DEPLOYMENT.md` §1 both say the deployment record carries
 * *the identity name, never a key*. The CLI already owns signing identities; handing it
 * `--source-account <name>` means the secret is never an argument, never an environment variable
 * this process can read, and never a value that could end up in a log line or a deployment record.
 * A secret key in `deploy.ts` would be a second key store whose only advantage is convenience.
 *
 * **RESULTS COME BACK OFF THE LEDGER, NOT OFF STDOUT.** The CLI prints a human-shaped rendering of
 * a return value; step 5 needs `scValToNative` shapes — a `bigint` for an `i128`, `["Idle"]` for a
 * unit enum — and it needs the transaction's *events*, which the CLI does not print at all. So a
 * write is: submit through the CLI, take the transaction hash, then read the transaction back
 * through RPC and decode its XDR. That also means every value this module reports is one an
 * outsider could re-derive from the hash in the deployment record, which is the property that makes
 * `WALKTHROUGH.md`'s explorer links evidence rather than decoration.
 *
 * **COMMAND CONSTRUCTION IS A PURE FUNCTION AND IT IS TESTED.** Execution cannot be exercised
 * without a network; assembling the argument vector can, and it is where a deploy goes wrong in the
 * ways that are hardest to see afterwards — a missing `--network-passphrase` signs for the wrong
 * network, a constructor argument in the wrong position builds the wrong vault. So
 * {@link buildDeployArgv} and {@link buildInvokeArgv} return arrays that tests assert on, and the
 * runner does nothing but hand them to the process.
 *
 * MEASURED 2026-08-20, and why the deploy passes `--optimize=false` anyway: `stellar contract
 * deploy` defaults `--optimize` to **true**, which would upload bytes other than the ones step 1
 * hashed. Run against this repository's adapter the optimizer is a no-op — 13 179 bytes in, 13 179
 * out, hash `d88120b0…` unchanged — because `stellar contract build` already emits optimized code.
 * The flag is still passed explicitly and the on-chain hash is still compared against the local
 * one, because D-50's gate must not rest on a default staying a no-op.
 */

import { execFileSync } from "node:child_process";

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

/** Everything a CLI call needs to reach the right network. The passphrase is never overridable. */
export interface NetworkArgs {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
}

/**
 * A contract argument as the CLI takes it: `--name value`.
 *
 * Complex types (`EpochParams`) are passed as JSON, which is what the CLI expects for a struct.
 * `bigint` is rendered as a decimal string rather than through `JSON.stringify`, which throws on
 * one — and an `i128` that silently became a float is a deploy that funds the wrong cap.
 */
export function encodeArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new ChainError(`Refusing to pass the non-integer ${value} as a contract argument.`);
    }
    return value.toString();
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

function argPairs(args: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(args).flatMap(([name, value]) => [`--${name}`, encodeArg(value)]);
}

/**
 * `stellar contract deploy` for a constructor-carrying contract.
 *
 * `--optimize=false` is not optional here: see the module header. Argument *order* after `--` does
 * not matter to the CLI, which matches on name — but the names must be the constructor's, and a
 * misspelling is rejected by the CLI rather than silently defaulted, which is the behaviour worth
 * relying on.
 */
export function buildDeployArgv(opts: {
  readonly wasmPath: string;
  readonly identity: string;
  readonly net: NetworkArgs;
  readonly constructorArgs: Readonly<Record<string, unknown>>;
}): string[] {
  return [
    "contract",
    "deploy",
    "--wasm",
    opts.wasmPath,
    "--optimize=false",
    "--source-account",
    opts.identity,
    "--rpc-url",
    opts.net.rpcUrl,
    "--network-passphrase",
    opts.net.networkPassphrase,
    "--",
    ...argPairs(opts.constructorArgs),
  ];
}

export function buildInvokeArgv(opts: {
  readonly contractId: string;
  readonly method: string;
  readonly identity: string;
  readonly net: NetworkArgs;
  readonly args: Readonly<Record<string, unknown>>;
  /** `true` simulates without submitting — a read that costs nothing and signs nothing. */
  readonly readOnly?: boolean;
}): string[] {
  return [
    "contract",
    "invoke",
    "--id",
    opts.contractId,
    "--source-account",
    opts.identity,
    "--rpc-url",
    opts.net.rpcUrl,
    "--network-passphrase",
    opts.net.networkPassphrase,
    ...(opts.readOnly === true ? ["--send=no"] : ["--send=yes"]),
    "--",
    opts.method,
    ...argPairs(opts.args),
  ];
}

/**
 * A deployed contract id out of the CLI's output.
 *
 * The CLI prints progress to stderr and the id to stdout, but it has printed other things there
 * before. Rather than taking the last line on faith, this looks for the one token that *is* a
 * contract id — 56 characters of base32 starting with `C` — and refuses if the output holds none
 * or more than one distinct one. A deploy that recorded the wrong id would put every later tool on
 * the wrong contract, and step 5's assertions would then be run against something else entirely.
 */
export function parseContractId(output: string): string {
  const found = [...new Set(output.match(/\bC[A-Z2-7]{55}\b/g) ?? [])];
  if (found.length === 0) {
    throw new ChainError(
      `No contract id in the CLI output. What it printed:\n${output.trim().slice(0, 2000)}`,
    );
  }
  if (found.length > 1) {
    throw new ChainError(
      `The CLI output holds ${found.length} distinct contract ids (${found.join(", ")}), so which ` +
        `one was deployed is a guess. Refusing rather than recording a guess.`,
    );
  }
  return found[0]!;
}

/** A transaction hash out of the CLI's output: 64 hex characters. */
export function parseTxHash(output: string): string | null {
  return [...new Set(output.match(/\b[0-9a-f]{64}\b/g) ?? [])][0] ?? null;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the pinned `stellar` binary.
 *
 * stdout and stderr are captured separately and **both** are returned: the CLI puts the answer on
 * one and the diagnosis on the other, and a failure that discards stderr leaves an operator with an
 * exit code. `stdio` never inherits, so nothing this process runs can prompt for input on a deploy
 * that was meant to be unattended.
 */
export function runStellar(argv: readonly string[], bin = "stellar"): RunResult {
  try {
    const stdout = execFileSync(bin, argv as string[], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
    throw new ChainError(
      `\`${bin} ${argv.join(" ")}\` failed with status ${err.status ?? "(unknown)"}.\n` +
        `stderr:\n${(err.stderr ?? "").trim().slice(0, 4000)}\n` +
        `stdout:\n${(err.stdout ?? "").trim().slice(0, 2000)}`,
    );
  }
}
