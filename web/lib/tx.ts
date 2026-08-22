/**
 * Sign and send, and say what happened.
 *
 * The important property here is one the contract gives us for free and most interfaces throw
 * away: **simulation runs before anything is signed.** An `AssembledTransaction` has already asked
 * the chain what would happen, so a refusal — a cap exceeded, a phase that moved, a bid above the
 * curve — comes back as a value while the user's wallet is still closed. They are never asked to
 * approve a transaction that was already going to fail, and they never pay a fee to find out.
 *
 * That is why `submit` has three outcomes rather than two. "Refused before signing" and "failed
 * after submission" feel identical in a `try/catch` and are completely different events to the
 * person holding the wallet.
 */
import type { AssembledTransaction, Result } from "@stellar/stellar-sdk/contract";

import { explainMessage, type CallSite, type ErrorText } from "./errors.ts";

export type TxOutcome<T> =
  | { readonly status: "sent"; readonly value: T; readonly hash: string }
  | { readonly status: "refused"; readonly refusal: ErrorText; readonly signed: boolean };

function isResult<T>(value: unknown): value is Result<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "isErr" in value &&
    typeof (value as Result<T>).isErr === "function"
  );
}

/**
 * @param build   the bindings call, already simulated.
 * @param signer  the connected wallet — `{ address, signTransaction }`, which is the shape Freighter
 *                already has and the shape the SDK already accepts.
 */
export async function submit<T>(
  build: Promise<AssembledTransaction<Result<T>>>,
  signer: {
    address: string;
    signTransaction: (
      xdr: string,
      opts?: unknown,
    ) => Promise<{ signedTxXdr: string; signerAddress?: string }>;
  },
  /**
   * Which entry point this is, so a code that means different things at different call sites can be
   * explained as the one it means here. `WrongPhase` from a withdrawal and `WrongPhase` from a close
   * are the same number and not the same event.
   */
  site?: CallSite,
): Promise<TxOutcome<T>> {
  let tx: AssembledTransaction<Result<T>>;
  try {
    tx = await build;
  } catch (cause) {
    // Simulation itself threw — the contract trapped rather than returning an error, or the node
    // could not be reached. Either way nothing was signed.
    return { status: "refused", refusal: explainMessage(message(cause), site), signed: false };
  }

  // The cheap refusal: the simulation already knows this will not work.
  //
  // The simulation is checked BEFORE `tx.result`, and both halves of that matter. It is the only
  // place the numeric error code appears — measured 2026-08-22, the parsed `Result` carries
  // `{ message: "" }` for most codes and a Rust doc comment for others, so matching on it names
  // almost nothing. And reading `tx.result` when the simulation failed **throws**, which would turn
  // a refusal this function is supposed to explain into an exception it merely catches.
  const failure = simulationError(tx);
  if (failure !== null) {
    return { status: "refused", refusal: explainMessage(failure, site), signed: false };
  }

  const simulated = tx.result;
  if (isResult<T>(simulated) && simulated.isErr()) {
    return { status: "refused", refusal: explainMessage(simulated.unwrapErr().message, site), signed: false };
  }

  try {
    const sent = await tx.signAndSend({ signTransaction: signer.signTransaction as never });
    const result = sent.result;
    const value = isResult<T>(result) ? result.unwrap() : (result as T);
    return { status: "sent", value, hash: sent.sendTransactionResponse?.hash ?? "" };
  } catch (cause) {
    // Past this point the wallet was opened. Whether it was declined or the network rejected the
    // envelope, the user knows they were asked — so `signed` records that, and the copy can say
    // "nothing was taken" without also implying nothing happened.
    return { status: "refused", refusal: explainMessage(message(cause), site), signed: true };
  }
}

/** `HostError: Error(Contract, #20)` — the one place the code itself is legible. */
function simulationError(tx: unknown): string | null {
  const sim = (tx as { simulation?: { error?: unknown } }).simulation;
  const err = sim?.error;
  return typeof err === "string" && err.length > 0 ? err : null;
}

function message(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return JSON.stringify(cause);
}
