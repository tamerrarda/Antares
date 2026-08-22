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

/**
 * An amount from the record, refused rather than coerced.
 *
 * `String(unknown)` turns an object into "[object Object]" and `BigInt` of that throws at a point
 * far from the cause. A deposit cap is a number in the JSON; anything else is a record this build
 * should not pretend to understand.
 */
function requireAmount(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new DeploymentError(
    `deployments/testnet.json has a ${field} that is not an integer amount (got ${typeof value}).`,
  );
}

/**
 * One deployed vault, as the record describes it.
 *
 * The parameters come from the record rather than the chain because a page needs to *name* a vault
 * before it reads it — "7-day · 3%" is what a person picks between, and asking five contracts for
 * their `epoch()` before rendering a menu is five round-trips to draw a label.
 */
export interface Instance {
  readonly vaultId: string;
  /** `-A`…`-E`, or `-F` for a fast-test profile. Distinguishes the five share tokens (D-52). */
  readonly tokenSuffix: string;
  readonly epochDuration: number;
  readonly strikeBpsOtm: number;
  readonly minIdleGap: number;
  readonly depositCap: bigint;
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
/**
 * Every vault this build knows about — today one, by design N.
 *
 * D-47 runs Phase 2 as five concurrent instances differing only in `EpochParams`, and the pages
 * that compare them iterate this list rather than a hardcoded five. When `deploy.ts` writes five
 * rows, the comparison shows five with no code change; while it writes one, the pages say so
 * instead of drawing four vaults that do not exist. Presenting a plan as a product is the specific
 * failure this avoids.
 */
export function instances(): readonly Instance[] {
  const rows = record.instances as ReadonlyArray<Record<string, unknown>>;
  return rows.map((row, i) => {
    const params = row["params"] as Record<string, unknown> | undefined;
    if (params === undefined) {
      throw new DeploymentError(`deployments/testnet.json instances[${i}] has no params.`);
    }
    return {
      vaultId: requireString(row["vaultId"], `instances[${i}].vaultId`),
      tokenSuffix: requireString(row["tokenSuffix"], `instances[${i}].tokenSuffix`),
      epochDuration: Number(params["epoch_duration"]),
      strikeBpsOtm: Number(params["strike_bps_otm"]),
      minIdleGap: Number(params["min_idle_gap"]),
      depositCap: requireAmount(row["depositCap"], `instances[${i}].depositCap`),
      economicallyMeaningless: row["economicallyMeaningless"] === true,
    };
  });
}

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
