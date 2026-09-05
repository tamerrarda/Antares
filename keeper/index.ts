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
import { fileStore } from "./archive.ts";
import { makeArchivist } from "./archivist.ts";
import type { RpcLike } from "./events-source.ts";
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

/**
 * `rpc.Server` narrowed to what the archive reads.
 *
 * The SDK types `getEvents`'s argument as a union — `startLedger` **xor** `cursor`, each forbidding
 * the other — while `RpcLike` states both optional so a test double can be one plain object. The
 * union is the more precise type and this call site is the only code that knows which arm it is
 * in, so the split happens here rather than by loosening `events-source.ts`'s interface to match a
 * vendor's shape it does not otherwise depend on.
 */
function rpcSource(server: rpc.Server): RpcLike {
  return {
    getHealth: async () => {
      const h = await server.getHealth();
      return { oldestLedger: h.oldestLedger, latestLedger: h.latestLedger };
    },
    getEvents: async (request) => {
      const common = {
        filters: request.filters,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      };
      const res = await (request.cursor === undefined
        ? server.getEvents({ startLedger: request.startLedger ?? 0, ...common })
        : server.getEvents({ cursor: request.cursor, ...common }));
      return { events: res.events, latestLedger: res.latestLedger, ...(res.cursor === undefined ? {} : { cursor: res.cursor }) };
    },
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

  // The archive is not optional in production and is constructed here rather than inside `loop`,
  // because where the evidence lands is deployment configuration and the loop has no business
  // knowing a filesystem exists. `EVIDENCE_ROOT` defaults beside the repo's own `evidence/`.
  const evidenceRoot = process.env["EVIDENCE_ROOT"]?.trim() ?? "evidence";
  const network = process.env["NETWORK"]?.trim() ?? "testnet";
  const archivist = makeArchivist({
    rpc: rpcSource(server),
    store: fileStore(evidenceRoot),
    root: evidenceRoot,
    network,
  });

  console.log(`keeper: ${vaults.length} vault(s), signer ${signer.publicKey()}`);
  console.log("keeper: holds no admin key; every call it makes is permissionless (D-09)");
  console.log(`keeper: archiving to ${evidenceRoot}/ — a round not watched from its opening is not written`);

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`keeper: ${sig} — finishing the pass and stopping. Rounds still close without us.`);
      running = false;
    });
  }

  await loop(vaults, sink, { running: () => running, archivist });
}

await main();
