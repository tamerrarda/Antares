/**
 * The chain half of the bidder — the reads a decision needs, and the one write.
 *
 * Same shape as `keeper/vault.ts` and for the same reasons: one `bid` method that simulates,
 * assembles, signs and sends with no way to skip a step, because the auction moves while a decision
 * is being made and **the simulation is the check that the decision still applies**. It is also
 * where `AllowlistForbidden`, `BelowMinFill`, `InTheMoney` and the oracle transients arrive —
 * before a signature and before a fee.
 *
 * # The allowlist has no view, so this reads the ledger
 *
 * There is no `is_allowed(address)` entry point, and `config()` reports only whether the gate is
 * enabled and when it expires. The membership itself is `DataKey::Allowed(Address)` in persistent
 * storage, read here the way `integration/scenario6.ts` reads `DataKey::Shares` — an
 * `ScVal::Vec([Symbol, Address])` handed to `getLedgerEntries`. That is a feature rather than a
 * workaround: a bidder can check its own standing with nothing but the contract id, without the
 * contract's cooperation and without writing anything.
 *
 * Revocation **removes** the entry rather than storing `false` (admin.rs), so presence is the whole
 * answer: an entry means allowed, no entry means not.
 *
 * # The three conditions are mirrored exactly, and that matters more than it looks
 *
 * `auction.rs` refuses only when the gate is enabled **and** unexpired **and** the bidder is
 * absent. A mirror that drops the expiry clause would make this bidder refuse to bid on a vault
 * whose allowlist has lapsed into permanent inertness — declining business the contract would have
 * taken. The rule is copied here in the same three parts for that reason.
 */

import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { AuctionView } from "./strategy.ts";

/**
 * A decoded contract amount as a `bigint`, refusing anything it cannot represent.
 *
 * Not `BigInt(String(value))`. `scValToNative` hands back a `bigint` for an `i128` and a `number`
 * for a `u32`, but the field is typed `unknown` here, and `String()` on an object that is neither
 * yields `"[object Object]"` — which `BigInt` then rejects with a `SyntaxError` naming nothing
 * useful, or worse, which a `?? 0` fallback quietly turns into a zero notional. A wrong zero in
 * this file is a risk cap that never binds.
 */
function amount(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new BidderError(`${field} decoded as ${typeof value}, which is not an integer amount`);
}

/**
 * A transaction result union, named rather than stringified.
 *
 * **Measured on testnet 2026-08-23.** `JSON.stringify` on one of these produces an object with none
 * of the fields a reader wants — the union's discriminant is a method, not a property — so a
 * submission rejected before execution reached the operator as a message with no cause in it, and
 * `classify` then had nothing to find and called it `unexpected`. A refusal that stops the loop has
 * to say what refused.
 */
function resultName(result: unknown): string {
  try {
    const sw = (result as { switch?: () => { name?: string } } | undefined)?.switch?.();
    return sw?.name ?? "unnamed result";
  } catch {
    return "unreadable result";
  }
}

/**
 * The contract error code out of a **failed transaction's** diagnostic events, or `null`.
 *
 * **Measured on testnet 2026-08-23, twice.** A bid that simulates cleanly and then lands after
 * `auction_end` fails at execution with `WrongPhase` — the single most ordinary outcome in a
 * twenty-second auction, and one the design explicitly accepts, since the header above says the
 * simulation is a check that the decision *still* applies rather than a promise that it will.
 *
 * But the code only travels in the *simulation* error string. The transaction result carries
 * `txFailed` and nothing else, so `classify` found no code, returned `unexpected`, and the loop
 * stopped — on a race it is supposed to shrug at. Pulling the code out of the diagnostic events puts
 * an execution-time rejection back on the same footing as a simulation-time one.
 *
 * Written defensively throughout: this walks four levels of XDR union that the SDK types as
 * optional, and a bidder must not turn a failed bid into a crash while trying to explain it.
 */
export function diagnosticContractCode(response: unknown): number | null {
  const events = (response as { diagnosticEventsXdr?: unknown[] }).diagnosticEventsXdr;
  if (!Array.isArray(events)) return null;
  for (const raw of events) {
    // **Per event, not around the loop.** A failed invocation carries around twenty of these and
    // not all share a body variant, so `v0()` throws on some — and one coarse `try` around the
    // whole walk let the first of those abort the scan and report "no contract code" on a
    // transaction that plainly had one. Measured on testnet 2026-08-23 against a `WrongPhase`
    // that took two attempts to read.
    try {
      const body = (raw as { event: () => { body: () => { v0?: () => { topics: () => unknown[] } } } })
        .event()
        .body();
      const topics = body.v0?.().topics() ?? [];
      for (const topic of topics) {
        const t = topic as { switch: () => { name: string }; error: () => unknown };
        if (t.switch().name !== "scvError") continue;
        const err = t.error() as { switch: () => { name: string }; contractCode: () => unknown };
        if (err.switch().name !== "sceContract") continue;
        const code = Number(err.contractCode());
        if (Number.isInteger(code)) return code;
      }
    } catch {
      // This event was not one carrying an error. The next one may be.
    }
  }
  return null;
}

export class BidderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BidderError";
  }
}

export interface VaultClientOptions {
  readonly server: rpc.Server;
  readonly passphrase: string;
  readonly vaultId: string;
  readonly signer: Keypair;
  /** Fee in stroops. Simulation sets the resource fee; this is the inclusion fee. */
  readonly feeStroops?: string;
  readonly sendTimeoutMs?: number;
  /** How many finished rounds back to look when totalling open notional. */
  readonly lookbackRounds?: number;
}

const DEFAULT_FEE = "1000000";
const DEFAULT_SEND_TIMEOUT_MS = 60_000;
const DEFAULT_LOOKBACK_ROUNDS = 16;

/** What the vault's gate says, before this bidder's own membership is consulted. */
export interface AllowlistState {
  readonly enabled: boolean;
  readonly expiresAt: number;
}

export interface BidderVaultClient {
  readonly id: string;
  readonly address: string;
  auction(): Promise<AuctionView>;
  allowlist(): Promise<AllowlistState>;
  isListed(): Promise<boolean>;
  /**
   * Notional this bidder holds in rounds it has not claimed, over a bounded lookback.
   *
   * **Unclaimed rather than unfinalized, deliberately.** A settled round's option has expired and
   * carries no further market risk, so a pure risk reading would drop it. What it still carries is
   * capital the operator has not seen come back, and a reference bidder that keeps buying while its
   * claims pile up is the exact thing a total cap is for. The lookback is bounded, so a position
   * older than `lookbackRounds` is invisible here and the cap under-counts rather than over-counts
   * — the direction that fails toward bidding, which is why the number is printed in the log.
   */
  openNotional(currentRound: number): Promise<bigint>;
  /** Simulate, assemble, sign, send, wait. Returns the transaction hash. */
  bid(notional: bigint, maxPremiumBps: number): Promise<string>;
}

export function makeVaultClient(options: VaultClientOptions): BidderVaultClient {
  const { server, passphrase, vaultId, signer } = options;
  const fee = options.feeStroops ?? DEFAULT_FEE;
  const timeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const lookback = options.lookbackRounds ?? DEFAULT_LOOKBACK_ROUNDS;
  const me = signer.publicKey();

  /** Freshly, every time. An account whose sequence is cached sends one transaction and then stops. */
  const account = () => server.getAccount(me);

  async function simulateCall(fn: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(await account(), { fee, networkPassphrase: passphrase })
      .addOperation(new Contract(vaultId).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new BidderError(`${fn}: ${sim.error}`);
    return sim.result === undefined ? null : scValToNative(sim.result.retval);
  }

  return {
    id: vaultId,
    address: me,

    async auction(): Promise<AuctionView> {
      const raw = (await simulateCall("epoch", [])) as Record<string, unknown>;
      const params = (raw["params"] ?? {}) as Record<string, unknown>;
      const phase = raw["phase"];
      return {
        round: Number(raw["round"]),
        phase: String(
          typeof phase === "object" && phase !== null ? ((phase as { tag?: string }).tag ?? phase) : phase,
        ) as AuctionView["phase"],
        currentPremiumBps: Number(raw["current_premium_bps"]),
        notionalOffered: amount(raw["notional_offered"], "notional_offered"),
        notionalSold: amount(raw["notional_sold"], "notional_sold"),
        minFill: amount(params["min_fill"], "params.min_fill"),
      };
    },

    async allowlist(): Promise<AllowlistState> {
      const raw = (await simulateCall("config", [])) as Record<string, unknown>;
      return {
        enabled: Boolean(raw["allowlist_enabled"]),
        expiresAt: Number(raw["allowlist_expires_at"]),
      };
    },

    async isListed(): Promise<boolean> {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(vaultId).toScAddress(),
          key: xdr.ScVal.scvVec([nativeToScVal("Allowed", { type: "symbol" }), new Address(me).toScVal()]),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const res = await server.getLedgerEntries(key);
      return res.entries.length > 0;
    },

    async openNotional(currentRound: number): Promise<bigint> {
      let total = 0n;
      const oldest = Math.max(1, currentRound - lookback);
      for (let r = oldest; r <= currentRound; r += 1) {
        const raw = (await simulateCall("bidder_position", [
          nativeToScVal(r, { type: "u32" }),
          new Address(me).toScVal(),
        ])) as Record<string, unknown> | null;
        if (raw === null) continue;
        if (raw["claimed"] === true) continue;
        // A round this bidder never filled decodes as a zeroed position, not as an absent one.
        total += amount(raw["notional"] ?? 0n, `round ${r} notional`);
      }
      return total;
    },

    async bid(notional: bigint, maxPremiumBps: number): Promise<string> {
      const built = new TransactionBuilder(await account(), { fee, networkPassphrase: passphrase })
        .addOperation(
          new Contract(vaultId).call(
            "bid",
            new Address(me).toScVal(),
            nativeToScVal(notional, { type: "i128" }),
            nativeToScVal(maxPremiumBps, { type: "u32" }),
          ),
        )
        .setTimeout(30)
        .build();

      // Step 1 — simulate. Every contract refusal arrives here, before a signature and before a
      // fee: the allowlist, the minimum fill, the in-the-money guard, the oracle transients.
      const sim = await server.simulateTransaction(built);
      if (rpc.Api.isSimulationError(sim)) throw new BidderError(sim.error);

      // Step 2 — assemble with the resources the simulation measured, then sign, then send.
      const prepared = rpc.assembleTransaction(built, sim).build();
      prepared.sign(signer);
      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new BidderError(
          `send rejected before execution: ${resultName(sent.errorResult?.result())} ` +
            `(status ${sent.status}). Nothing executed, and no premium was charged.`,
        );
      }

      // Step 3 — wait for it to land. A hash accepted into the queue is not yet a fill, and
      // treating it as one would put a notional into the portfolio total that never existed.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const got = await server.getTransaction(sent.hash);
        if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
        if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new BidderError(
            (() => {
              const code = diagnosticContractCode(got);
              const where = `transaction ${sent.hash} failed at execution: ${resultName(got.resultXdr?.result())}`;
              // Spelled the way a simulation failure spells it, so one classifier reads both.
              return code === null
                ? `${where}, and its diagnostic events carry no contract code`
                : `${where}: Error(Contract, #${code})`;
            })(),
          );
        }
        if (Date.now() > deadline) {
          throw new BidderError(
            `transaction ${sent.hash} did not land within ${timeoutMs}ms. It may still land; the ` +
              `next pass re-reads the auction rather than assuming either way.`,
          );
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
    },
  };
}
