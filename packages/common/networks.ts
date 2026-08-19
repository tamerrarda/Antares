/**
 * The single home for every network, asset and contract address.
 *
 * `08-OFFCHAIN.md` §1 and `09-DEPLOYMENT.md` §1 are the specification; this file is what they
 * describe. The rule they state is *"all network/asset/contract addresses come from one
 * `packages/common/networks.ts`, parameterized by `NETWORK` env — never hardcoded"*, and
 * `06-TEST-PLAN.md` §8 enforces it with a grep that exempts exactly two paths: this file and
 * `deployments/*.json`.
 *
 * **The exemption is the point of the rule rather than a hole in it.** The values have to live
 * somewhere; the check exists to prove they live *only* here. So the bar for adding a literal to
 * this file is not "it is allowed here" — it is "this is a fact about the network, it is the same
 * for everyone using that network, and nothing else in the repository may repeat it."
 *
 * **What lives here and what lives in `deployments/<network>.json`, because the split is not
 * arbitrary.** This file carries the facts that are true *before* anything is deployed — the
 * endpoints and the passphrase, which are published by the network operator and identical for
 * every project on it. `deployments/` carries the facts a deploy *creates* — contract ids, wasm
 * hashes, the resolved XLM SAC id, the pinned Reflector id, the params used
 * (`09-DEPLOYMENT.md` §1: the SAC is *"resolved at deploy … then pinned in `deployments/`"*, and
 * the feed is *"pinned at deploy time … then committed"*). Putting a contract id here would mean
 * editing source to record a deployment, and `deployments.ts` exists so that nothing has to.
 */

/**
 * The networks this project addresses. Deliberately two.
 *
 * `09-DEPLOYMENT.md`'s opening sentence is that *"testnet is a network parameter, not a different
 * design"*, and its parameter table has exactly a testnet column plus a gated mainnet. Adding a
 * `futurenet` or a `local` row would be inventing scope: fast-test deployments are second-scale
 * **parameters** against `mock-price-source` on testnet (`02-CONTRACT-SPEC.md` §1), not a third
 * network.
 */
export const NETWORK_NAMES = ["testnet", "mainnet"] as const;

export type NetworkName = (typeof NETWORK_NAMES)[number];

export interface NetworkConfig {
  readonly name: NetworkName;
  /** Soroban RPC endpoint. */
  readonly rpcUrl: string;
  /** The network passphrase every signature commits to. */
  readonly networkPassphrase: string;
  /**
   * Explorer base for a transaction hash, `${explorerTxBase}/${hash}`.
   *
   * This is here rather than in `web/` because it is a per-network fact and the grep forbids it
   * anywhere else — and because three deliverables depend on it resolving: the Rounds page links
   * every row to its transaction (`08-OFFCHAIN.md` §3), `WALKTHROUGH.md` is *"narrated from
   * transaction hashes with explorer links"*, and D2's evidence is those links resolving for a
   * reviewer who was not there.
   */
  readonly explorerTxBase: string;
  /** Explorer base for a contract id, `${explorerContractBase}/${id}`. */
  readonly explorerContractBase: string;
}

/**
 * **Mainnet is gated and this constant is the gate.**
 *
 * `09-DEPLOYMENT.md`'s preamble: *"Mainnet deployment remains gated (audit + counterparty, README
 * roadmap) and scripts hard-refuse `NETWORK=mainnet` until that gate is lifted deliberately."*
 * `DEV3.md`'s Phase-6 list says the same from the other side — *"the script refuses mainnet
 * outright at this stage"*.
 *
 * The refusal lives in {@link resolveNetwork}, which is the one door every tool comes through,
 * rather than in `deploy.ts` alone. That is deliberately stronger than the letter of the two
 * sentences above, which name only the scripts, and the reason is that the weaker version has to
 * be remembered once per tool: `upgrade.ts`, the keeper, the bidder and the web app would each
 * need their own copy of a check whose whole value is that it cannot be forgotten. There is
 * nothing deployed on mainnet to read, so a read-only path through the gate would be a hole with
 * no user.
 *
 * Flipping this to `true` is the deliberate act. It is one line, in one file, reviewed like any
 * other change — which is the friction the plan is asking for, not an obstacle to route around.
 */
export const MAINNET_ENABLED = false;

const NETWORKS: { readonly [K in NetworkName]: NetworkConfig } = {
  testnet: {
    name: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerTxBase: "https://stellar.expert/explorer/testnet/tx",
    explorerContractBase: "https://stellar.expert/explorer/testnet/contract",
  },
  mainnet: {
    name: "mainnet",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    explorerTxBase: "https://stellar.expert/explorer/public/tx",
    explorerContractBase: "https://stellar.expert/explorer/public/contract",
  },
};

/** Raised for every refusal in this module, so a caller can tell configuration from I/O. */
export class NetworkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkConfigError";
  }
}

export function isNetworkName(value: string): value is NetworkName {
  return (NETWORK_NAMES as readonly string[]).includes(value);
}

/**
 * The one door. Reads `NETWORK` from the environment, validates it, and refuses mainnet.
 *
 * `env` is a parameter rather than a read of `process.env` so that this is testable without
 * mutating global state — and so the mainnet refusal can be driven to fire in a unit test, which
 * `DEV-PROTOCOL.md` §6 requires of every guard. A gate only ever verified in the passing direction
 * is a gate nobody has tested.
 */
export function resolveNetwork(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NetworkConfig {
  const raw = env["NETWORK"];
  if (raw === undefined || raw === "") {
    throw new NetworkConfigError(
      `NETWORK is not set. Set it to one of: ${NETWORK_NAMES.join(", ")}. ` +
        `Every network value in this repository is parameterized by it (08-OFFCHAIN §1); there is ` +
        `deliberately no default, because a default is how a tool ends up pointed at the wrong ` +
        `network without saying so.`,
    );
  }
  if (!isNetworkName(raw)) {
    throw new NetworkConfigError(
      `NETWORK="${raw}" is not a known network. Known: ${NETWORK_NAMES.join(", ")}.`,
    );
  }
  if (raw === "mainnet" && !MAINNET_ENABLED) {
    throw new NetworkConfigError(
      `NETWORK=mainnet is refused. Mainnet is gated on the audit and a counterparty ` +
        `(09-DEPLOYMENT §1, README roadmap), and lifting the gate is a deliberate one-line change ` +
        `to MAINNET_ENABLED in packages/common/networks.ts — reviewed like any other change, not ` +
        `an environment variable somebody can set by accident.`,
    );
  }
  return NETWORKS[raw];
}

/**
 * The network config for a name that is already known — for tests and for tools that carry the
 * name explicitly. Still refuses mainnet: the gate is about the network, not about how it was named.
 */
export function networkConfig(name: NetworkName): NetworkConfig {
  return resolveNetwork({ NETWORK: name });
}

/**
 * An RPC URL may be overridden per environment; the passphrase may not.
 *
 * The asymmetry is the security-relevant half. Pointing at a different RPC provider for the same
 * network is ordinary operations — rate limits, an outage, a local quickstart container. A
 * passphrase override would mean signing for a *different network* while every other value in the
 * process still described this one, which is the class of mistake that produces a valid signature
 * nobody intended. So `RPC_URL` is honoured and there is no `NETWORK_PASSPHRASE` override.
 */
export function resolveRpcUrl(
  net: NetworkConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env["RPC_URL"];
  return override !== undefined && override !== "" ? override : net.rpcUrl;
}

export function explorerTxUrl(net: NetworkConfig, txHash: string): string {
  return `${net.explorerTxBase}/${txHash}`;
}

export function explorerContractUrl(net: NetworkConfig, contractId: string): string {
  return `${net.explorerContractBase}/${contractId}`;
}
