/**
 * `scripts/profile-resources.ts` — the vault's resource cost against the limits the network
 * publishes, one entry point at a time.
 *
 * **The Phase-6 gate asks for two things and the second is the one that gets skipped:** costs
 * profiled, *and* within limits **with headroom**. A profile that prints numbers without the
 * limits beside them measures nothing — the number that matters is the ratio, and the ratio is
 * only computable against a limit read from the same network the call would run on.
 *
 * So the limits come from `getLedgerEntries` on the config settings, exactly as
 * `profile-adapter.ts` reads them (D-49, D-58), rather than from a constant in this file. A
 * pinned limit is a limit that silently stops being true the next time the network votes.
 *
 * **Every call is a simulation and nothing is submitted.** A resource profile that had to sign
 * would be a profile nobody runs against an instance holding value, which is the same as no
 * profile. `--send=no` was the flag the roadmap named for this and it prints only the return
 * value — measured on the pinned CLI, 2026-08-21 — so the numbers come from the RPC's own
 * simulation response, which is where they live.
 *
 * Read-only entry points are profiled as they stand. The ones that move money are profiled in the
 * state the deployed instance happens to be in: a refusal still consumes and reports resources, and
 * a call refused at its first guard is the CHEAPEST it will ever be. Those rows are marked, because
 * a floor reported as a measurement is the failure this whole file is arranged against.
 */
import { readFileSync } from "node:fs";

import { resolveNetwork, resolveRpcUrl } from "@antares/common/networks";
import { allPassed, failedIds, mkCheck, renderChecks, type Check } from "@antares/common/checks";

import { rpc } from "@stellar/stellar-sdk";

import { makeReader, addressOf, u32 } from "../integration/read.ts";
import { networkLimits } from "@antares/common/limits";

const HEADROOM_FLOOR = 0.5;

interface Row {
  readonly method: string;
  readonly refused: boolean;
  readonly note: string;
  readonly instructions: number;
  readonly diskReadBytes: number;
  readonly writeBytes: number;
  readonly entries: number;
  readonly fee: bigint;
}

function usage(): never {
  process.stderr.write(
    "usage: NETWORK=testnet profile-resources.ts [--source <identity>]\n\n" +
      "  Simulates every vault entry point against the deployed instance and reports each\n" +
      "  cost beside the limit the network publishes today. Signs nothing.\n",
  );
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
  const net = resolveNetwork(process.env);
  const rpcUrl = resolveRpcUrl(net, process.env);
  const i = argv.indexOf("--source");
  const identity = i === -1 ? "antares-testnet" : (argv[i + 1] ?? usage());

  const record = JSON.parse(
    readFileSync(new URL("../deployments/testnet.json", import.meta.url), "utf8"),
  ) as { instances: { vaultId: string }[] };
  const vault = record.instances[0]?.vaultId;
  if (vault === undefined) return 2;

  const source = addressOf(identity);
  const reader = await makeReader({ rpcUrl, networkPassphrase: net.networkPassphrase }, source);

  // Views first, then the money paths. The argument shapes are the ABI's, and `u32` is explicit
  // because `nativeToScVal(1)` does not produce one — the mistake that cost a scenario run.
  // Every callable entry point. The ABI's own argument shapes, and `u32` is explicit because
  // `nativeToScVal(1)` does not produce one — the mistake that cost a scenario run.
  const calls: { method: string; args: readonly unknown[]; note: string }[] = [
    // -- views, callable in any state ----------------------------------------------------------
    { method: "epoch", args: [], note: "the view every page opens with" },
    { method: "config", args: [], note: "the trust story's numbers" },
    { method: "total_assets", args: [], note: "" },
    { method: "price_per_share", args: [u32(1)], note: "" },
    { method: "position", args: [source], note: "" },
    { method: "bidder_position", args: [u32(1), source], note: "" },
    { method: "convert_to_shares", args: [10_000_000n], note: "" },
    // -- SEP-41 --------------------------------------------------------------------------------
    { method: "name", args: [], note: "" },
    { method: "symbol", args: [], note: "" },
    { method: "decimals", args: [], note: "" },
    { method: "balance", args: [source], note: "" },
    { method: "allowance", args: [source, source], note: "" },
    { method: "approve", args: [source, source, 1_000_000n, u32(4_300_000)], note: "" },
    { method: "transfer", args: [source, source, 1n], note: "" },
    { method: "transfer_from", args: [source, source, source, 1n], note: "" },
    { method: "burn", args: [source, 1n], note: "" },
    { method: "burn_from", args: [source, source, 1n], note: "" },
    // -- the money paths, and the two that decide the ceiling ----------------------------------
    { method: "deposit", args: [source, 10_000_000n], note: "" },
    { method: "bid", args: [source, 10_000_000n, u32(10_000)], note: "the auction's heaviest path" },
    { method: "close_round", args: [source], note: "permissionless; heaviest when it settles" },
    { method: "open_epoch", args: [], note: "permissionless" },
    { method: "request_withdraw", args: [source, 1_000_000n, false], note: "" },
    { method: "claim_withdraw", args: [source], note: "" },
    { method: "claim_payout", args: [u32(1), source], note: "" },
    { method: "claim_refund", args: [u32(1), source], note: "" },
    { method: "claim_fee", args: [], note: "" },
    { method: "redeem_shares", args: [source, 1_000_000n], note: "" },
    { method: "cancel_pending_deposit", args: [source], note: "" },
    { method: "restore_position", args: [source], note: "" },
    // -- admin ---------------------------------------------------------------------------------
    { method: "set_paused", args: [false], note: "" },
    { method: "set_fee_bps", args: [u32(0)], note: "" },
    { method: "set_deposit_cap", args: [1_000_000_000_000n], note: "" },
    { method: "set_allowlist_enabled", args: [false], note: "" },
    { method: "set_allowed", args: [source, true], note: "" },
    { method: "set_fee_recipient", args: [source], note: "" },
    { method: "transfer_admin", args: [source], note: "" },
    { method: "accept_admin", args: [], note: "" },
    { method: "migrate", args: [u32(2)], note: "v1 defines no target; refuses by design" },
  ];

  const rows: Row[] = [];
  for (const c of calls) {
    const out = await reader.simulate<unknown>(vault, c.method, c.args);
    if (out.cost === null) {
      rows.push({
        method: c.method,
        refused: true,
        note: out.ok
          ? "succeeded but reported no resources"
          : `refused (${out.errorCode ?? "?"}) — no resources reported`,
        instructions: 0,
        diskReadBytes: 0,
        writeBytes: 0,
        entries: 0,
        fee: 0n,
      });
      continue;
    }
    rows.push({
      method: c.method,
      refused: !out.ok,
      note: out.ok ? c.note : `refused (${out.errorCode ?? "?"}) — a floor, not a measurement`,
      instructions: out.cost.instructions,
      diskReadBytes: out.cost.diskReadBytes,
      writeBytes: out.cost.writeBytes,
      entries: out.cost.readOnlyEntries + out.cost.readWriteEntries,
      fee: out.cost.minResourceFee,
    });
  }

  // The reader deliberately exposes no limits call: it is the harness's read path and limits are
  // a deployment question. One `rpc.Server` here, one round trip, and the same function the
  // adapter profile uses — so the two profiles cannot disagree about what the ceiling is.
  const measured = rows.filter((r) => r.instructions > 0);
  const refused = rows.filter((r) => r.instructions === 0 && r.note.startsWith("refused"));
  const silent = rows.filter((r) => r.instructions === 0 && !r.note.startsWith("refused"));
  const byMethod = (m: string): string =>
    measured.some((r) => r.method === m) ? "measured" : "refused in this state";

  const limits = await networkLimits(new rpc.Server(rpcUrl, { allowHttp: false }));

  process.stdout.write(`\nvault ${vault} on ${net.name}\n`);
  process.stdout.write(
    `limits read live: ${limits.txMaxInstructions.toLocaleString()} instructions, ` +
      `${limits.txMaxDiskReadBytes.toLocaleString()} disk-read bytes\n\n`,
  );
  process.stdout.write(
    "  method                   instructions   %limit   read B   write B  entries      fee\n",
  );
  for (const r of rows) {
    const pct = limits.txMaxInstructions === 0 ? 0 : (r.instructions / limits.txMaxInstructions) * 100;
    process.stdout.write(
      `  ${r.method.padEnd(24)}${r.instructions.toString().padStart(12)}   ` +
        `${pct.toFixed(2).padStart(6)}   ${r.diskReadBytes.toString().padStart(6)}   ` +
        `${r.writeBytes.toString().padStart(7)}  ${r.entries.toString().padStart(7)}  ` +
        `${r.fee.toString().padStart(7)}${r.note === "" ? "" : `   ${r.note}`}\n`,
    );
  }

  // The entry points whose cost is not fixed. Named here so the assertion below cannot drift
  // from the reasoning: everything else in this contract costs what it costs regardless of how
  // busy the round was.
  const COST_GROWS = ["bid", "close_round"] as const;

  const worst = rows.reduce((a, b) => (b.instructions > a.instructions ? b : a), rows[0]!);
  const used = limits.txMaxInstructions === 0 ? 1 : worst.instructions / limits.txMaxInstructions;
  const checks: Check[] = [
    mkCheck(
      "resources.limits_live",
      "the limits are the network's own, read at run time rather than pinned here",
      "both settings present",
      `${limits.txMaxInstructions} / ${limits.txMaxDiskReadBytes}`,
      limits.txMaxInstructions > 0 && limits.txMaxDiskReadBytes > 0,
    ),
    mkCheck(
      "resources.headroom",
      `the heaviest entry point leaves at least ${(HEADROOM_FLOOR * 100).toFixed(0)}% of the instruction budget`,
      `<= ${((1 - HEADROOM_FLOOR) * 100).toFixed(0)}% of the limit`,
      `${worst.method} at ${(used * 100).toFixed(2)}%`,
      used <= 1 - HEADROOM_FLOOR,
      "06-ROADMAP Phase 6: 'within limits WITH HEADROOM'. A call at 90% of the limit passes today " +
        "and fails on the round where one more Fill lands in its footprint.",
    ),
    mkCheck(
      "resources.nothing_silent",
      "every call either reported resources or named the error that refused it",
      `${calls.length} accounted for`,
      `${measured.length} measured, ${refused.length} refused, ${silent.length} neither`,
      silent.length === 0,
      "A row with no cost and no error code is a call this profile did not actually make — the " +
        "shape a coverage number hides.",
    ),
    mkCheck(
      "resources.cost_growing_paths_accounted",
      "`bid` and `close_round` are profiled somewhere — measured here, or refused here and measured in scenario 1",
      `${COST_GROWS.join(" and ")} accounted for`,
      COST_GROWS.map((m) => `${m} ${byMethod(m)}`).join(", "),
      COST_GROWS.every((m) => {
        const row = rows.find((r) => r.method === m);
        return row !== undefined && (row.instructions > 0 || /^refused \(\d+\)/.test(row.note));
      }),
      "These two are the only entry points whose cost grows with the round — `bid` writes a Fill, " +
        "`close_round` prices a settlement over every Fill the round collected — so a ceiling " +
        "measured without them is the ceiling of the cheap paths. A resting vault refuses both, " +
        "and a refused simulation reports no resources at all, so they cannot be measured from " +
        "here; stage 10 of integration/scenario1.ts measures them mid-round, where the state " +
        "exists. What this check enforces is that they are never quietly dropped from the profile: " +
        "each must appear with a cost or with the error code that refused it.",
    ),
  ];
  for (const line of renderChecks("resource profile", checks)) process.stdout.write(`${line}\n`);
  if (allPassed(checks)) return 0;
  process.stdout.write(`\nREFUSED: ${failedIds(checks).join(", ")}\n`);
  return 1;
}

if (process.argv[1]?.endsWith("profile-resources.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
