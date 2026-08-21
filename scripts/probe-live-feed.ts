/**
 * Can a real-parameter round be opened against the live Reflector feed **today**?
 *
 * Read-only. Signs nothing, submits nothing, costs nothing but simulation.
 *
 * # Why this exists, given that IP-3 already profiled the adapter
 *
 * `scripts/profile-adapter.ts` measured the adapter against the live feed on 2026-08-19 and its
 * record is in `deployments/adapter-testnet.json`: resolution 300, decimals 14, a reach limit of
 * 72 900 s with the boundary pinned empirically (a read at age 72 783 answers, one at 73 083 comes
 * back `OutOfReach`), and `Reading` at seven anchor ages. That work is not repeated here.
 *
 * Two things it does **not** answer, and both decide whether Phase 6b can start:
 *
 *   1. **Its `supports_round` matrix was run against a parameter set that is no longer the shipped
 *      one.** The row labelled "the shipped set" carries `oracle_dead_after: 3600`,
 *      `settle_grace: 600`, `unresolved_after: 73 200`, `round_span: 159 600`. D-64 since moved
 *      those to **43 200 / 7 200 / 75 600**, and 6b's round span is `epoch_duration +
 *      unresolved_after` — 334 800 s on instance E, 680 400 s on A. A gate that passed at half the
 *      span says nothing about the span a real round would ask for.
 *   2. **It is two days old.** Every quantity above is live: resolution comes from the feed,
 *      `expires` moves with Reflector's own sponsorship, and condition 3 requires
 *      `unresolved_after > reach_limit` **strictly** — 75 600 clears 72 900 by 2 700 s, which is
 *      one tick of margin. A resolution change on Reflector's side moves the reach limit and that
 *      margin is the first thing it would eat.
 *
 * So this asks the adapter the one question a deploy would ask it, with the arguments a deploy
 * would use, and reports the answer next to what was measured two days ago. If it comes back
 * `false`, 6b cannot open a round at all — and that is worth knowing before three days of
 * calendar time are spent rather than after.
 */

import { readFileSync } from "node:fs";

import { allPassed, failedIds, mkCheck, renderChecks, type Check } from "@antares/common/checks";
import { resolveNetwork, resolveRpcUrl } from "@antares/common/networks";

import { addressOf, makeReader, u32, u64 } from "../integration/read.ts";

/**
 * The parameters a 6b deployment would carry, from 01-DECISIONS' D-47 table.
 *
 * The oracle-facing fields are common to all five instances, which is why `supports_round`'s eight
 * conditions have the same answer for every one of them **except** through `round_span` — the only
 * input that differs, and the only one this probe varies.
 */
const SHIPPED = {
  twap_window: 900,
  guard_window: 3_600,
  oracle_dead_after: 43_200,
  settle_grace: 7_200,
  unresolved_after: 75_600,
} as const;

/** `epoch_duration + unresolved_after`, the span `open_epoch`'s condition 7 asks about. */
const SPANS = [
  { name: "E — 3 d, the shortest deployable instance", epoch: 259_200 },
  { name: "A — 7 d, the mainnet target", epoch: 604_800 },
] as const;

/** What IP-3 measured on 2026-08-19, so drift is visible rather than inferred. */
const IP3 = { resolution: 300, decimals: 14, reachLimitSeconds: 72_900, readsAtAge: 72_783 } as const;

function usage(): never {
  process.stderr.write(
    "usage: NETWORK=testnet probe-live-feed.ts [--source <identity>]\n\n" +
      "  Asks the deployed Reflector adapter whether a real-parameter round could be opened\n" +
      "  today. Read-only: every call is a simulation and nothing is signed.\n",
  );
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
  const net = resolveNetwork(process.env);
  const rpcUrl = resolveRpcUrl(net, process.env);
  const i = argv.indexOf("--source");
  const identity = i === -1 ? "antares-testnet" : (argv[i + 1] ?? usage());

  const record = JSON.parse(
    readFileSync(new URL("../deployments/adapter-testnet.json", import.meta.url), "utf8"),
  ) as { deployment: { adapter: string; feed: string } };
  const adapter = record.deployment.adapter;

  const reader = await makeReader({ rpcUrl, networkPassphrase: net.networkPassphrase }, addressOf(identity));
  const latest = await reader.getLatestLedger();
  const now = Number(latest.closeTime);

  process.stdout.write(`\nadapter ${adapter} on ${net.name}\n`);
  process.stdout.write(`feed    ${record.deployment.feed}\n`);
  process.stdout.write(`ledger clock ${now}\n\n`);

  const checks: Check[] = [];

  // ---- the decisive question ------------------------------------------------------------------
  process.stdout.write("  supports_round, with the arguments a 6b deploy would pass:\n");
  for (const { name, epoch } of SPANS) {
    const span = epoch + SHIPPED.unresolved_after;
    const out = await reader.simulate<boolean>(adapter, "supports_round", [
      u64(SHIPPED.twap_window),
      u64(SHIPPED.guard_window),
      u64(SHIPPED.oracle_dead_after),
      u64(SHIPPED.settle_grace),
      u64(SHIPPED.unresolved_after),
      u64(span),
    ]);
    const answer = out.ok ? String(out.value) : `Error(#${out.errorCode ?? "?"})`;
    process.stdout.write(`    ${name.padEnd(44)} span ${span}s → ${answer}\n`);
    checks.push(
      mkCheck(
        `feed.supports_round.${epoch === 259_200 ? "E" : "A"}`,
        `the adapter supports a round of ${span}s at the shipped oracle parameters`,
        "true",
        answer,
        out.ok && out.value === true,
        "`open_epoch` condition 7 in the only form that decides anything: the real feed, the real " +
          "span, today. IP-3's matrix answered for a 159 600 s span under D-64's older values " +
          "(oracle_dead_after 3 600, settle_grace 600, unresolved_after 73 200), so it does not " +
          "cover this. A `false` here means 6b cannot open a round and the three days would be " +
          "spent finding that out.",
      ),
    );
  }

  // ---- is the feed answering at all, right now ------------------------------------------------
  process.stdout.write("\n  reading(), at two anchors that bracket the reach limit:\n");
  const variantOf = (v: unknown): string =>
    Array.isArray(v)
      ? String((v as unknown[])[0])
      : typeof v === "object" && v !== null
        ? "Reading"
        : String(v);

  const fresh = await reader.simulate<unknown>(adapter, "reading", [
    u64(now - IP3.resolution),
    u64(SHIPPED.twap_window),
    u64(SHIPPED.guard_window),
  ]);
  const freshVariant = fresh.ok ? variantOf(fresh.value) : `Error(#${fresh.errorCode ?? "?"})`;
  process.stdout.write(`    anchor ${IP3.resolution}s old`.padEnd(46) + `→ ${freshVariant}\n`);

  const beyond = await reader.simulate<unknown>(adapter, "reading", [
    u64(now - IP3.reachLimitSeconds - 600),
    u64(SHIPPED.twap_window),
    u64(SHIPPED.guard_window),
  ]);
  const beyondVariant = beyond.ok ? variantOf(beyond.value) : `Error(#${beyond.errorCode ?? "?"})`;
  process.stdout.write(`    anchor ${IP3.reachLimitSeconds + 600}s old`.padEnd(46) + `→ ${beyondVariant}\n`);

  checks.push(
    mkCheck(
      "feed.alive",
      "a fresh anchor still returns a settlement-grade reading",
      "Reading",
      freshVariant,
      freshVariant === "Reading",
      "The live half of the ladder. `Unusable` here would mean the feed has stopped writing " +
        "records the guard window can use; `OutOfReach` at this age would mean the reach limit " +
        "has collapsed.",
    ),
    mkCheck(
      "feed.reach_boundary_holds",
      "and an anchor past IP-3's measured reach limit still comes back OutOfReach rather than answering",
      "OutOfReach",
      beyondVariant,
      beyondVariant === "OutOfReach",
      `IP-3 pinned the boundary on 2026-08-19: answers at age ${IP3.readsAtAge}, OutOfReach at ` +
        `${IP3.reachLimitSeconds + 183}. If this reads instead, the reach limit has GROWN, and ` +
        "condition 3's strict `unresolved_after > reach_limit` — 75 600 against 72 900, one tick " +
        "of margin — is the first thing that would break.",
    ),
  );

  // ---- the spot the ITM guard reads ------------------------------------------------------------
  const spot = await reader.simulate<bigint | null>(adapter, "spot_check", [u64(600), u32(IP3.decimals)]);
  const hasSpot = spot.ok && spot.value !== null && spot.value !== undefined;
  const spotText = hasSpot ? `${String(spot.value)} (14 decimals)` : "None";
  process.stdout.write(`\n  spot_check(max_staleness 600, decimals ${IP3.decimals}) → ${spotText}\n`);
  checks.push(
    mkCheck(
      "feed.spot_available",
      "a live spot is available, which every bid's in-the-money guard depends on",
      "a price",
      spotText,
      hasSpot,
      "`None` does not void anything — the vault classifies it as `OracleUnreachable` and the bid " +
        "is refused rather than filled at a guessed price. But a round whose bids all refuse is a " +
        "round nobody can fill, so this is a precondition for 6b rather than a safety property.",
    ),
  );

  for (const line of renderChecks("live feed — can 6b open a round today?", checks)) {
    process.stdout.write(`${line}\n`);
  }
  if (allPassed(checks)) return 0;
  process.stdout.write(`\nREFUSED: ${failedIds(checks).join(", ")}\n`);
  return 1;
}

if (process.argv[1]?.endsWith("probe-live-feed.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
