/**
 * The chain half of `VaultClient` — reads, and the one write path.
 *
 * `reflector.ts` already does the feed side; this is the vault side, and the two are separate
 * because they are pinned to different contracts and fail for different reasons.
 *
 * # Simulate, assemble, sign, send — in that order, with no way to skip a step
 *
 * `submit` is a single method on purpose (see `runner.ts`). Exposing a `simulate()` beside a
 * `send()` would let a caller send without simulating, and the simulation is not an optimisation
 * here: every entry point the keeper calls is permissionless (D-09), so the state it decided from
 * may already have moved. **The simulation is the check that the decision still applies**, and its
 * failure is where `WrongPhase` and the oracle transients arrive — before anything is signed and
 * before a fee is spent.
 *
 * # It holds one key and that key has no authority
 *
 * `open_epoch` and `close_round` take no `require_auth` from the caller beyond paying the fee, and
 * `bounty_to` is the keeper's own address only because someone has to receive the bounty. There is
 * no admin key here, no `set_epoch_params`, and nothing a depositor has to trust. Losing this key
 * costs the bounties and nothing else.
 */

import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { Action, EpochView, VaultConfig } from "./decide.ts";
import type { VaultClient } from "./runner.ts";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultClientOptions {
  readonly server: rpc.Server;
  readonly passphrase: string;
  readonly vaultId: string;
  readonly signer: Keypair;
  /** The Reflector instance this vault's adapter is pinned to, for the sponsorship watch. */
  readonly feedId: string;
  readonly assetSymbol: string;
  /** Fee in stroops. The base fee times a headroom factor; simulation sets the resource fee. */
  readonly feeStroops?: string;
  /** How long to poll for a send to land, in milliseconds. */
  readonly sendTimeoutMs?: number;
}

const DEFAULT_FEE = "1000000";
const DEFAULT_SEND_TIMEOUT_MS = 60_000;

/** Read-only simulation against any contract. Signs nothing. */
async function simulateCall(
  server: rpc.Server,
  source: Awaited<ReturnType<rpc.Server["getAccount"]>>,
  passphrase: string,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const tx = new TransactionBuilder(source, { fee: DEFAULT_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new VaultError(sim.error);
  return sim.result === undefined ? null : scValToNative(sim.result.retval);
}

export function makeVaultClient(options: VaultClientOptions): VaultClient {
  const { server, passphrase, vaultId, signer, feedId, assetSymbol } = options;
  const fee = options.feeStroops ?? DEFAULT_FEE;
  const timeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

  const asset = xdr.ScVal.scvVec([
    nativeToScVal("Other", { type: "symbol" }),
    nativeToScVal(assetSymbol, { type: "symbol" }),
  ]);

  /** Freshly, every time. An account whose sequence is cached sends one transaction and then stops. */
  const account = () => server.getAccount(signer.publicKey());

  return {
    id: vaultId,

    async epoch(): Promise<EpochView> {
      const raw = (await simulateCall(server, await account(), passphrase, vaultId, "epoch", [])) as Record<
        string,
        unknown
      >;
      const params = (raw["params"] ?? {}) as Record<string, unknown>;
      return {
        round: Number(raw["round"]),
        // The view has already resolved the lazy lapse; `decide` must not re-derive it.
        phase: String(
          (raw["phase"] as { tag?: string } | string) instanceof Object
            ? ((raw["phase"] as { tag?: string }).tag ?? raw["phase"])
            : raw["phase"],
        ) as EpochView["phase"],
        outcomePending: Boolean(raw["outcome_pending"]),
        expiry: Number(raw["expiry"]),
        nextOpenAt: Number(raw["next_open_at"]),
        epochDuration: Number(params["epoch_duration"]),
        unresolvedAfter: Number(params["unresolved_after"]),
      };
    },

    async config(): Promise<VaultConfig> {
      const raw = (await simulateCall(server, await account(), passphrase, vaultId, "config", [])) as Record<
        string,
        unknown
      >;
      return { paused: Boolean(raw["paused"]) };
    },

    async feedExpiresAt(): Promise<number | null> {
      const v = await simulateCall(server, await account(), passphrase, feedId, "expires", [asset]);
      return v === null || v === undefined ? null : Number(v);
    },

    async submit(action: Exclude<Action, { kind: "wait" }>): Promise<string> {
      const source = await account();
      const args =
        action.kind === "close_round" ? [nativeToScVal(signer.publicKey(), { type: "address" })] : [];
      const built = new TransactionBuilder(source, { fee, networkPassphrase: passphrase })
        .addOperation(new Contract(vaultId).call(action.kind, ...args))
        .setTimeout(30)
        .build();

      // Step 1 — simulate. This is where a contract rejection arrives, and it arrives *before* a
      // signature or a fee. `runner.ts` classifies it; nothing here interprets it.
      const sim = await server.simulateTransaction(built);
      if (rpc.Api.isSimulationError(sim)) throw new VaultError(sim.error);

      // Step 2 — assemble with the resources the simulation measured, then sign, then send.
      const prepared = rpc.assembleTransaction(built, sim).build();
      prepared.sign(signer);
      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new VaultError(`send rejected: ${JSON.stringify(sent.errorResult?.result() ?? sent.status)}`);
      }

      // Step 3 — wait for it to land. A hash that was accepted into the queue is not yet a fact,
      // and reporting it as one would put a tx into the evidence file that never executed.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const got = await server.getTransaction(sent.hash);
        if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
        if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new VaultError(`transaction ${sent.hash} failed: ${JSON.stringify(got.resultXdr?.result())}`);
        }
        if (Date.now() > deadline) {
          throw new VaultError(
            `transaction ${sent.hash} did not land within ${timeoutMs}ms. It may still land; the ` +
              `next pass re-reads the state rather than assuming either way.`,
          );
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
    },
  };
}
