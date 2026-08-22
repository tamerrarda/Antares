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
export function vaultClient(env: Record<string, string | undefined> = {}): Client {
  const net = network(env);
  return new Client({
    contractId: deployment().vaultId,
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

export function writeClient(address: string, env: Record<string, string | undefined> = {}): Client {
  const net = network(env);
  return new Client({
    contractId: deployment().vaultId,
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
