#!/usr/bin/env node
/**
 * The keeper's entry point.
 *
 * Config is **env only** (08-OFFCHAIN §1), contract ids are **plural** — one process loops over
 * every deployed instance (D-47) — and per-instance state is derived from `epoch()` each pass and
 * never cached across restarts.
 *
 * ```
 * RPC_URL=…  NETWORK_PASSPHRASE=…  VAULT_IDS=C…,C…  FEED_ID=C…  KEEPER_SECRET=S…  pnpm --filter @antares/keeper start
 * ```
 *
 * # What happens when this process is not running
 *
 * Rounds open and close later than they otherwise would, and nothing else. Every entry point it
 * calls is permissionless, so a depositor, a bidder or a passer-by can do the same work from the
 * UI or a CLI — three public documents say so, and the trust model's whole keeper argument rests on
 * it. **Switching this off is meant to be boring** (D-09), and the σ samples are the only thing that
 * cannot be recovered afterwards.
 */

import { Keypair, rpc } from "@stellar/stellar-sdk";

import type { Alert } from "./decide.ts";
import { loop, type Sink } from "./runner.ts";
import { makeVaultClient } from "./vault.ts";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`\nMissing ${name}. See the header of keeper/index.ts.\n`);
    process.exit(2);
  }
  return v;
}

/**
 * The alert channel, deliberately a stub with a real shape.
 *
 * 08-OFFCHAIN §1 says "webhook (generic; wire to whatever later)". What matters now is that alerts
 * leave the process by a path that is not `console.log` buried among the debug lines — a channel
 * that is technically present and practically unread is the one that misses the fourth thing
 * (07-SECURITY §6).
 */
function alertChannel(): (alert: Alert) => void {
  const url = process.env["ALERT_WEBHOOK"]?.trim();
  return (alert: Alert) => {
    console.error(`ALERT [${alert.kind}] ${alert.vault}: ${alert.message}`);
    if (url !== undefined) {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
      }).catch((e: unknown) => {
        console.error(`alert delivery failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  };
}

async function main(): Promise<void> {
  const rpcUrl = need("RPC_URL");
  const passphrase = need("NETWORK_PASSPHRASE");
  const vaultIds = need("VAULT_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const feedId = need("FEED_ID");
  const signer = Keypair.fromSecret(need("KEEPER_SECRET"));
  const assetSymbol = process.env["ASSET_SYMBOL"]?.trim() ?? "XLM";

  const server = new rpc.Server(rpcUrl);
  const emit = alertChannel();
  const sink: Sink = {
    debug: (m, f) => {
      if (process.env["LOG_LEVEL"] === "debug") console.log(`debug ${m}`, f ?? "");
    },
    info: (m, f) => console.log(`info  ${m}`, f ?? ""),
    warn: (m, f) => console.warn(`warn  ${m}`, f ?? ""),
    alert: emit,
  };

  const vaults = vaultIds.map((vaultId) =>
    makeVaultClient({ server, passphrase, vaultId, signer, feedId, assetSymbol }),
  );

  console.log(`keeper: ${vaults.length} vault(s), signer ${signer.publicKey()}`);
  console.log("keeper: holds no admin key; every call it makes is permissionless (D-09)");

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`keeper: ${sig} — finishing the pass and stopping. Rounds still close without us.`);
      running = false;
    });
  }

  await loop(vaults, sink, { running: () => running });
}

await main();
