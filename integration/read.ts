/**
 * Reading the chain: view calls by simulation, events by `getEvents`, ledger time by RPC.
 *
 * # Why this is not `deploy.ts`'s reader
 *
 * `scripts/deploy.ts` has a `makeChainClient` that does the same simulate-and-decode. It is bound to
 * that script's `Ctx` and throws its `DeployRefused`, so sharing it means refactoring the deploy
 * path — and the deploy path is the one thing in this repository with seventy live assertions and
 * two verified testnet runs behind it. **Named rather than quietly duplicated**: the two should be
 * one, the merge belongs in a change whose subject is the merge, and this comment is the marker.
 *
 * # The write side is the CLI, and that is a security decision rather than a convenience
 *
 * 07-SECURITY §6: the secret never reaches this process. Every mutation goes through
 * `stellar contract invoke --source-account <identity-name>`, so the harness holds identity NAMES
 * and the CLI holds keys — the same posture the deploy takes, and the reason the deployment record
 * can name an identity at all.
 */

import { runStellar, runStellarAsync, buildInvokeArgv, type NetworkArgs } from "@antares/common/chain";
import { withBackoff } from "@antares/common/retry";

export interface Reader {
  /** A view call, by simulation. Never signs, never submits. */
  read<T>(contractId: string, method: string, args?: readonly unknown[]): Promise<T>;
  /** Contract events from `startLedger` forward, native-decoded, with their transaction hashes. */
  rawEvents(
    contractId: string,
    startLedger: number,
  ): Promise<{ topics: unknown[]; data: unknown; txHash: string; ledger: number }[]>;
  /** The ledger a transaction landed in — §7's "from transaction hashes" made literal. */
  ledgerOf(txHash: string): Promise<number>;
  getLatestLedger(): Promise<{ sequence: number; closeTime: string | number }>;
}

/**
 * An argument whose ScVal type the caller states, because this reader cannot infer it.
 *
 * **Measured, and it cost a run.** `nativeToScVal(1)` does not produce a `u32`, and the SDK's
 * generated argument dispatch answers a type mismatch with `unreachable` — so
 * `bidder_position(1, addr)` came back as `Error(WasmVm, InvalidAction)` and
 * `"VM call trapped: UnreachableCodeReached"`, which reads exactly like a panic inside the view.
 * It is not: the same call with an explicit `u32` returns the position.
 *
 * This is the class of bug `packages/bindings` exists to make impossible, and the honest note is
 * that the reader below does not use them. It cannot: half its calls go to `mock-price-source`,
 * which has no generated client. So the ABI knowledge the bindings hold is supplied here one
 * argument at a time, explicitly, rather than guessed.
 */
export interface TypedArg {
  readonly scvType: "u32" | "u64" | "i128";
  readonly value: number | bigint;
}

export const u32 = (value: number): TypedArg => ({ scvType: "u32", value });
export const u64 = (value: number | bigint): TypedArg => ({ scvType: "u64", value });

const isTyped = (v: unknown): v is TypedArg =>
  typeof v === "object" && v !== null && "scvType" in v && "value" in v;

export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadError";
  }
}

/**
 * A network blip is retried; a contract refusal is not.
 *
 * The distinction is the whole value. `ReadError` means the chain answered and said no — a failed
 * simulation, a transaction that is not SUCCESS — and retrying that turns one permanent error into
 * three. Anything else reaching this point is transport, and transport fails: a scenario run makes
 * several hundred calls against a shared public endpoint, and on 2026-08-20 a bare `fetch failed`
 * mid-run discarded a live round eleven minutes in.
 *
 * Two attempts, not ten. This is the thin layer for a single blip; a sustained outage is
 * `waitUntilLedgerTime`'s consecutive-failure budget, which is a different question with a
 * different answer.
 */
const transport = <T>(op: () => Promise<T>): Promise<T> =>
  withBackoff(op, {
    attempts: 3,
    initialDelayMs: 250,
    isRetryable: (err) => !(err instanceof ReadError),
  });

export async function makeReader(net: NetworkArgs, sourceAddress: string): Promise<Reader> {
  const { rpc, scValToNative, nativeToScVal, Contract, TransactionBuilder, Account } =
    await import("@stellar/stellar-sdk");
  const server = new rpc.Server(net.rpcUrl, { allowHttp: net.rpcUrl.startsWith("http://") });

  const toScVal = (v: unknown): ReturnType<typeof nativeToScVal> => {
    if (isTyped(v)) return nativeToScVal(v.value, { type: v.scvType });
    if (typeof v === "string" && /^[GC][A-Z2-7]{55}$/.test(v)) return nativeToScVal(v, { type: "address" });
    if (typeof v === "bigint") return nativeToScVal(v, { type: "i128" });
    return nativeToScVal(v);
  };

  return {
    async read<T>(contractId: string, method: string, args: readonly unknown[] = []): Promise<T> {
      // A simulation is built against a source account that only has to exist; nothing is signed.
      const tx = new TransactionBuilder(new Account(sourceAddress, "0"), {
        fee: "100",
        networkPassphrase: net.networkPassphrase,
      })
        .addOperation(new Contract(contractId).call(method, ...args.map(toScVal)))
        .setTimeout(30)
        .build();
      const sim = await transport(() => server.simulateTransaction(tx));
      if (rpc.Api.isSimulationError(sim)) {
        throw new ReadError(`${contractId}.${method}() failed to simulate: ${sim.error}`);
      }
      const retval = sim.result?.retval;
      if (retval === undefined) {
        throw new ReadError(`${contractId}.${method}() simulated without a return value.`);
      }
      return scValToNative(retval) as T;
    },

    async rawEvents(contractId: string, startLedger: number) {
      const out: { topics: unknown[]; data: unknown; txHash: string; ledger: number }[] = [];
      let cursor: string | undefined;
      // Bounded rather than open: a scenario run spans minutes, so more than a handful of pages
      // means the filter is wrong, and spinning against a shared endpoint is its own failure.
      for (let page = 0; page < 20; page += 1) {
        const res: Awaited<ReturnType<typeof server.getEvents>> = await transport(() =>
          server.getEvents(
            cursor === undefined
              ? { startLedger, filters: [{ type: "contract", contractIds: [contractId] }], limit: 200 }
              : { cursor, filters: [{ type: "contract", contractIds: [contractId] }], limit: 200 },
          ),
        );
        for (const e of res.events) {
          out.push({
            topics: e.topic.map((t) => scValToNative(t) as unknown),
            data: scValToNative(e.value) as unknown,
            txHash: e.txHash,
            ledger: e.ledger,
          });
        }
        if (res.events.length === 0 || res.cursor === undefined) break;
        cursor = res.cursor;
      }
      return out;
    },

    async ledgerOf(txHash: string): Promise<number> {
      const tx = await transport(() => server.getTransaction(txHash));
      // Against the SDK's own enum rather than the string "SUCCESS": the string comparison also
      // discards the discriminated-union narrowing that makes `tx.ledger` readable on the line below.
      if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new ReadError(`transaction ${txHash} is ${tx.status}, so it has no ledger to read from.`);
      }
      return tx.ledger;
    },

    getLatestLedger: () => transport(() => server.getLatestLedger()),
  };
}

/** The address behind a CLI identity name. The name is all this process ever holds. */
export function addressOf(identity: string): string {
  const out = runStellar(["keys", "address", identity]).stdout.trim();
  if (!/^G[A-Z2-7]{55}$/.test(out)) {
    throw new ReadError(
      `\`stellar keys address ${identity}\` did not return an account address (got ${JSON.stringify(
        out.slice(0, 80),
      )}). Create it with \`stellar keys generate --fund ${identity}\`.`,
    );
  }
  return out;
}

export interface InvokeSpec {
  readonly contractId: string;
  readonly method: string;
  readonly identity: string;
  readonly net: NetworkArgs;
  readonly args?: Readonly<Record<string, unknown>>;
}

const argvFor = (s: InvokeSpec): string[] =>
  buildInvokeArgv({
    contractId: s.contractId,
    method: s.method,
    identity: s.identity,
    net: s.net,
    args: s.args ?? {},
  });

export function invoke(spec: InvokeSpec): { stdout: string; stderr: string } {
  return runStellar(argvFor(spec));
}

/** The same call, in flight — the auction window is the reason this pair exists. See `chain.ts`. */
export function invokeAsync(spec: InvokeSpec): Promise<{ stdout: string; stderr: string }> {
  return runStellarAsync(argvFor(spec));
}
