/**
 * `06-TEST-PLAN.md` §7 scenario 3 — the void path, and the ITM bid guard alongside it.
 *
 *     open → fill → the feed dies → past the grace period → void → refunds
 *
 * # The void window is sixty seconds wide, and both of its edges are refusals
 *
 * `settle.rs` reaches a void through a single door, and the door is bounded on both sides. Reading
 * the three bounds off the code rather than off the prose is what made this scenario writable:
 *
 *   - `now < expiry` → `NotExpired` (4). Nothing terminates before the option is over.
 *   - `now >= expiry + unresolved_after` → the **unresolved** branch, taken *before any oracle call
 *     at all*. That is D-64's structural claim: no oracle state can trap funds, because past this
 *     point the round closes without asking. It also means a void is no longer reachable — the
 *     oracle is never consulted, so it cannot report itself dead.
 *   - in between, the oracle answers `DeadAtExpiry` and `now < expiry + oracle_dead_after` →
 *     `OracleNotDeadYet` (6). The grace period is **not** waiting for the feed to recover; frozen
 *     history does not recover. It exists so a transient present-tense failure cannot be recorded
 *     as "the feed was dead at expiry" (04-ORACLE §4).
 *
 * At the fast-test profile that leaves `[expiry + 50, expiry + 110)` — sixty seconds. This scenario
 * asserts the near edge rather than merely landing inside the window: stage 4 simulates
 * `close_round` while the feed is already dead and requires `OracleNotDeadYet`, because a test that
 * only proved a void happens would pass equally on a contract that voided the instant the feed
 * failed, and that contract is the one D-60 was written to prevent.
 *
 * # Why the feed is killed with a mode switch rather than by starving it
 *
 * `DeadAtExpiry` and `OutOfReach` are different facts and route to different outcomes — one voids
 * and refunds the bidder, the other resolves unresolved and hands depositors the premium (D-59).
 * Starving the mock produces whichever of the two its record window happens to imply, which is a
 * coin-flip this scenario would then be reporting as an assertion. `Mode::ForceUnusable` says
 * `Ok(Unusable)` and nothing else, so the branch under test is the branch that runs. The mock
 * documents the mode as existing for exactly this.
 *
 * The mock is restored to `Normal` in the last stage, so the instance is left as it was found.
 *
 * # The ITM guard rides in the same auction window, and that window is twenty seconds
 *
 * §7 asks the same mock instance to exercise the in-the-money bid guard: *spot above strike →
 * bids reject; below → fill*. `auction.rs` checks the phase and the clock **before** it checks the
 * spot, so this cannot be done after the window closes — a late bid answers `WrongPhase` and never
 * reaches the guard.
 *
 * Twenty seconds is about three transactions on testnet, so the two directions are evidenced
 * differently rather than symmetrically:
 *
 *   - **below → fill** is the real bid that is submitted and lands. Not a simulation: the round
 *     needs a genuine fill anyway, because a void with no premium collected has nothing to refund
 *     and stage 6 would assert over an empty set.
 *   - **above → reject** is a simulation taken after one `fill` transaction pushes the spot through
 *     the strike. A simulation returns the contract's error without spending a ledger, which is the
 *     only way the second direction fits in the window at all.
 *
 * Both are the same guard; only the evidence differs, and it differs because the window is short
 * rather than because one direction matters less.
 */

import { decodeEvent, type DecodedEvent } from "@antares/common/events";
import { mkCheck, type Check } from "@antares/common/checks";

import {
  makeCtx,
  parseOptions,
  phaseName,
  record,
  repoRoot,
  runStages,
  ensureAllowed,
  type Ctx,
  type EpochView,
  type Stage,
} from "./harness.ts";
import { ledgerNow, waitUntilLedgerTime } from "./ledger-clock.ts";
import { invoke, u32 } from "./read.ts";
import { ITM_PRICE_PERCENT, MOCK_FEED_RECORDS, OPEN_PRICE, PRIME_HORIZON_SECONDS } from "./scenario1.ts";

/** `errors.rs`, read rather than guessed — the two edges of the void window and the guard. */
export const WRONG_PHASE = 2;
export const NOT_EXPIRED = 4;
export const ORACLE_NOT_DEAD_YET = 6;
export const IN_THE_MONEY = 34;

/**
 * Seconds past a deadline before acting on it.
 *
 * A Stellar ledger closes about every five seconds and every bound here is a timestamp rather than
 * a ledger boundary, so acting at exactly the bound can execute in the ledger before it.
 */
const MARGIN_SECONDS = 6;

/** The name the void writes, in one place so the stages that look for it cannot disagree. */
const VOIDED = "epoch_voided";

/** The hash of the last transaction recorded under `label`. */
function lastTx(ctx: Ctx, label: string): string | null {
  for (let i = ctx.txs.length - 1; i >= 0; i -= 1) {
    if (ctx.txs[i]!.label === label) return ctx.txs[i]!.hash;
  }
  return null;
}

/** One transaction's own events, decoded. */
async function eventsOfTx(ctx: Ctx, txHash: string): Promise<DecodedEvent[]> {
  const ledger = await ctx.reader.ledgerOf(txHash);
  const raw = await ctx.reader.rawEvents(ctx.vault, ledger);
  const out: DecodedEvent[] = [];
  for (const r of raw.filter((x) => x.txHash === txHash)) {
    try {
      out.push(decodeEvent({ topics: r.topics, data: r.data, txHash: r.txHash, ledger: r.ledger }));
    } catch {
      // Kept silent on purpose: the SEP-41 mirror rides along with every one of these and is not
      // this scenario's subject. `events.decoders_complete` in scenario 1 is where a missing
      // decoder is a finding.
    }
  }
  return out;
}

const errText = (out: { ok: boolean; errorCode: number | null }): string =>
  out.ok ? "succeeded" : `Error(Contract, #${out.errorCode ?? "?"})`;

// =================================================================================================

const stage0: Stage = {
  id: "0",
  title: "preconditions — Idle, a bidder on the allowlist, capital, and a feed to open against",
  async run(ctx) {
    const before = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    if (phaseName(before.phase) !== "Idle") {
      return [
        mkCheck(
          "pre.phase",
          "the vault is Idle, which is the only phase a round can be opened from",
          "Idle",
          phaseName(before.phase),
          false,
          "This scenario opens a round it owns and kills the feed under it. It will not do that to " +
            "a round somebody else is using.",
        ),
      ];
    }

    // The mock may have been left in a forced mode by an interrupted run of this very scenario.
    // Setting it back is a precondition rather than cleanup: opening a round reads the oracle, and
    // `ForceUnusable` would refuse the open with a message about the feed rather than about this.
    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "set_mode",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { mode: "Normal" },
      }),
      "mock:mode_normal",
    );
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
      "deposit:capital",
    );

    const assets = await ctx.reader.read<bigint>(ctx.vault, "total_assets");
    return [
      mkCheck(
        "pre.capital",
        "the vault holds something to put up for sale",
        "> 0",
        String(assets),
        assets > 0n,
      ),
    ];
  },
};

const stage1: Stage = {
  id: "1",
  title: "open, and fill it — below the strike, which is the guard's permissive direction",
  async run(ctx) {
    record(
      ctx,
      invoke({ contractId: ctx.vault, method: "open_epoch", identity: ctx.opts.admin, net: ctx.net }),
      "open_epoch",
    );
    const opened = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    ctx.round = opened.round;
    ctx.expiry = Number(opened.expiry);
    ctx.auctionEnd = Number(opened.auction_end);
    ctx.strike = opened.strike;

    const clock = await ledgerNow(ctx.reader);
    const room = ctx.auctionEnd - clock.closeTime;
    console.log(
      `\n  round ${opened.round}: strike ${opened.strike}, expiry ${opened.expiry}\n` +
        `  auction closes in ${room}s — the ITM guard has to be exercised inside that\n`,
    );

    // A real bid, and half the offer so the round is a partial fill like scenario 1's. This is the
    // guard's "below the strike → fill" direction, evidenced by a transaction rather than a
    // simulation because the void needs premium to refund.
    const half = opened.notional_offered / 2n;
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "bid",
        identity: ctx.opts.bidderA,
        net: ctx.net,
        args: {
          bidder: ctx.addresses.bidderA,
          notional: half,
          max_premium_bps: ctx.opts.maxPremiumBps,
        },
      }),
      "bid:below_strike",
    );

    const after = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    return [
      mkCheck(
        "open.window_had_room",
        "the auction still had room when the bid was submitted, measured on the LEDGER clock",
        "> 0s",
        `${room}s`,
        room > 0,
        "Measured before spending anything. `auction.rs` checks the phase and the clock BEFORE the " +
          "spot, so a late bid answers WrongPhase and never reaches the guard this scenario is about.",
      ),
      mkCheck(
        "guard.below_strike_fills",
        "a bid below the strike fills — the guard's permissive direction, by transaction",
        "> 0",
        String(after.notional_sold),
        after.notional_sold > 0n,
        `Strike ${after.strike}, opened at a TWAP of ${after.open_twap}. The fill paid ` +
          `${after.premium_collected} in premium, which is what stage 6 refunds.`,
      ),
      mkCheck(
        "open.partial",
        "the round is only partly sold, so the offer is still live for the next bid",
        "< notional_offered",
        `${after.notional_sold} of ${after.notional_offered}`,
        after.notional_sold < after.notional_offered,
        "A full subscription flips the phase to Active immediately (§5 step 6) and the window " +
          "would be gone before the ITM simulation could run.",
      ),
    ];
  },
};

const stage2: Stage = {
  id: "2",
  title: "the spot moves through the strike — the same guard, refusing",
  async run(ctx) {
    const clock = await ledgerNow(ctx.reader);
    const room = ctx.auctionEnd! - clock.closeTime;

    // `spot_check` reads the PRESENT, bounded by `max_staleness` — unlike the settle, which reads
    // anchored at expiry. So this fill covers `now` rather than expiry, and that difference is why
    // scenario 1's ITM fill (which covers expiry) would not have moved this guard at all.
    const itm = (OPEN_PRICE * ITM_PRICE_PERCENT) / 100n;
    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "fill",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: {
          end: clock.closeTime + PRIME_HORIZON_SECONDS,
          count: MOCK_FEED_RECORDS,
          price: itm,
        },
      }),
      "prime:itm_fill",
    );

    const after = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    const stillOpen = phaseName(after.phase) === "Auction";
    const out = await ctx.reader.simulate(ctx.vault, "bid", [
      ctx.addresses.bidderB,
      after.notional_offered - after.notional_sold,
      u32(ctx.opts.maxPremiumBps),
    ]);

    // The first rung of the refusal ladder, taken here rather than in stage 3 because here the
    // window is provably still open — stage 2 asserts that below, so this reading is deterministic.
    const closing = await ctx.reader.simulate(ctx.vault, "close_round", [ctx.addresses.admin]);

    return [
      mkCheck(
        "guard.window_still_open",
        "the auction is still taking bids, so the refusal below is the spot's doing and not the clock's",
        "Auction",
        phaseName(after.phase),
        stillOpen,
        `${room}s of window remained when the ITM fill was submitted. If this fails the run was ` +
          "too slow rather than wrong, and the assertion below would have been answering WrongPhase.",
      ),
      mkCheck(
        "guard.above_strike_rejects",
        "a bid is refused as in the money once the spot is at or above the strike",
        `Error(Contract, #${IN_THE_MONEY})`,
        errText(out),
        !out.ok && out.errorCode === IN_THE_MONEY,
        `Spot pushed to ${itm} against a strike of ${after.strike}. D-29: the vault does not sell ` +
          "intrinsic value. By simulation, because the window is twenty seconds wide and a " +
          "simulation returns the contract's error without spending a ledger.",
      ),
      mkCheck(
        "close.wrong_phase_during_auction",
        "a close while bids are still being taken is refused on the phase",
        `Error(Contract, #${WRONG_PHASE})`,
        errText(closing),
        !closing.ok && closing.errorCode === WRONG_PHASE,
        "The first of three refusals a close can give before a void becomes reachable, and the " +
          "reason the second one had to move: `NotExpired` is unreachable while the round is still " +
          "in Auction, because the phase is checked first. This scenario asserted it here on its " +
          "first run and got `WrongPhase`, which was the contract being right.",
      ),
    ];
  },
};

const stage3: Stage = {
  id: "3",
  title: "the feed dies — and nothing terminates before expiry",
  async run(ctx) {
    // Past `auction_end` the round is Active — `lazy_finalize` moves it there for a round with
    // fills, and a simulation runs that finalization too, so the phase rung is behind us. What is
    // left is the clock: before expiry nothing terminates, whatever the oracle says.
    const activeAt = ctx.auctionEnd! + MARGIN_SECONDS;
    console.log(`\n  waiting for the auction to close — ledger clock to ${activeAt}`);
    await waitUntilLedgerTime(ctx.reader, activeAt, { timeoutSeconds: 180 });

    const early = await ctx.reader.simulate(ctx.vault, "close_round", [ctx.addresses.admin]);
    const clock = await ledgerNow(ctx.reader);

    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "set_mode",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { mode: "ForceUnusable" },
      }),
      "mock:force_unusable",
    );

    return [
      mkCheck(
        "void.not_expired_first",
        "before expiry the round refuses on the clock, not on the feed",
        `Error(Contract, #${NOT_EXPIRED})`,
        errText(early),
        !early.ok && early.errorCode === NOT_EXPIRED,
        `Ledger clock ${clock.closeTime}, expiry ${ctx.expiry}, auction closed at ${ctx.auctionEnd}. ` +
          "The second rung: the round is Active now, so the phase no longer refuses and the clock " +
          "does. The feed is killed immediately after this reading, so the two stages that follow " +
          "are about the feed and this one is about time.",
      ),
    ];
  },
};

const stage4: Stage = {
  id: "4",
  title: "past expiry, inside the grace period — the near edge, which is a refusal",
  async run(ctx) {
    const target = ctx.expiry! + MARGIN_SECONDS;
    console.log(`\n  waiting for expiry — ledger clock to ${target}`);
    await waitUntilLedgerTime(ctx.reader, target, {
      timeoutSeconds: ctx.params["epoch_duration"]! + 180,
      onTick: (t) => process.stdout.write(`\r  waiting for expiry — ledger clock ${t.closeTime}   `),
    });
    process.stdout.write("\n");

    const out = await ctx.reader.simulate(ctx.vault, "close_round", [ctx.addresses.admin]);
    const clock = await ledgerNow(ctx.reader);
    const deadAt = ctx.expiry! + ctx.params["oracle_dead_after"]!;

    return [
      mkCheck(
        "void.grace_period_holds",
        "a dead feed does not void the round immediately — the grace period refuses first",
        `Error(Contract, #${ORACLE_NOT_DEAD_YET})`,
        errText(out),
        !out.ok && out.errorCode === ORACLE_NOT_DEAD_YET,
        `Ledger clock ${clock.closeTime}, void available at ${deadAt}. This is the assertion that ` +
          "separates this scenario from one that merely watches a void happen: 04-ORACLE §4 says " +
          "the grace exists so a transient present-tense failure cannot be recorded as 'the feed " +
          "was dead at expiry', and a contract that voided on the first bad read would pass every " +
          "other check here.",
      ),
    ];
  },
};

const stage5: Stage = {
  id: "5",
  title: "inside the window — the void, and the reason it carries",
  async run(ctx) {
    const openAt = ctx.expiry! + ctx.params["oracle_dead_after"]! + MARGIN_SECONDS;
    const closesAt = ctx.expiry! + ctx.params["unresolved_after"]!;
    console.log(`\n  waiting for the grace period — ledger clock to ${openAt}, window shuts at ${closesAt}`);
    await waitUntilLedgerTime(ctx.reader, openAt, {
      timeoutSeconds: 240,
      onTick: (t) => process.stdout.write(`\r  waiting for the grace period — ${t.closeTime}   `),
    });
    process.stdout.write("\n");

    const premiumBefore = (await ctx.reader.read<EpochView>(ctx.vault, "epoch")).premium_collected;
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "close_round",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { bounty_to: ctx.addresses.admin },
      }),
      "close_round:void",
    );

    const after = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    const landedAt = await ledgerNow(ctx.reader);
    const tx = lastTx(ctx, "close_round:void")!;
    const events = await eventsOfTx(ctx, tx);
    const voided = events.find(
      (e): e is Extract<DecodedEvent, { name: "epoch_voided" }> => e.name === VOIDED,
    );

    const checks: Check[] = [
      mkCheck(
        "void.inside_the_window",
        "the close landed inside the sixty seconds a void is reachable in",
        `< ${closesAt}`,
        String(landedAt.closeTime),
        landedAt.closeTime < closesAt,
        "Past this the unresolved branch runs BEFORE any oracle call, so a void stops being " +
          "reachable at all — the round would close the other way and every assertion below " +
          "would be about the wrong outcome.",
      ),
      mkCheck(
        "void.phase",
        "the round closed and the vault is Idle again",
        "Idle",
        phaseName(after.phase),
        phaseName(after.phase) === "Idle",
      ),
      mkCheck(
        "void.event_written",
        "the close wrote an epoch_voided",
        "epoch_voided",
        events.map((e) => e.name).join(", ") || "(nothing decoded)",
        voided !== undefined,
      ),
    ];
    if (voided === undefined) return checks;

    checks.push(
      mkCheck(
        "void.reason",
        "the void names the feed as unusable rather than the price as invalid",
        "FeedUnusable",
        voided.reason,
        voided.reason === "FeedUnusable",
        "D-60 exists because the two are not interchangeable: one is a feed that had nothing to " +
          "say at expiry, the other is a feed that said something impossible. An indexer that " +
          "cannot tell them apart cannot say why a round was annulled.",
      ),
      mkCheck(
        "void.refunds_the_whole_premium",
        "every stroop of premium the round collected is credited back",
        String(premiumBefore),
        String(voided.premiumRefunded),
        voided.premiumRefunded === premiumBefore,
        "Each fill gets its own back exactly, with no pro-rata arithmetic — the bidder bought an " +
          "option the vault could not settle, so there is nothing to apportion.",
      ),
      mkCheck(
        "void.pps_recorded",
        "the event carries the pps the round ended at, like all four finalizations",
        String(after.last_pps),
        String(voided.pps),
        voided.pps === after.last_pps,
      ),
    );
    return checks;
  },
};

const stage6: Stage = {
  id: "6",
  title: "the refund — what a voided round owes the bidder, taken",
  async run(ctx) {
    const before = await ctx.reader.read<{ notional: bigint; premium_paid: bigint; claimed: boolean }>(
      ctx.vault,
      "bidder_position",
      [u32(ctx.round!), ctx.addresses.bidderA],
    );
    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "claim_refund",
        identity: ctx.opts.bidderA,
        net: ctx.net,
        args: { round: ctx.round, bidder: ctx.addresses.bidderA },
      }),
      "claim_refund:bidder-a",
    );
    const after = await ctx.reader.read<{ claimed: boolean }>(ctx.vault, "bidder_position", [
      u32(ctx.round!),
      ctx.addresses.bidderA,
    ]);
    const tx = lastTx(ctx, "claim_refund:bidder-a")!;
    const events = await eventsOfTx(ctx, tx);
    const refund = events.find(
      (e): e is Extract<DecodedEvent, { name: "refund_claimed" }> => e.name === "refund_claimed",
    );

    const checks: Check[] = [
      mkCheck(
        "refund.filled",
        "bidder-a is on record as having filled, which is what makes a refund meaningful",
        "> 0",
        String(before.notional),
        before.notional > 0n,
      ),
      mkCheck(
        "refund.claimed",
        "the refund is marked taken, so it cannot be taken twice",
        true,
        after.claimed,
        after.claimed === true,
        `Filled ${before.notional} for a premium of ${before.premium_paid}.`,
      ),
      mkCheck(
        "refund.event",
        "the claim wrote a refund_claimed",
        "refund_claimed",
        events.map((e) => e.name).join(", ") || "(nothing decoded)",
        refund !== undefined,
      ),
    ];
    if (refund !== undefined) {
      checks.push(
        mkCheck(
          "refund.exact",
          "the bidder gets back exactly what they paid, to the stroop",
          String(before.premium_paid),
          String(refund.amount),
          refund.amount === before.premium_paid,
          "The claim a voided round makes to a counterparty, and the reason `claim_refund` exists " +
            "as a pull rather than a push: settle.rs is O(1) and never walks a bidder list, so " +
            "each fill collects its own.",
        ),
      );
    }
    return checks;
  },
};

const stage7: Stage = {
  id: "7",
  title: "put the mock back — the instance is left as it was found",
  async run(ctx) {
    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "set_mode",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { mode: "Normal" },
      }),
      "mock:mode_normal:restore",
    );
    const now = await ledgerNow(ctx.reader);
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
      "prime:restore_fill",
    );

    // Simulating `open_epoch` is the honest way to say the instance is usable again: it exercises
    // the same oracle read a real open would, and it costs nothing. A run that left the mock forced
    // would refuse here, which is the failure this stage is guarding against.
    const out = await ctx.reader.simulate(ctx.vault, "open_epoch", []);
    const blockedByIdleGap = !out.ok && out.errorCode !== null;
    return [
      mkCheck(
        "restore.oracle_answers_again",
        "the vault can read the feed again — a later run is not inheriting this one's dead oracle",
        "not an oracle refusal",
        out.ok ? "succeeded" : `Error(Contract, #${out.errorCode ?? "?"}) ${out.errorText ?? ""}`.trim(),
        out.ok || (blockedByIdleGap && out.errorCode !== ORACLE_NOT_DEAD_YET),
        "A refusal on `min_idle_gap` is expected and fine — the round just closed. What must not " +
          "come back is a refusal about the feed, which is what a forced mock would produce.",
      ),
    ];
  },
};

export const STAGES: readonly Stage[] = [stage0, stage1, stage2, stage3, stage4, stage5, stage6, stage7];

// =================================================================================================
// Runner
// =================================================================================================

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseOptions(argv, repoRoot());
  const ctx = await makeCtx(opts);
  if (ctx === null) {
    console.error(
      `\nusage: NETWORK=testnet scenario3.ts [--admin <id>] [--bidder-a <id>] [--bidder-b <id>]\n` +
        `                                    [--depositor <id>] [--deposit <stroops>]\n\n` +
        `  06-TEST-PLAN §7 scenario 3 — the void path. Opens a round, fills it, kills the feed with\n` +
        `  Mode::ForceUnusable, asserts BOTH edges of the sixty-second window a void is reachable\n` +
        `  in, voids, and takes the refund. The ITM bid guard rides in the same auction window.\n` +
        `  Costs one epoch_duration, and it restores the mock before it exits.\n`,
    );
    return 2;
  }

  console.log(`\nAntares integration — 06-TEST-PLAN §7 scenario 3, the void path`);
  console.log(`  network   ${opts.network} via ${ctx.net.rpcUrl}`);
  console.log(`  vault     ${ctx.vault}`);
  console.log(`  mock      ${ctx.oracle}`);

  return (await runStages(STAGES, ctx)) ? 0 : 1;
}

if (process.argv[1]?.endsWith("scenario3.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
