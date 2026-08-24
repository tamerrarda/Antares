/**
 * The reference bidder's entry point — environment in, loop out, and nothing decided here.
 *
 * Every number that shapes behaviour is an environment variable, because the one thing this process
 * must never do is surprise its operator with a position they did not size. `TARGET_BPS` is the
 * price it will pay; `MAX_NOTIONAL` and `MAX_PORTFOLIO_NOTIONAL` are the limits it cannot exceed;
 * there is no default for any of the three and there deliberately is not. A default position size is
 * a position size somebody did not choose.
 *
 * **This is a self-operated bidder and it says so.** 08-OFFCHAIN §2 and the README honesty rule
 * both require it: premiums cleared against this process on testnet are a mechanism test, not a
 * market price, and the banner below is printed where an operator will see it every time.
 */

import { Keypair, rpc } from "@stellar/stellar-sdk";

import { flatStrategy } from "./strategy.ts";
import { loop, type Sink } from "./runner.ts";
import { makeVaultClient } from "./vault.ts";

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set. The bidder has no defaults for what it will pay or risk.`);
  }
  return value;
}

/** A whole-token amount in the vault's asset, as stroops. Rejects anything it cannot represent. */
function stroops(name: string): bigint {
  const raw = need(name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number of stroops, got ${JSON.stringify(raw)}`);
  }
  const value = BigInt(raw);
  if (value <= 0n) throw new Error(`${name} must be positive`);
  return value;
}

/** An optional positive-integer millisecond setting. */
function optionalMs(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function bps(name: string): number {
  const raw = need(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new Error(`${name} must be an integer in 1..10000 bps, got ${JSON.stringify(raw)}`);
  }
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = need("RPC_URL");
  const passphrase = need("NETWORK_PASSPHRASE");
  const vaultId = need("VAULT_ID");
  const signer = Keypair.fromSecret(need("BIDDER_SECRET"));

  const caps = {
    maxNotional: stroops("MAX_NOTIONAL"),
    maxPortfolioNotional: stroops("MAX_PORTFOLIO_NOTIONAL"),
  };
  if (caps.maxNotional > caps.maxPortfolioNotional) {
    throw new Error(
      "MAX_NOTIONAL exceeds MAX_PORTFOLIO_NOTIONAL, so the per-round cap could never bind. One of " +
        "the two is not the number you meant.",
    );
  }
  const strategy = flatStrategy(bps("TARGET_BPS"));

  const server = new rpc.Server(rpcUrl);
  const client = makeVaultClient({ server, passphrase, vaultId, signer });

  const sink: Sink = {
    debug: (m, f) => {
      if (process.env["LOG_LEVEL"] === "debug") console.log(`debug ${m}`, f ?? "");
    },
    info: (m, f) => console.log(`info  ${m}`, f ?? ""),
    warn: (m, f) => console.warn(`warn  ${m}`, f ?? ""),
    alert: (m, f) => console.error(`ALERT ${m}`, f ?? ""),
  };

  console.log(`bidder: vault ${vaultId}, address ${signer.publicKey()}`);
  console.log(`bidder: strategy=${strategy.name} target=${bps("TARGET_BPS")}bps`);
  console.log(
    "bidder: SELF-OPERATED REFERENCE BIDDER. It prices nothing. Premiums cleared against it are a " +
      "mechanism test, not a market price.",
  );

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`bidder: ${sig} — finishing the pass and stopping.`);
      running = false;
    });
  }

  // The default poll is sized for a real instance, where an auction runs for the better part of an
  // hour. A fast-test profile can run one for twenty seconds — shorter than the default interval —
  // so an operator on such an instance has to be able to say so, or the bidder simply never looks
  // while the window is open.
  const pollMs = optionalMs("POLL_MS");
  await loop(client, sink, {
    caps,
    strategy,
    ...(pollMs === undefined ? {} : { pollMs }),
    running: () => running,
    // Ledger time, not this machine's. `runner.ts` says why the two are not interchangeable.
    clock: async () => Number((await server.getLatestLedger()).closeTime ?? 0),
  });
}

await main();
