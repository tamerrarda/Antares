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
import { rpcSource } from "./rpc-source.ts";
import { archivePass, loop, type Sink } from "./runner.ts";
import { makeVaultClient, makeVaultReader } from "./vault.ts";

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
  const assetSymbol = process.env["ASSET_SYMBOL"]?.trim() ?? "XLM";

  // **Archiving needs no key, and waiting for one is how history gets lost.** Every read this mode
  // makes is a simulation against a public address; it decides nothing and signs nothing. The
  // unrecoverable job therefore does not wait on the recoverable one's credential — see
  // `archivePass`, and D-90 for what the waiting cost the first time.
  const archiveOnly = process.argv.includes("--archive-only");
  const signer = archiveOnly ? null : Keypair.fromSecret(need("KEEPER_SECRET"));

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

  const vaults =
    signer === null
      ? []
      : vaultIds.map((vaultId) =>
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

  console.log(`keeper: archiving to ${evidenceRoot}/ — a round not watched from its opening is not written`);

  if (signer === null) {
    // `SOURCE_ADDRESS` is any account that exists on this network — the simulations quote a
    // sequence number from it and nothing else. It is read from the deployment record rather than
    // written here for the same reason the vault ids are.
    const sourceAddress = need("SOURCE_ADDRESS");
    const readers = vaultIds.map((vaultId) =>
      makeVaultReader({ server, passphrase, vaultId, sourceAddress, feedId, assetSymbol }),
    );
    console.log(`keeper: --archive-only over ${readers.length} vault(s); nothing will be signed`);
    await archivePass(readers, sink, archivist);
    console.log("keeper: archive pass complete");
    return;
  }

  console.log(`keeper: ${vaults.length} vault(s), signer ${signer.publicKey()}`);
  console.log("keeper: holds no admin key; every call it makes is permissionless (D-09)");

  // One pass over every vault, then exit — for a scheduler that owns the interval instead of us.
  //
  // **Not a second code path.** It is `loop` with a `running` that is false after the first sweep,
  // so a cron and a daemon execute the same `pass` in the same order and a bug cannot exist in one
  // and not the other. The exit code is the *scheduler's* concern, not the vault's: a pass that
  // could not settle is normal (somebody else did, or the guard said no) and must not be reported
  // as a failed job, so `--once` exits 0 unless the process itself could not run.
  if (process.argv.includes("--once")) {
    let swept = false;
    await loop(vaults, sink, {
      archivist,
      running: () => {
        if (swept) return false;
        swept = true;
        return true;
      },
    });
    console.log("keeper: one pass complete");
    return;
  }

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
