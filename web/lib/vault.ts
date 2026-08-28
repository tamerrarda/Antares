/**
 * The read layer: the three views every page starts from, over the generated bindings.
 *
 * **This is the bindings' first real consumer, and that is deliberate.** `integration/read.ts`
 * cannot use them — DEV3's own note says why: half its calls go to `mock-price-source`, which has
 * no generated client, so it shells out to the CLI instead. The browser has no shell, and the web
 * only ever calls the vault. So the package that exists to keep the client and the contract from
 * drifting finally has a caller that depends on it, and `bindings:check` is what keeps that
 * dependency honest.
 *
 * Reads are simulations. Nothing here signs, nothing here needs a wallet, and every function
 * below works for a visitor who has connected nothing — which is the point: `TRUST_MODEL §2`
 * makes the allowlist expiry *"readable before you deposit anything"*, and readable on-chain is
 * not the same as readable by the person deciding.
 */
import { Client, type ConfigView, type EpochInfo, type Position } from "@antares/bindings";
import {
  Account,
  Contract,
  TransactionBuilder,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { resolveNetwork, resolveRpcUrl, type NetworkConfig } from "@antares/common/networks";

import { deployment } from "./deployment.ts";

/**
 * Network values come from `networks.ts`, never from here.
 *
 * In a browser there is no `process.env`, so the caller supplies the record — Next.js exposes
 * `NEXT_PUBLIC_*` as build-time literals, which is the same shape `resolveNetwork` already takes.
 * Passing an empty record selects the default, which is what a static build normally wants.
 */
export function network(env: Record<string, string | undefined> = {}): NetworkConfig {
  return resolveNetwork(env);
}

/** A read-only client against the deployed vault. */
export function vaultClient(env: Record<string, string | undefined> = {}, suffix?: string): Client {
  const net = network(env);
  return new Client({
    contractId: deployment(suffix).vaultId,
    networkPassphrase: net.networkPassphrase,
    rpcUrl: resolveRpcUrl(net, env),
    // No `publicKey` and no signer: every call in this module simulates. A read that needed an
    // account would be a read that could fail for a visitor who has connected no wallet.
    allowHttp: false,
  });
}

/**
 * A client that can write, which is the same client plus an identity.
 *
 * Kept separate from `vaultClient` on purpose: every read on this page works for a visitor who has
 * connected nothing, and a single client carrying a `publicKey` would make that untrue by making
 * the address a construction-time requirement.
 */
/** A read client for a vault other than the default one — used by the pages that span instances. */
export function clientFor(contractId: string, env: Record<string, string | undefined> = {}): Client {
  const net = network(env);
  return new Client({
    contractId,
    networkPassphrase: net.networkPassphrase,
    rpcUrl: resolveRpcUrl(net, env),
    allowHttp: false,
  });
}

export function writeClient(
  address: string,
  env: Record<string, string | undefined> = {},
  suffix?: string,
): Client {
  const net = network(env);
  return new Client({
    contractId: deployment(suffix).vaultId,
    networkPassphrase: net.networkPassphrase,
    rpcUrl: resolveRpcUrl(net, env),
    publicKey: address,
    allowHttp: false,
  });
}

/**
 * `epoch()` — the phase, the round, the strike and expiry, and the live auction curve.
 *
 * §12's `epoch()` reports the **effective** phase, re-deriving a lazy lapse read-only, so the UI
 * never has to decide whether a round has really ended. That is the whole reason the Vault page
 * can render from one call.
 */
export async function readEpoch(client: Client): Promise<EpochInfo> {
  return (await client.epoch()).result;
}

/**
 * `config()` — the numbers the trust story is made of.
 *
 * `paused`, `deposit_cap`, `fee_bps`, `allowlist_enabled` and `allowlist_expires_at` are here
 * because 08-OFFCHAIN §3 requires them on the Vault page, and `fee_claimable` is here because
 * §12's shapes froze at Phase 5 with it added — the accrued fee is otherwise readable only from
 * events, which leave the RPC window in about seven days.
 */
export async function readConfig(client: Client): Promise<ConfigView> {
  return (await client.config()).result;
}

/** `position(user)` — one depositor's shares, pending deposit and queued withdrawal. */
export async function readPosition(client: Client, user: string): Promise<Position> {
  return (await client.position({ user })).result;
}

/**
 * What the vault's **own** oracle says the underlying is worth, at 1e7 fixed point — or `null`.
 *
 * Read from `Config.oracle` rather than from a market API, and that is the whole point: this is the
 * number that sets the strike when a round opens and decides the payout when it closes. A ticker
 * showing some other venue's price would be showing something with no authority over anybody's
 * money here. On a real deployment this **is** the market — Reflector's aggregated CEX & DEX feed.
 * On a fast-test instance it is the mock, and the page says so at the top in larger type than this.
 *
 * **`reading()`, not `spot_check()`, and the reason is a bug this caught before it shipped.**
 * `spot_check` needs the feed's decimal scale as an argument, and the obvious way to get it —
 * asking the oracle's `decimals()` — works against the mock and **fails against the real adapter**,
 * which exports exactly four functions and none of them is that one. `decimals()` is a test
 * affordance, not part of the `PriceSource` interface. `reading()` is, it returns the scale
 * alongside the price, and its `short_twap` is the same TWAP the strike is derived from at open —
 * a truer number for a ticker than a single tick anyway.
 *
 * `null` is a real answer and is rendered as one: the window can be unusable or out of reach, which
 * is exactly what settlement would meet, and putting a number on screen the contract would refuse
 * to act on is the one thing a display like this must not do.
 */
export async function readSpot(
  config: Pick<ConfigView, "oracle" | "params">,
  env: Record<string, string | undefined> = {},
): Promise<bigint | null> {
  const net = network(env);
  const server = new rpc.Server(resolveRpcUrl(net, env), { allowHttp: false });
  // No wallet, no account: the SDK's own null account is what its generated clients simulate with.
  const source = new Account(contract.NULL_ACCOUNT, "0");

  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(
      new Contract(config.oracle).call(
        "reading",
        // anchor 0 means "ending now" — the live branch, the same one `open_epoch` uses.
        nativeToScVal(0n, { type: "u64" }),
        nativeToScVal(config.params.twap_window, { type: "u64" }),
        nativeToScVal(config.params.guard_window, { type: "u64" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || sim.result === undefined) return null;
  const out = scValToNative(sim.result.retval) as unknown;

  // `scValToNative` decodes a Soroban enum as `[variantName, payload]` — measured, not assumed:
  // `["Reading", { feed_decimals, guard_twap, newest_ts, short_twap }]`. `Unusable` and
  // `OutOfReach` carry nothing and mean the same thing to a reader: there is no price to show.
  if (!Array.isArray(out) || out[0] !== "Reading") return null;
  const twap = (out[1] as { short_twap?: unknown } | undefined)?.short_twap;
  // Typed rather than `String(twap)`: an `i128` decodes as a `bigint`, and stringifying whatever
  // else turned up would quietly produce "[object Object]" and then a price of nothing.
  if (typeof twap === "bigint") return twap;
  if (typeof twap === "number" && Number.isInteger(twap)) return BigInt(twap);
  if (typeof twap === "string" && /^-?\d+$/.test(twap)) return BigInt(twap);
  return null;
}
