/**
 * The one address this app is allowed to know, and where it is allowed to learn it.
 *
 * `deployments/testnet.json` is the only place a contract id may live outside
 * `packages/common/networks.ts` — its own `_what` field says so, and
 * `scripts/ci/network-agnostic-ts.sh` enforces it by exempting exactly those two paths and
 * failing on a `C…`/`G…` literal anywhere else under `web/`. So this module imports the record
 * rather than restating it, and everything downstream reads the address from here.
 *
 * **Imported rather than fetched, because the page is static.** 08-OFFCHAIN §3 specifies
 * `static-first` with `no backend of record`, so there is no request-time server to ask which
 * vault is current; the address is baked at build time and a redeploy means a rebuild. That is a
 * real constraint rather than an implementation detail, and it is why the Claims page's chain
 * read is primary and the evidence index only a fallback (§3 again) — a page cannot learn about
 * a round newer than its own build.
 */
import record from "../../deployments/testnet.json" with { type: "json" };

export interface Deployment {
  /** The vault the UI reads and writes. */
  readonly vaultId: string;
  /** The price source that vault was constructed against — read-only here, shown for provenance. */
  readonly oracleId: string;
  /** The asset the vault holds, as a SAC address. */
  readonly assetId: string;
  /** Which network the record was written against. */
  readonly network: string;
  /**
   * `true` for a `--fast-test` instance, and **permanent** (D-57).
   *
   * The banner reads this. A profile stamped this way can never be presented as demand evidence,
   * and a UI that renders a fast-test round without saying so is doing exactly that presentation.
   */
  readonly economicallyMeaningless: boolean;
}

class DeploymentError extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DeploymentError(
      `deployments/testnet.json is missing ${field}. The record is written by scripts/deploy.ts ` +
        `step 6; a build cannot invent an address it was not given.`,
    );
  }
  return value;
}

/**
 * Read the deployment, refusing rather than defaulting.
 *
 * A missing field here is a build that would otherwise ship pointing at nothing, and the failure
 * would surface as an empty page rather than as the misconfiguration it is.
 */
export function deployment(): Deployment {
  const instances = record.instances as ReadonlyArray<Record<string, unknown>>;
  const instance = instances[0];
  if (instance === undefined) {
    throw new DeploymentError("deployments/testnet.json records no instance.");
  }
  return {
    vaultId: requireString(instance["vaultId"], "instances[0].vaultId"),
    oracleId: requireString(record.oracleId, "oracleId"),
    assetId: requireString(record.assetId, "assetId"),
    network: requireString(record.network, "network"),
    economicallyMeaningless: instance["economicallyMeaningless"] === true,
  };
}
