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

import { spawn, spawnSync } from "node:child_process";

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

/**
 * `--name value`, except when the value would be mistaken for another flag.
 *
 * A value starting with `-` is parsed by clap as an option, not as this option's argument, and the
 * deploy dies with `unexpected argument '-F' found` — measured on the pinned CLI on 2026-08-20,
 * where `token_suffix` is literally `-F` and every fast-test and experiment suffix is. Negative
 * `i128` arguments are the same shape. The `--name=value` form is unambiguous, so it is used
 * exactly where the ambiguity exists rather than everywhere, which keeps the ordinary case readable
 * in a failure message.
 */
function argPairs(args: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(args).flatMap(([name, value]) => {
    const encoded = encodeArg(value);
    return encoded.startsWith("-") ? [`--${name}=${encoded}`] : [`--${name}`, encoded];
  });
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
  /**
   * Maximum inclusion fee, in stroops. Omitted means the CLI's own default.
   *
   * **A bid, not a charge.** Stellar takes the market-clearing fee and refunds the rest, so raising
   * this costs nothing when the network is quiet and is the only thing that helps when it is not.
   * Measured 2026-08-20: a scenario run reached stage 6 with both bids filled and then lost the
   * round to `TxInsufficientFee` on a mock `fill` — the CLI's default was below the ledger's floor
   * by the time the transaction applied. Simulation cannot see that coming, because the floor moves
   * between simulation and apply, which is the same gap D-84 is about one layer down.
   */
  readonly maxFee?: number;
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
    ...(opts.maxFee === undefined ? [] : ["--fee", String(opts.maxFee)]),
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

/**
 * Every transaction hash the CLI reported, in the order it submitted them.
 *
 * **Anchored on the CLI's own label, never on the shape of the string, and that is a bug fix rather
 * than a preference.** A wasm hash is also 64 hex characters, and `stellar contract deploy` prints
 * *"Deploying contract using wasm hash 908dde6d…"* **before** *"Signing transaction: e4266667…"* —
 * so a bare `[0-9a-f]{64}` match returns the wasm hash as the transaction hash, confidently and
 * silently. Measured on the pinned CLI, 2026-08-20.
 *
 * **All of them, because one command is not one transaction.** A `contract deploy` against a wasm
 * the network has not seen submits two — the upload and the create — and prints a label for each;
 * against one already installed it prints *"Skipping install because wasm already installed"* and
 * submits only the create. A caller that took the first hash would record the upload as the
 * deployment, and a caller that took the last would record nothing at all on the runs where it
 * mattered.
 *
 * Both streams are scanned. The CLI puts the answer on stdout and the diagnosis on stderr, and this
 * label lives on stderr today — but which stream a diagnostic lands on is the CLI's business, and a
 * parser that depends on it would break on a release note nobody read.
 */
export function parseTxHashes(output: string): string[] {
  return [...output.matchAll(/Signing transaction:\s*([0-9a-f]{64})\b/g)].map((m) => m[1]!);
}

/** The first transaction a command submitted, or `null` if it submitted none (a simulation does not). */
export function parseTxHash(output: string): string | null {
  return parseTxHashes(output)[0] ?? null;
}

/** True when the CLI reported that the wasm was already installed, so no upload was submitted. */
export function skippedUpload(output: string): boolean {
  return /Skipping install because wasm already installed/.test(output);
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
  // `spawnSync`, not `execFileSync`, and the difference is the whole point of this function.
  // `execFileSync` RETURNS ONLY STDOUT: piping stderr makes it available on the thrown error and
  // nowhere else, so on the success path it is discarded. This header used to claim both streams
  // were returned while the code returned an empty string for one of them — and the consequence
  // was not cosmetic, because the CLI prints `Signing transaction: <hash>` on stderr. Every
  // transaction hash a successful deploy reported was being thrown away, and step 6's own check is
  // what caught it.
  const r = spawnSync(bin, argv as string[], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (r.error !== undefined) {
    throw new ChainError(`Could not run \`${bin}\`: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new ChainError(
      `\`${bin} ${argv.join(" ")}\` failed with status ${r.status ?? "(signalled)"}.\n` +
        `stderr:\n${stderr.trim().slice(0, 4000)}\n` +
        `stdout:\n${stdout.trim().slice(0, 2000)}`,
    );
  }
  return { stdout, stderr };
}

/**
 * The same call, asynchronous, so two of them can be in flight at once.
 *
 * **This exists for exactly one situation and it is worth naming.** `06-TEST-PLAN.md` §7 scenario 1
 * needs two bidders to partially fill one auction, and at the fast-test profile the auction is 20
 * seconds against a ledger that closes in about five — three to four ledgers wide. Two bids
 * submitted one after the other spend a confirmation round trip each and can miss the window; two
 * submitted together from **two different accounts** have independent sequence numbers and can land
 * in the same ledger. `spawnSync` cannot express that, and a harness that fails intermittently is
 * worse than no harness.
 *
 * Everything else matches {@link runStellar} deliberately, down to the error text: two ways to run
 * the same binary that report failure differently would be a second thing to learn.
 */
export function runStellarAsync(argv: readonly string[], bin = "stellar"): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv as string[], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => reject(new ChainError(`Could not run \`${bin}\`: ${e.message}`)));
    child.on("close", (status) => {
      if (status !== 0) {
        reject(
          new ChainError(
            `\`${bin} ${argv.join(" ")}\` failed with status ${status ?? "(signalled)"}.\n` +
              `stderr:\n${stderr.trim().slice(0, 4000)}\n` +
              `stdout:\n${stdout.trim().slice(0, 2000)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
