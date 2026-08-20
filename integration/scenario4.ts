/**
 * `06-TEST-PLAN.md` §7 scenario 4 — the pause drill.
 *
 *     pause mid-`Active` → run the whole I8 set live → unpause
 *
 * # What I8 actually says, and why a careless test of it is wrong in both directions
 *
 * 02-CONTRACT-SPEC §16: the nine functions *"succeed under `paused == true` **in every state where
 * they'd succeed unpaused**"*. The conditional is the whole invariant. Several of the nine are
 * state-gated — `claim_refund` needs a voided round, `redeem_shares` needs a pending deposit,
 * `restore_position` needs an archived one — so:
 *
 *   - asserting that all nine **succeed** under pause fails on a perfectly healthy vault, and
 *   - asserting merely that all nine were **called** passes on a bricked one.
 *
 * The falsifiable form is neither. **For each of the nine, the refusal must not be `Paused`.** A
 * state refusal returns its own code and is the invariant holding rather than breaking, which is
 * exactly the distinction D-12 exists to make: pause stops money going *in*, never money coming
 * *out*.
 *
 * # Simulation, and what that buys
 *
 * A simulation returns the contract's error without submitting, so all nine cost nothing and the
 * drill spends two transactions — the pause and the unpause — instead of eleven. It also means the
 * drill leaves no trace in the nine functions' own state, so it can be re-run against the same
 * instance without first undoing itself.
 *
 * **Non-vacuity is the tenth simulation.** `deposit` is a function pause *does* block, and it must
 * come back `Paused`. Without it, nine green results are equally consistent with a pause that was
 * never applied — which is the failure mode this repository has now met six times, and the reason
 * every gate here is driven in both directions.
 *
 * # Getting to Active without waiting for a clock
 *
 * §5 step 6: a fill that takes the whole offer flips the phase to `Active` **immediately**, rather
 * than at `auction_end`. So the drill subscribes the offer in one bid and is in Active within a
 * ledger or two, instead of waiting out an auction. And a round that takes no bids at all does not
 * reach Active — it lapses at `auction_end`, measured 2026-08-20 — so a bid is not optional here.
 *
 * The round is left open on purpose. The drill does not own it, and a later run reuses whatever
 * Active round it finds rather than spending eleven minutes closing one it did not need.
 */

import { mkCheck, type Check } from "@antares/common/checks";

import {
  ensureAllowed,
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
import { ledgerNow } from "./ledger-clock.ts";
import { invoke, u32, type ResourceCost } from "./read.ts";
import { MOCK_FEED_RECORDS, OPEN_PRICE, PRIME_HORIZON_SECONDS } from "./scenario1.ts";

/** `errors.rs`: `Paused = 1`. The one code that would falsify I8. */
export const PAUSED_ERROR_CODE = 1;

/**
 * The nine functions I8 names, in §16's own order, with arguments that reach the pause check.
 *
 * The arguments do not have to describe a state where the call would *succeed* — they have to be
 * well-formed enough that the call gets past argument decoding, because the invariant is about
 * which refusal comes back rather than about whether one does.
 */
export function i8Calls(ctx: Ctx, round: number): { name: string; args: readonly unknown[] }[] {
  const me = ctx.addresses.admin;
  return [
    { name: "close_round", args: [me] },
    { name: "request_withdraw", args: [me, 1n, false] },
    { name: "claim_withdraw", args: [me] },
    { name: "claim_payout", args: [u32(round), ctx.addresses.bidderA] },
    { name: "claim_refund", args: [u32(round), ctx.addresses.bidderA] },
    { name: "claim_fee", args: [] },
    { name: "cancel_pending_deposit", args: [me] },
    { name: "redeem_shares", args: [me] },
    { name: "restore_position", args: [me] },
  ];
}

const fmt = (c: ResourceCost | null): string =>
  c === null ? "(no profile)" : `${c.instructions} insn, fee ${c.minResourceFee}`;

// =================================================================================================

const stage0: Stage = {
  id: "0",
  title: "an Active round to pause in the middle of — reused if one is already open",
  async run(ctx) {
    const before = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    if (phaseName(before.phase) === "Active") {
      ctx.round = before.round;
      return [
        mkCheck(
          "active.reused",
          "an Active round was already open, so this drill spends nothing to reach one",
          "Active",
          phaseName(before.phase),
          true,
          `Round ${before.round}, notional_sold ${before.notional_sold}. The drill does not own the ` +
            "round: it pauses, asks nine questions by simulation, and unpauses.",
        ),
      ];
    }
    if (phaseName(before.phase) !== "Idle") {
      return [
        mkCheck(
          "active.phase",
          "the vault is in a phase this drill can start from",
          "Idle or Active",
          phaseName(before.phase),
          false,
          "An Auction is a window this drill would race; wait for it to close and run again.",
        ),
      ];
    }

    // Idle: build a round. Two preconditions before anything is spent — the allowlist, because a
    // fresh vault ships with it ON (D-63) and a bid without it fails as AllowlistForbidden four
    // transactions later; and the feed, whose coverage is a precondition rather than a parameter.
    await ensureAllowed(ctx, invoke);
    const now = await ledgerNow(ctx.reader);
    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "set_expires",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { at: now.closeTime + 86_400 },
      }),
      "prime:set_expires",
    );
    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "fill",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: {
          end: now.closeTime + PRIME_HORIZON_SECONDS,
          count: MOCK_FEED_RECORDS,
          price: OPEN_PRICE,
        },
      }),
      "prime:fill",
    );
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "deposit",
        identity: ctx.opts.depositor,
        net: ctx.net,
        args: { from: ctx.addresses.depositor, amount: ctx.opts.deposit },
      }),
      "deposit",
    );
    record(
      ctx,
      invoke({ contractId: ctx.vault, method: "open_epoch", identity: ctx.opts.admin, net: ctx.net }),
      "open_epoch",
    );

    const opened = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    // The WHOLE offer in one bid: §5 step 6 flips the phase the instant it is subscribed, so this
    // reaches Active in a ledger rather than at auction_end. A round with no bids never gets here
    // at all — it lapses when the auction closes.
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "bid",
        identity: ctx.opts.bidderA,
        net: ctx.net,
        args: {
          bidder: ctx.addresses.bidderA,
          notional: opened.notional_offered,
          max_premium_bps: ctx.opts.maxPremiumBps,
        },
      }),
      "bid:subscribe",
    );

    const after = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    ctx.round = after.round;
    return [
      mkCheck(
        "active.subscribed",
        "one bid took the whole offer, which flips the phase without waiting for auction_end",
        after.notional_offered,
        after.notional_sold,
        after.notional_sold === after.notional_offered,
        "§5 step 6: full subscription moves to Active immediately, because the offer is gone and " +
          "the curve stops mattering at that instant rather than at the end of the window.",
      ),
      mkCheck(
        "active.phase",
        "the vault is Active",
        "Active",
        phaseName(after.phase),
        phaseName(after.phase) === "Active",
      ),
    ];
  },
};

const stage1: Stage = {
  id: "1",
  title: "pause",
  async run(ctx) {
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "set_paused",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { paused: true },
      }),
      "set_paused:true",
    );
    const cfg = await ctx.reader.read<{ paused: boolean }>(ctx.vault, "config");
    const epoch = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    return [
      mkCheck("pause.on", "config() reports the vault paused", true, cfg.paused, cfg.paused === true),
      mkCheck(
        "pause.mid_active",
        "and the pause happened MID-ROUND, which is the state §7 asks for",
        "Active",
        phaseName(epoch.phase),
        phaseName(epoch.phase) === "Active",
        "Pausing an Idle vault would exercise none of I8's interesting cases: the exit paths that " +
          "matter are the ones with a live round's money behind them.",
      ),
    ];
  },
};

const stage2: Stage = {
  id: "2",
  title: "the I8 set, live and paused — none of the nine may be refused with Paused",
  async run(ctx) {
    const checks: Check[] = [];

    // The tenth call FIRST, because it decides whether the other nine mean anything. If `deposit`
    // is not refused with Paused then the pause is not in force and nine clean results below would
    // be reporting the absence of a pause rather than the presence of an invariant.
    const blocked = await ctx.reader.simulate(ctx.vault, "deposit", [
      ctx.addresses.depositor,
      ctx.opts.deposit,
    ]);
    checks.push(
      mkCheck(
        "i8.control.deposit_is_blocked",
        "a function pause DOES block comes back Paused, so the nine below are answering a real pause",
        `Error(Contract, #${PAUSED_ERROR_CODE})`,
        blocked.ok ? "succeeded" : `Error(Contract, #${blocked.errorCode ?? "?"})`,
        !blocked.ok && blocked.errorCode === PAUSED_ERROR_CODE,
        `D-12: pause stops money going IN. Cost of this simulation: ${fmt(blocked.cost)}.`,
      ),
    );

    // Printed even when everything passes, because the interesting half of this drill is not that
    // nine checks went green — it is WHICH refusal each function gave instead of Paused. A reader
    // who cannot see `NotExpired` next to `close_round` cannot tell a state gate from a pause gate.
    console.log("\n  what each of the nine answered while paused:");
    for (const call of i8Calls(ctx, ctx.round ?? 1)) {
      const out = await ctx.reader.simulate(ctx.vault, call.name, call.args);
      console.log(
        `    ${call.name.padEnd(24)}` +
          `${out.ok ? "succeeded" : `Error(Contract, #${out.errorCode ?? "?"})`}`.padEnd(26) +
          fmt(out.cost),
      );
      const refusedByPause = !out.ok && out.errorCode === PAUSED_ERROR_CODE;
      checks.push(
        mkCheck(
          `i8.${call.name}`,
          `${call.name} is not refused because the vault is paused`,
          `anything but Error(Contract, #${PAUSED_ERROR_CODE})`,
          out.ok ? "succeeded" : `Error(Contract, #${out.errorCode ?? "?"}) ${out.errorText ?? ""}`.trim(),
          !refusedByPause,
          out.ok
            ? `Succeeded outright. Cost: ${fmt(out.cost)}.`
            : "Refused for a STATE reason, which is I8 holding rather than breaking: the invariant " +
                "is conditional — these succeed under pause in every state where they would succeed " +
                "unpaused — so a claim with nothing to claim is refused either way. What I8 forbids " +
                `is this call answering Paused. Cost: ${fmt(out.cost)}.`,
        ),
      );
    }
    return checks;
  },
};

const stage3: Stage = {
  id: "3",
  title: "unpause, and the vault is where it started",
  async run(ctx) {
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "set_paused",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { paused: false },
      }),
      "set_paused:false",
    );
    const cfg = await ctx.reader.read<{ paused: boolean }>(ctx.vault, "config");
    const epoch = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    const deposit = await ctx.reader.simulate(ctx.vault, "deposit", [
      ctx.addresses.depositor,
      ctx.opts.deposit,
    ]);
    return [
      mkCheck("unpause.off", "config() reports the vault unpaused", false, cfg.paused, cfg.paused === false),
      mkCheck(
        "unpause.deposit_allowed",
        "the function pause was blocking is allowed again",
        "no longer Paused",
        deposit.ok ? "succeeded" : `Error(Contract, #${deposit.errorCode ?? "?"})`,
        deposit.ok || deposit.errorCode !== PAUSED_ERROR_CODE,
        "The drill is only reversible if this is true; a pause that could not be lifted would pass " +
          "every check above.",
      ),
      mkCheck(
        "unpause.round_intact",
        "the round the drill paused in is still the round it left",
        ctx.round,
        epoch.round,
        epoch.round === ctx.round,
        `Phase ${phaseName(epoch.phase)}. The round is left OPEN deliberately — this drill does not ` +
          "own it, and closing one costs a full epoch_duration nobody needed to spend.",
      ),
    ];
  },
};

export const STAGES: readonly Stage[] = [stage0, stage1, stage2, stage3];

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseOptions(argv, repoRoot());
  const ctx = await makeCtx(opts);
  if (ctx === null) {
    console.error(
      `\nusage: NETWORK=testnet scenario4.ts [--admin <id>] [--bidder-a <id>] [--deposit <stroops>]\n\n` +
        `  06-TEST-PLAN §7 scenario 4 — the pause drill. Pauses mid-Active, asks all nine of I8's\n` +
        `  functions by SIMULATION whether the pause refused them, and unpauses. Two transactions\n` +
        `  plus whatever it costs to reach an Active round, and it reuses one if it finds one.\n`,
    );
    return 2;
  }

  console.log(`\nAntares integration — 06-TEST-PLAN §7 scenario 4, the pause drill`);
  console.log(`  network   ${opts.network} via ${ctx.net.rpcUrl}`);
  console.log(`  vault     ${ctx.vault}`);

  const ok = await runStages(STAGES, ctx);
  return ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("scenario4.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
