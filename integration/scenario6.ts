/**
 * `06-TEST-PLAN.md` §7 scenario 6 — archival and restore.
 *
 *     read a position's TTL from the ledger → have a stranger refresh it → read it again
 *
 * # Half of this scenario is deliberately not here, and the plan says so first
 *
 * `03-STORAGE-TTL.md` §5 rules on the split before any of it was written:
 *
 * > *An integration test on testnet exercises restore end-to-end once during Phase 6: let a test
 * > position's TTL lapse naturally is impractical — instead deploy a throwaway instance with the
 * > archival path exercised via snapshot tests (`Env::from_ledger_snapshot_file`) simulating
 * > archived entries.*
 *
 * So the **decay** — an entry falling below the bump threshold and being brought back — belongs to
 * `test_storage.rs`, which jumps the ledger sequence by 400 000 and asserts every key a user owns
 * comes back. Testnet cannot do that: persistent entries live for weeks and there is no way to age
 * one on demand.
 *
 * What testnet CAN prove, and nothing else does, is the half that is about the deployment rather
 * than the code: that the entry point exists on the served binary, that it is genuinely callable by
 * a stranger, that it does not trap on a user who owns nothing, and that a real position's TTL —
 * read from the ledger by an outsider, not from a view the contract controls — is where the rent
 * parameters say it should be.
 *
 * # Why "the TTL went up" is not the assertion
 *
 * It would be the obvious one and it would be wrong most of the time. Soroban's `extend_ttl` is a
 * floor, not an increment: `storage.rs` calls it with `(threshold, extend_to)`, and an entry
 * already living past `threshold` is left exactly where it was. Every write to a position bumps it,
 * so a `Shares` entry touched by a recent deposit is at the ceiling already and `restore_position`
 * moves nothing. A test asserting an increase would fail against a perfectly healthy vault and
 * pass only on a neglected one.
 *
 * The falsifiable pair is different: the TTL must never go **down**, and the entry must sit at
 * least `rent_threshold` ledgers clear of expiry afterwards — which is `sweep.ts`'s actual promise,
 * *"an entry that never gets close to expiry is never restored under pressure, never restored by a
 * user who does not know they have to, and never the reason someone cannot exit."* Both numbers are
 * printed either way, so a no-op is visible as a no-op rather than hidden inside a green check.
 *
 * # The key is built here rather than read from a view
 *
 * `DataKey::Shares(Address)` is a `#[contracttype]` tuple variant, so its ledger key is
 * `ScVal::Vec([Symbol("Shares"), Address])`. Constructing it in this file and asking the RPC for
 * the entry is the point: an outsider holding nothing but the contract id can check a position's
 * archival exposure without the contract's cooperation. A `get_ttl` view would prove the contract
 * agrees with itself.
 */

import { mkCheck } from "@antares/common/checks";

import { makeCtx, parseOptions, record, repoRoot, runStages, type Ctx, type Stage } from "./harness.ts";
import { invoke } from "./read.ts";

/** The rent settings the vault actually enforces, from its own view. */
interface RentView {
  readonly rent_threshold: number;
  readonly rent_extend_to: number;
}

/** A persistent entry's archival position, as an outsider sees it. */
interface EntryTtl {
  /** The last ledger the entry is live for; `null` when the entry does not exist. */
  readonly liveUntil: number | null;
  /** The ledger the read was taken at, so the two can be compared. */
  readonly at: number;
}

/**
 * `liveUntilLedgerSeq` for `DataKey::Shares(user)`, read straight off the RPC.
 *
 * Deliberately not routed through `Reader`: this is the one read in the harness that an outsider
 * makes *about* the contract rather than *of* it, and giving it its own path keeps that visible.
 */
async function sharesTtl(ctx: Ctx, user: string): Promise<EntryTtl> {
  const { rpc, xdr, Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  const server = new rpc.Server(ctx.net.rpcUrl, { allowHttp: ctx.net.rpcUrl.startsWith("http://") });
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(ctx.vault).toScAddress(),
      key: xdr.ScVal.scvVec([nativeToScVal("Shares", { type: "symbol" }), new Address(user).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const res = await server.getLedgerEntries(key);
  const live = res.entries[0]?.liveUntilLedgerSeq;
  return {
    liveUntil: live === undefined || live === null ? null : Number(live),
    at: Number(res.latestLedger),
  };
}

/** State carried between the stages, because each one measures against the last. */
const seen: { before?: EntryTtl; rent?: RentView } = {};

// =================================================================================================

const stage0: Stage = {
  id: "0",
  title: "a position to restore, and its archival position read from the ledger",
  async run(ctx) {
    const rent = await ctx.reader.read<RentView>(ctx.vault, "config");
    const shares = await ctx.reader.read<bigint>(ctx.vault, "balance", [ctx.addresses.depositor]);
    const before = await sharesTtl(ctx, ctx.addresses.depositor);
    seen.rent = rent;
    seen.before = before;

    console.log(
      `\n  rent_threshold ${rent.rent_threshold}, rent_extend_to ${rent.rent_extend_to} ledgers\n` +
        `  Shares(depositor) lives until ledger ${before.liveUntil ?? "(no entry)"} ` +
        `— read at ledger ${before.at}\n`,
    );

    return [
      mkCheck(
        "position.exists",
        "the depositor holds shares, so there is a position for the restore to be about",
        "> 0",
        String(shares),
        shares > 0n,
        "A restore of nothing is stage 3's subject and a different claim. This one needs a real " +
          "position or every number below is about an absent entry.",
      ),
      mkCheck(
        "position.entry_readable",
        "an outsider can read the entry's archival position with nothing but the contract id",
        "a liveUntilLedgerSeq",
        before.liveUntil === null ? "no entry returned" : String(before.liveUntil),
        before.liveUntil !== null,
        "`DataKey::Shares(Address)` built here as ScVal::Vec([Symbol, Address]) and handed to " +
          "getLedgerEntries. If this needed a contract view, the archival exposure of a position " +
          "would be something the contract asserts about itself.",
      ),
    ];
  },
};

const stage1: Stage = {
  id: "1",
  title: "a stranger refreshes it — permissionless, and by transaction",
  run(ctx) {
    // Signed by bidder-B, who holds no authority over the depositor and no position of their own
    // in this call. `vault.rs` has no `require_auth` here at all, and 03-STORAGE-TTL §4 says why:
    // a helper must be able to maintain a dormant user's position without holding anything of
    // theirs. Signing as the depositor would prove the entry point runs and nothing about that.
    const out = invoke({
      contractId: ctx.vault,
      method: "restore_position",
      identity: ctx.opts.bidderB,
      net: ctx.net,
      args: { user: ctx.addresses.depositor },
    });
    record(ctx, out, "restore_position:by_a_stranger");
    const combined = `${out.stdout}\n${out.stderr}`;

    return Promise.resolve([
      mkCheck(
        "restore.by_a_stranger",
        "an account with no authority over the depositor can refresh their position",
        "the transaction lands",
        /Signing transaction/.test(combined) ? "landed" : "no transaction was signed",
        /Signing transaction/.test(combined),
        `Signed by ${ctx.opts.bidderB} (${ctx.addresses.bidderB}), for ${ctx.addresses.depositor}. ` +
          "D-09: the sweep is a convenience, and it only is one because nobody has to be trusted " +
          "to run it.",
      ),
    ]);
  },
};

const stage2: Stage = {
  id: "2",
  title: "the TTL claim — a floor, not an increment",
  async run(ctx) {
    const after = await sharesTtl(ctx, ctx.addresses.depositor);
    const before = seen.before!;
    const rent = seen.rent!;
    const clear = after.liveUntil === null ? 0 : after.liveUntil - after.at;

    console.log(
      `\n  before ${before.liveUntil} (at ${before.at})  →  after ${after.liveUntil} (at ${after.at})\n` +
        `  ${clear} ledgers of headroom against a threshold of ${rent.rent_threshold}` +
        `${before.liveUntil === after.liveUntil ? "  — unchanged, which is the expected shape for a fresh entry" : ""}\n`,
    );

    return [
      mkCheck(
        "ttl.never_falls",
        "the refresh did not shorten the entry's life",
        `>= ${before.liveUntil}`,
        String(after.liveUntil),
        after.liveUntil !== null && before.liveUntil !== null && after.liveUntil >= before.liveUntil,
        "`extend_ttl` is a floor: an entry already living past `rent_threshold` is left where it " +
          "is. Asserting an increase would fail on a healthy vault and pass only on a neglected " +
          "one, so the direction is what is asserted and the numbers are printed either way.",
      ),
      mkCheck(
        "ttl.clear_of_the_threshold",
        "the position sits clear of the bump threshold, which is what makes archival a non-event",
        `> ${rent.rent_threshold} ledgers`,
        `${clear} ledgers`,
        clear > rent.rent_threshold,
        "`sweep.ts`'s promise in the only terms an outsider can check: an entry this far from " +
          "expiry is never restored under pressure and never the reason somebody cannot exit.",
      ),
      mkCheck(
        "ttl.within_the_ceiling",
        "and no further out than the rent parameter allows, so the extend target is the one configured",
        `<= ${rent.rent_extend_to} ledgers`,
        `${clear} ledgers`,
        clear <= rent.rent_extend_to,
        "The other side of the same number. `Rent::effective` clamps `rent_extend_to` to the " +
          "network's live `max_ttl`, so an entry beyond it would mean the deployment is enforcing " +
          "a ceiling this config does not describe.",
      ),
    ];
  },
};

const stage3: Stage = {
  id: "3",
  title: "a user who owns nothing — the case a roster-driven sweep hits constantly",
  async run(ctx) {
    // `extend_ttl` on an absent key TRAPS. `storage.rs` uses `bump_if_present` for exactly this,
    // and the reason is operational rather than theoretical: the sweep walks a roster built from
    // events, and an address that deposited and fully exited owns no `Shares` entry any more. If
    // this trapped, one exited user would end every sweep the vault ever runs.
    const out = await ctx.reader.simulate(ctx.vault, "restore_position", [ctx.addresses.bidderA]);
    const ttl = await sharesTtl(ctx, ctx.addresses.bidderA);

    return [
      mkCheck(
        "restore.empty_is_not_a_trap",
        "restoring a position that does not exist succeeds instead of trapping",
        "succeeds",
        out.ok ? "succeeded" : `Error(Contract, #${out.errorCode ?? "?"}) ${out.errorText ?? ""}`.trim(),
        out.ok,
        `Simulated against ${ctx.addresses.bidderA}, whose Shares entry is ` +
          `${ttl.liveUntil === null ? "absent" : `present (until ${ttl.liveUntil})`}. ` +
          "`bump_if_present` is the guard; a trap here would end every sweep at the first exited user.",
      ),
    ];
  },
};

export const STAGES: readonly Stage[] = [stage0, stage1, stage2, stage3];

// =================================================================================================
// Runner
// =================================================================================================

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseOptions(argv, repoRoot());
  const ctx = await makeCtx(opts);
  if (ctx === null) {
    console.error(
      `\nusage: NETWORK=testnet scenario6.ts [--depositor <id>] [--bidder-a <id>] [--bidder-b <id>]\n\n` +
        `  06-TEST-PLAN §7 scenario 6 — archival and restore, the half testnet can prove. One\n` +
        `  transaction, signed by an account with no authority over the position it refreshes.\n` +
        `  The decay half is 03-STORAGE-TTL §5's snapshot tests in test_storage.rs, and cannot be\n` +
        `  done here: persistent entries live for weeks and none can be aged on demand.\n`,
    );
    return 2;
  }

  console.log(`\nAntares integration — 06-TEST-PLAN §7 scenario 6, archival and restore`);
  console.log(`  network   ${opts.network} via ${ctx.net.rpcUrl}`);
  console.log(`  vault     ${ctx.vault}`);

  return (await runStages(STAGES, ctx)) ? 0 : 1;
}

if (process.argv[1]?.endsWith("scenario6.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
