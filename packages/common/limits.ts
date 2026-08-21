/**
 * The resource limits the network publishes, read live.
 *
 * **Moved here from `profile-adapter.ts` on 2026-08-21, when a second caller appeared.** A limit
 * is a network fact that changes by validator vote, so pinning one in a constant produces a check
 * that passes for as long as the number happens to still be true and then quietly stops meaning
 * anything (D-49, D-58). Reading it costs one `getLedgerEntries` call.
 *
 * It lives here despite this package having had no dependencies until now, and the trade is worth
 * naming: `chain.ts` shells out to the CLI precisely so the SDK stays out, and this function cannot
 * be written without `xdr` and `rpc`. But the alternative was worse. Three consumers need the same
 * ceiling — the adapter profile, the vault profile and the integration harness — and they sit in
 * three packages, so `scripts/lib/` is reachable by one of them and a relative import across the
 * boundary is refused by `rootDir`. The subpath export keeps the cost where it belongs: importing
 * `@antares/common/checks` still pulls in nothing.
 */
import type { rpc } from "@stellar/stellar-sdk";
import { xdr } from "@stellar/stellar-sdk";

export interface NetworkLimits {
  /** Instructions one transaction may execute. */
  readonly txMaxInstructions: number;
  /** Bytes one transaction may read from disk. */
  readonly txMaxDiskReadBytes: number;
}

/**
 * Both settings in one round trip, and a zero means the network did not answer for that key
 * rather than that the limit is zero — callers assert on it rather than dividing by it.
 */
export async function networkLimits(server: rpc.Server): Promise<NetworkLimits> {
  const key = (id: xdr.ConfigSettingId): xdr.LedgerKey =>
    xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: id }));
  const r = await server.getLedgerEntries(
    key(xdr.ConfigSettingId.configSettingContractComputeV0()),
    key(xdr.ConfigSettingId.configSettingContractLedgerCostV0()),
  );
  let txMaxInstructions = 0;
  let txMaxDiskReadBytes = 0;
  for (const e of r.entries) {
    const cs = e.val.configSetting();
    if (cs.switch().name === "configSettingContractComputeV0") {
      txMaxInstructions = Number(cs.contractCompute().txMaxInstructions().toString());
    } else if (cs.switch().name === "configSettingContractLedgerCostV0") {
      txMaxDiskReadBytes = Number(cs.contractLedgerCost().txMaxDiskReadBytes().toString());
    }
  }
  return { txMaxInstructions, txMaxDiskReadBytes };
}
