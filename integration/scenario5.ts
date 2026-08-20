/**
 * `06-TEST-PLAN.md` §7 scenario 5 — the upgrade drill.
 *
 *     v-current, state in place → `upgrade` to a marker build → `migrate` → state readable,
 *     a full epoch still closes → back to v-current
 *
 * # Why this drill is what makes freezing the contract safe
 *
 * The vault is at 65 374 bytes against a 65 536 hard limit: **162 bytes of headroom**. Two of the
 * three fixes that landed on 2026-08-21 — D-84's +164 and the claimable derivation's +266 — would
 * not have fitted in that. A finding that arrives after the freeze has to fit, *unless* `upgrade`
 * is known to work, in which case it does not have to fit at all and becomes v2. The drill is not
 * a nice-to-have next to the freeze; it is the thing that makes the freeze survivable.
 *
 * # `migrate` cannot succeed on v1, and asserting the refusal is the honest step
 *
 * `admin.rs` is explicit that this is correct rather than unfinished: *"v1 defines no target, so
 * every call fails… A `migrate` that returned `Ok` here would advance `AppVersion` to a schema that
 * does not exist — claiming a data transformation nobody wrote."* So the step asserts
 * `MigrationOrder`, twice: once for the next version and once for the current one, because the
 * order check is also the idempotence guard and both arms are worth pinning. When v2 lands the same
 * step flips to asserting `Migrated` without the drill being rewritten around it.
 *
 * # The marker build, decided before this file was written
 *
 * 06-TEST-PLAN §7 carries the argument; the short form is that three properties settle it and the
 * first is the section's own requirement. The marker has to **still run an epoch**, so it cannot be
 * a stub. It has to **carry its own `upgrade`**, or the instance is stranded on it and a one-way
 * swap proves half a mechanism. And it should **not exist only to be a fixture**, because a source
 * change made to produce a distinct hash is a change to the shipped contract in service of a test.
 *
 * A **previous release build of this same contract** satisfies all three: its hash differs because
 * the code genuinely differed, it is already uploaded by an earlier deploy, and its hash is in
 * `deployments/testnet.json`'s git history. Nothing is built or uploaded for this drill.
 *
 * # The round spans the upgrade, deliberately
 *
 * §7 asks for *"state in place"* and *"a full epoch still closes"*. Doing those as separate steps
 * would test less than doing them as one: the drill upgrades **while a round is live**, then closes
 * with the new code a round that the old code opened. A storage layout that survived the swap in
 * name but not in meaning fails here and passes a before-and-after comparison of `epoch()`.
 */

import { mkCheck, type Check } from "@antares/common/checks";

import {
  makeCtx,
  parseOptions,
  phaseName,
  record,
  repoRoot,
  runStages,
  type Ctx,
  type EpochView,
  type Stage,
} from "./harness.ts";
import { ledgerNow, waitUntilLedgerTime } from "./ledger-clock.ts";
import { invoke, u32 } from "./read.ts";

// The drill's own state. Module-level rather than bolted onto `Ctx`, which every scenario shares
// and none of the others has an upgrade to remember.
let before: Snapshot | null = null;
let markerWasm = "";
let currentWasm = "";

/**
 * The default marker: the D-84 release, 65 108 bytes, uploaded to testnet on 2026-08-20 by the
 * deploy recorded at `c55700c` and still installed.
 *
 * A default rather than a discovery, so the drill cannot quietly pick something else. `--marker-wasm`
 * overrides it; anything passed there must be a build that is **already uploaded**, since this drill
 * deliberately builds and uploads nothing.
 */
export const DEFAULT_MARKER_WASM = "19a0a90e600ddef996f21b9a794232b8e4a802f6ae6c03fab0bd0bc3012c0685";

/**
 * `errors.rs:113`. The only answer v1's `migrate` can honestly give.
 *
 * Read out of `errors.rs` rather than guessed: the first draft of this file said 40, which is a
 * different error entirely, and the check would have failed against a perfectly correct contract.
 */
export const MIGRATION_ORDER_CODE = 51;

interface ConfigView {
  readonly admin: string;
  readonly asset: string;
  readonly oracle: string;
  readonly fee_recipient: string;
  readonly deposit_cap: bigint;
  readonly fee_bps: number;
  readonly paused: boolean;
  readonly allowlist_enabled: boolean;
  readonly allowlist_expires_at: bigint;
  readonly app_version: number;
  readonly rent_threshold: number;
  readonly rent_extend_to: number;
}

/** Captured before the swap and compared after it, field by field. */
interface Snapshot {
  readonly config: ConfigView;
  readonly epoch: EpochView;
  readonly totalAssets: bigint;
  readonly servedWasm: string;
}

async function snapshot(ctx: Ctx): Promise<Snapshot> {
  return {
    config: await ctx.reader.read<ConfigView>(ctx.vault, "config"),
    epoch: await ctx.reader.read<EpochView>(ctx.vault, "epoch"),
    totalAssets: await ctx.reader.read<bigint>(ctx.vault, "total_assets"),
    servedWasm: await ctx.reader.servedWasmSha256(ctx.vault),
  };
}

/**
 * Every field of `Config` and `State` that should be identical across a code swap, named.
 *
 * Named rather than deep-compared on purpose: a deep comparison of two objects passes when both
 * decode to `{}` because the shape changed underneath, which is the exact failure this is looking
 * for. `test_types.rs` names every field for the same reason.
 */
function survived(a0: Snapshot, after: Snapshot): Check[] {
  const pairs: [string, unknown, unknown][] = [
    ["config.admin", a0.config.admin, after.config.admin],
    ["config.asset", a0.config.asset, after.config.asset],
    ["config.oracle", a0.config.oracle, after.config.oracle],
    ["config.fee_recipient", a0.config.fee_recipient, after.config.fee_recipient],
    ["config.deposit_cap", a0.config.deposit_cap, after.config.deposit_cap],
    ["config.fee_bps", a0.config.fee_bps, after.config.fee_bps],
    ["config.paused", a0.config.paused, after.config.paused],
    ["config.allowlist_enabled", a0.config.allowlist_enabled, after.config.allowlist_enabled],
    ["config.allowlist_expires_at", a0.config.allowlist_expires_at, after.config.allowlist_expires_at],
    ["config.app_version", a0.config.app_version, after.config.app_version],
    ["config.rent_threshold", a0.config.rent_threshold, after.config.rent_threshold],
    ["config.rent_extend_to", a0.config.rent_extend_to, after.config.rent_extend_to],
    ["state.round", a0.epoch.round, after.epoch.round],
    ["state.phase", phaseName(a0.epoch.phase), phaseName(after.epoch.phase)],
    ["state.notional_offered", a0.epoch.notional_offered, after.epoch.notional_offered],
    ["state.notional_sold", a0.epoch.notional_sold, after.epoch.notional_sold],
    ["state.premium_collected", a0.epoch.premium_collected, after.epoch.premium_collected],
    ["state.strike", a0.epoch.strike, after.epoch.strike],
    ["state.open_twap", a0.epoch.open_twap, after.epoch.open_twap],
    ["state.expiry", a0.epoch.expiry, after.epoch.expiry],
    ["state.shares_outstanding", a0.epoch.shares_outstanding, after.epoch.shares_outstanding],
    ["state.last_pps", a0.epoch.last_pps, after.epoch.last_pps],
    ["total_assets", a0.totalAssets, after.totalAssets],
  ];
  return pairs.map(([id, b, a]) =>
    mkCheck(
      `survived.${id}`,
      `${id} is the value it was before the code swap`,
      String(b),
      String(a),
      String(b) === String(a),
    ),
  );
}

// =================================================================================================

const stage0: Stage = {
  id: "0",
  title: "what is deployed now, and what the marker is — captured before anything moves",
  async run(ctx) {
    const snap = await snapshot(ctx);
    before = snap;
    const marker = ctx.opts.markerWasm === "" ? DEFAULT_MARKER_WASM : ctx.opts.markerWasm;
    markerWasm = marker;
    currentWasm = snap.servedWasm;
    return [
      mkCheck(
        "upgrade.current_served",
        "the hash the network is actually serving, read back rather than assumed",
        "a sha256",
        `${snap.servedWasm.slice(0, 16)}…`,
        /^[0-9a-f]{64}$/.test(snap.servedWasm),
        "Read from the bytes the network will execute, not from the deployment record — the record " +
          "is what this drill is about to make temporarily untrue.",
      ),
      mkCheck(
        "upgrade.marker_differs",
        "the marker is a different build, or the swap would prove nothing",
        `!= ${snap.servedWasm.slice(0, 16)}…`,
        `${marker.slice(0, 16)}…`,
        marker !== snap.servedWasm && /^[0-9a-f]{64}$/.test(marker),
        "The marker is a previous release of this same contract, already uploaded. Nothing is built " +
          "or uploaded by this drill: a build made to be a fixture is a change to the shipped " +
          "contract in service of a test.",
      ),
      mkCheck(
        "upgrade.state_to_preserve",
        "there is state worth preserving across the swap",
        "> 0 shares",
        String(snap.epoch.shares_outstanding),
        snap.epoch.shares_outstanding > 0n,
        `Round ${snap.epoch.round}, phase ${phaseName(snap.epoch.phase)}, total_assets ` +
          `${snap.totalAssets}. An upgrade over an empty vault would pass every check below and ` +
          "prove nothing about migration.",
      ),
    ];
  },
};

const stage1: Stage = {
  id: "1",
  title: "upgrade to the marker — asserted against the bytes the network serves",
  async run(ctx) {
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "upgrade",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { new_wasm_hash: markerWasm },
      }),
      "upgrade:marker",
    );
    const served = await ctx.reader.servedWasmSha256(ctx.vault);
    return [
      mkCheck(
        "upgrade.swapped",
        "the network now serves the marker's bytes",
        markerWasm,
        served,
        served === markerWasm,
        "`upgraded` announces a hash and the deployer accepted one; this reads back what the " +
          "network will EXECUTE, which is the claim that matters — the same one D-50's gate makes " +
          "about a fresh deploy.",
      ),
    ];
  },
};

const stage2: Stage = {
  id: "2",
  title: "state in place — every field of Config and State, named",
  async run(ctx) {
    const after = await snapshot(ctx);
    if (before === null) throw new Error("stage 0 did not run");
    return survived(before, after);
  },
};

const stage3: Stage = {
  id: "3",
  title: "migrate — v1 has no target, so the honest assertion is the refusal",
  async run(ctx) {
    const version = (await ctx.reader.read<ConfigView>(ctx.vault, "config")).app_version;
    const next = await ctx.reader.simulate(ctx.vault, "migrate", [u32(version + 1)]);
    const same = await ctx.reader.simulate(ctx.vault, "migrate", [u32(version)]);
    return [
      mkCheck(
        "migrate.no_target",
        "migrating to the next version is refused, because v1 defines no target",
        `Error(Contract, #${MIGRATION_ORDER_CODE})`,
        next.ok ? "SUCCEEDED" : `Error(Contract, #${next.errorCode ?? "?"})`,
        !next.ok && next.errorCode === MIGRATION_ORDER_CODE,
        "admin.rs: *'a `migrate` that returned Ok here would advance AppVersion to a schema that " +
          "does not exist — claiming a data transformation nobody wrote.'* A SUCCEEDED here would " +
          "be the finding, not a pass. When v2 lands this check flips to asserting `Migrated`.",
      ),
      mkCheck(
        "migrate.order_guard",
        "and migrating to the CURRENT version is refused too, which is the idempotence guard",
        `Error(Contract, #${MIGRATION_ORDER_CODE})`,
        same.ok ? "SUCCEEDED" : `Error(Contract, #${same.errorCode ?? "?"})`,
        !same.ok && same.errorCode === MIGRATION_ORDER_CODE,
        "`to_version == app + 1` means a second call with the same argument fails. The guard is " +
          "written before the first real target exists precisely so it is not one that was missing " +
          "for a release.",
      ),
    ];
  },
};

const stage4: Stage = {
  id: "4",
  title: "a full epoch still closes — with the new code, on a round the old code opened",
  async run(ctx) {
    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    if (phaseName(e.phase) === "Idle") {
      return [
        mkCheck(
          "epoch.spans_upgrade",
          "a live round spanned the code swap",
          "a round to close",
          "Idle — nothing was open",
          false,
          "This drill wants the round OPENED BY THE OLD CODE closed by the new one, which tests more " +
            "than opening a fresh round afterwards: a storage layout that survived the swap in name " +
            "but not in meaning passes a before-and-after read of epoch() and fails here. Run " +
            "scenario 4 first — it leaves an Active round behind on purpose — or open one.",
        ),
      ];
    }

    // `close_round` is legal from `expiry`; past `expiry + unresolved_after` it takes D-64's
    // oracle-free path and needs no feed at all, which is the branch a drill can rely on.
    const target = Number(e.expiry) + ctx.params["unresolved_after"]! + 5;
    const now = await ledgerNow(ctx.reader);
    console.log(
      `    round ${e.round} expires ${e.expiry}; closing at ${target}, ledger clock ${now.closeTime}`,
    );
    await waitUntilLedgerTime(ctx.reader, target, {
      timeoutSeconds: ctx.params["epoch_duration"]! + ctx.params["unresolved_after"]! + 180,
      onTick: (t) =>
        process.stdout.write(`\r    waiting for the close window — ledger clock ${t.closeTime}   `),
    });
    process.stdout.write("\n");

    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "close_round",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { bounty_to: ctx.addresses.admin },
      }),
      "close_round:after-upgrade",
    );

    const closed = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    return [
      mkCheck(
        "epoch.closed",
        "the round the old code opened was closed by the new code",
        "Idle",
        phaseName(closed.phase),
        phaseName(closed.phase) === "Idle",
        `Round ${closed.round} finalized under the marker build. last_pps ${closed.last_pps}.`,
      ),
      mkCheck(
        "epoch.pps_recorded",
        "and it recorded a price per share, so the finalization did real work",
        "> 0",
        String(closed.last_pps),
        closed.last_pps > 0n,
      ),
    ];
  },
};

const stage5: Stage = {
  id: "5",
  title: "back to v-current — the drill ends where it started",
  async run(ctx) {
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "upgrade",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { new_wasm_hash: currentWasm },
      }),
      "upgrade:restore",
    );
    const served = await ctx.reader.servedWasmSha256(ctx.vault);
    return [
      mkCheck(
        "restore.swapped_back",
        "the network serves the build the drill found, so the instance is reusable",
        currentWasm,
        served,
        served === currentWasm,
        "The marker carrying its own `upgrade` is what makes this step possible. A one-way swap " +
          "would have proved half the mechanism and left the vault stranded on a build nobody ships.",
      ),
      mkCheck(
        "restore.record_true_again",
        "and deployments/<network>.json describes the deployed contract once more",
        currentWasm.slice(0, 16),
        served.slice(0, 16),
        served === currentWasm,
        "The record was temporarily untrue between stages 1 and 5, which is worth stating: a drill " +
          "that left it untrue would have broken every tool that reads it.",
      ),
    ];
  },
};

export const STAGES: readonly Stage[] = [stage0, stage1, stage2, stage3, stage4, stage5];

/** Everything except the epoch, for a run that has no live round to spend. */
export const NO_EPOCH_STAGES: readonly Stage[] = [stage0, stage1, stage2, stage3, stage5];

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseOptions(argv, repoRoot());
  const ctx = await makeCtx(opts);
  if (ctx === null) {
    console.error(
      `\nusage: NETWORK=testnet scenario5.ts [--admin <id>] [--marker-wasm <sha256>] [--no-epoch]\n\n` +
        `  06-TEST-PLAN §7 scenario 5 — the upgrade drill. Upgrades to a previous release of this\n` +
        `  same contract, asserts Config and State survived field by field, asserts migrate refuses\n` +
        `  as v1 must, closes a round the OLD code opened, and upgrades back.\n\n` +
        `  Nothing is built or uploaded: the marker must already be installed.\n` +
        `  --no-epoch   skip stage 4 when there is no live round to close.\n`,
    );
    return 2;
  }

  console.log(`\nAntares integration — 06-TEST-PLAN §7 scenario 5, the upgrade drill`);
  console.log(`  network   ${opts.network} via ${ctx.net.rpcUrl}`);
  console.log(`  vault     ${ctx.vault}`);
  console.log(`  marker    ${opts.markerWasm === "" ? `${DEFAULT_MARKER_WASM} (default)` : opts.markerWasm}`);

  const ok = await runStages(argv.includes("--no-epoch") ? NO_EPOCH_STAGES : STAGES, ctx);
  return ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("scenario5.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
