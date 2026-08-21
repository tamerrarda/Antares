/**
 * `06-TEST-PLAN.md` §7 scenario 2 — the lapse path.
 *
 *     open → no bids → lapse via the next deposit's lazy finalize
 *
 * # Why this one is cheap, and scenario 1 is not
 *
 * A lapse does not wait for expiry. `vault.rs`'s `lazy_finalize` takes its branch on
 * `auction_end`, not on `epoch_duration`:
 *
 *     if state.phase != Phase::Auction || timestamp < state.auction_end { return Ok(false) }
 *     if state.notional_sold > 0 { state.phase = Phase::Active; return Ok(false) }
 *     // ... lapse
 *
 * So the whole scenario is bounded by `auction_duration` — 20 s at the fast-test profile against
 * scenario 1's 600 s. That is not a convenience: it is the reason an empty auction is
 * **permissionless by construction**. Nobody has to send a dedicated "close the empty auction"
 * transaction, because the next interaction of any kind absorbs it.
 *
 * # What is actually being tested, and why the obvious assertion would be wrong
 *
 * The tempting test is *"after `auction_end`, the chain still says `Auction`, and the deposit moves
 * it to `Idle`."* That is false, and reading `views.rs` rather than assuming is what caught it:
 * `epoch()` returns `effective_phase`, **the phase a mutating call would produce**. After
 * `auction_end` with no fills the view already answers `Idle` while `State.phase` on disk is still
 * `Auction`. A test written against the tempting version would have passed stage 2 for the wrong
 * reason and told us nothing.
 *
 * The honest handle is `outcome_pending`, which exists for exactly this gap: `true` means the phase
 * you are reading is derived and the write has not happened yet. So the falsifiable shape is
 *
 *   - after `auction_end`, before anyone calls: `phase == Idle` **and** `outcome_pending == true`,
 *     and **no `epoch_lapsed` event exists** — the derivation is a view's opinion, not a fact;
 *   - after the deposit: `outcome_pending == false` and **exactly one** `epoch_lapsed` was written.
 *
 * Both directions are needed. The first alone would pass on a vault that had already finalized;
 * the second alone would pass on one that finalizes eagerly, which is a different contract.
 *
 * # The decoder this exercises has never seen a real event
 *
 * `epoch_lapsed` got its decoder on 2026-08-21 and was the last §10 event that moved an amount
 * without one. Its absence had two consequences, and neither was theoretical: the reconstruction in
 * scenario 1 refuses the whole diff when a state-affecting event cannot be read, and because it
 * reads the vault's history from the deployment transaction forward, **one lapsed round anywhere in
 * that history refused it permanently**. The same absence had `isTerminal` naming three outcomes
 * where `finalize_round` emits four, so the keeper reported an empty auction as a round that "has
 * not closed" on a chain where `phase` was already `Idle`.
 *
 * The decoder was written against `events.rs` and tested against a fixture. Stage 4 is the first
 * time it meets bytes the contract actually emitted, which is the only version of that claim worth
 * making.
 *
 * **The keeper's half is not here.** `epochRecord` accepting a lapse is covered by
 * `keeper/test/record.test.ts`, against a fixture. Feeding it the real decoded event would be
 * stronger, and it is not done because `@antares/keeper` publishes no `exports` map — integration
 * lists it as a dependency and cannot import it. Adding one to serve a drill is a change to
 * packaging in service of a test, so it is recorded as a gap rather than taken.
 */

import { decodeEvent, eventName, type DecodedEvent } from "@antares/common/events";
import { mkCheck, type Check } from "@antares/common/checks";

import { diffAgainstEpoch, type ChainState } from "./diff.ts";
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
import { invoke } from "./read.ts";
import { reconstruct, type LocatedEvent } from "./reconstruct.ts";
import { MOCK_FEED_RECORDS, OPEN_PRICE, PRIME_HORIZON_SECONDS } from "./scenario1.ts";

/**
 * Seconds past `auction_end` to wait before reading.
 *
 * A Stellar ledger closes about every five seconds and `auction_end` is a timestamp, not a ledger
 * boundary, so reading at exactly `auction_end` can land in the ledger before the one that carries
 * it. Two ledgers of margin, for the same reason scenario 1 measures its auction window on the
 * ledger clock rather than on `Date.now()`.
 */
const PAST_AUCTION_MARGIN_SECONDS = 11;

/** The lapse's own event name, in one place so the three stages that look for it cannot disagree. */
const LAPSE = "epoch_lapsed";

/** Events written by one transaction, decoded, with the names that had no decoder kept. */
async function eventsOfTx(
  ctx: Ctx,
  txHash: string,
): Promise<{ decoded: LocatedEvent[]; skipped: string[]; names: string[] }> {
  const ledger = await ctx.reader.ledgerOf(txHash);
  const raw = await ctx.reader.rawEvents(ctx.vault, ledger);
  const mine = raw.filter((r) => r.txHash === txHash);
  const decoded: LocatedEvent[] = [];
  const skipped: string[] = [];
  const names: string[] = [];
  for (const r of mine) {
    const ev = { topics: r.topics, data: r.data, txHash: r.txHash, ledger: r.ledger };
    try {
      names.push(eventName(ev));
    } catch {
      names.push("<unnameable>");
    }
    try {
      decoded.push({ event: decodeEvent(ev), txHash: r.txHash, ledger: r.ledger });
    } catch {
      skipped.push(names[names.length - 1]!);
    }
  }
  return { decoded, skipped, names };
}

/** The hash of the last transaction recorded under `label`, or null when none was. */
function lastTx(ctx: Ctx, label: string): string | null {
  for (let i = ctx.txs.length - 1; i >= 0; i -= 1) {
    if (ctx.txs[i]!.label === label) return ctx.txs[i]!.hash;
  }
  return null;
}

// =================================================================================================

const stage0: Stage = {
  id: "0",
  title: "preconditions — Idle, past the idle gap, with capital to offer and a feed to open against",
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
          "A round is already live. This scenario opens one of its own and lets it die empty; it " +
            "will not race a round it does not own.",
        ),
      ];
    }

    // `open_epoch`'s condition 7 wants the feed to cover the whole round span, and a deploy's
    // priming is not a standing guarantee — scenario 1 re-primes for the same reason.
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

    // Capital, because a round with nothing to sell offers nothing and the lapse would be about
    // an empty offer rather than an empty auction — two different things with the same shape.
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
        "A lapse is an auction nobody bid in. An offer of zero would lapse too, for a reason this " +
          "scenario is not about.",
      ),
    ];
  },
};

const stage1: Stage = {
  id: "1",
  title: "open_epoch — a round with an offer and no bidders",
  async run(ctx) {
    record(
      ctx,
      invoke({ contractId: ctx.vault, method: "open_epoch", identity: ctx.opts.admin, net: ctx.net }),
      "open_epoch",
    );
    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    ctx.round = e.round;
    ctx.auctionEnd = Number(e.auction_end);

    console.log(
      `\n  round ${e.round} open, auction_end ${e.auction_end}, offering ${e.notional_offered}\n` +
        `  nobody will bid — the point of this scenario is what happens when the window closes empty\n`,
    );

    return [
      mkCheck(
        "open.phase",
        "the round is open and taking bids",
        "Auction",
        phaseName(e.phase),
        phaseName(e.phase) === "Auction",
      ),
      mkCheck(
        "open.offered",
        "the round put something up for sale",
        "> 0",
        String(e.notional_offered),
        e.notional_offered > 0n,
      ),
      mkCheck(
        "open.unsold",
        "nothing is sold yet, which is the state the lapse branch requires",
        0n,
        e.notional_sold,
        e.notional_sold === 0n,
        "`lazy_finalize` lapses only when `notional_sold == 0` at `auction_end`; a single fill " +
          "sends the round to Active instead, and this scenario would be testing that path.",
      ),
      mkCheck(
        "open.not_pending",
        "the round is written rather than derived — the view and the disk agree while it is live",
        false,
        e.outcome_pending,
        e.outcome_pending === false,
        "`outcome_pending` is stage 2's whole instrument, so it is read here first to show it is " +
          "not simply always true.",
      ),
    ];
  },
};

const stage2: Stage = {
  id: "2",
  title: "the window closes empty — the view moves, the chain does not",
  async run(ctx) {
    const target = ctx.auctionEnd! + PAST_AUCTION_MARGIN_SECONDS;
    console.log(`\n  waiting out the auction — ledger clock to ${target}`);
    await waitUntilLedgerTime(ctx.reader, target, { timeoutSeconds: 180 });

    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    const openTx = lastTx(ctx, "open_epoch")!;
    const since = await ctx.reader.ledgerOf(openTx);
    const raw = await ctx.reader.rawEvents(ctx.vault, since);
    const lapsesSoFar = raw.filter((r) => {
      try {
        return eventName({ topics: r.topics, data: r.data, txHash: r.txHash, ledger: r.ledger }) === LAPSE;
      } catch {
        return false;
      }
    });

    return [
      mkCheck(
        "lazy.view_says_idle",
        "the view already answers Idle, because it reports the phase a mutating call would produce",
        "Idle",
        phaseName(e.phase),
        phaseName(e.phase) === "Idle",
        "`views.rs` `effective_phase`. This is the assertion a careless version of this test would " +
          "have got backwards: the obvious guess is that the chain still says Auction here.",
      ),
      mkCheck(
        "lazy.pending",
        "and it says so is a derivation — the write has not happened",
        true,
        e.outcome_pending,
        e.outcome_pending === true,
        "The whole content of 'lazy'. Without this flag the phase above is indistinguishable from " +
          "a round that really did finalize, and the two are a transaction apart.",
      ),
      mkCheck(
        "lazy.nothing_written",
        "no epoch_lapsed exists yet, so the derivation is an opinion rather than a fact",
        0,
        lapsesSoFar.length,
        lapsesSoFar.length === 0,
        "Counted from the ledger the open landed in, so an earlier round's lapse in this vault's " +
          "history cannot be mistaken for this one's.",
      ),
    ];
  },
};

const stage3: Stage = {
  id: "3",
  title: "the next deposit absorbs it — §7's 'lapse via next deposit's lazy finalize', literally",
  async run(ctx) {
    const ppsBefore = (await ctx.reader.read<EpochView>(ctx.vault, "epoch")).last_pps;

    record(
      ctx,
      invoke({
        contractId: ctx.vault,
        method: "deposit",
        identity: ctx.opts.depositor,
        net: ctx.net,
        args: { from: ctx.addresses.depositor, amount: ctx.opts.deposit },
      }),
      "deposit:absorbs_lapse",
    );

    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    const tx = lastTx(ctx, "deposit:absorbs_lapse")!;
    const { names } = await eventsOfTx(ctx, tx);
    const lapses = names.filter((n) => n === LAPSE);

    console.log(`\n  the deposit's own events: ${names.join(", ")}\n`);

    return [
      mkCheck(
        "lapse.written_by_a_deposit",
        "exactly one epoch_lapsed was written, and a deposit wrote it",
        1,
        lapses.length,
        lapses.length === 1,
        "The permissionless property made literal: no dedicated transaction closed this round. " +
          `Transaction ${tx}.`,
      ),
      mkCheck(
        "lapse.not_pending",
        "the outcome is on disk now, not derived",
        false,
        e.outcome_pending,
        e.outcome_pending === false,
        "The pair with stage 2's `lazy.pending`. One transaction is the entire difference.",
      ),
      mkCheck(
        "lapse.phase",
        "the vault is Idle and can open again",
        "Idle",
        phaseName(e.phase),
        phaseName(e.phase) === "Idle",
      ),
      mkCheck(
        "lapse.pps_unchanged",
        "a lapse does not move price per share",
        String(ppsBefore),
        String(e.last_pps),
        e.last_pps === ppsBefore,
        "`vault.rs` publishes `pps: state.last_pps` on this branch. Nobody paid a premium and " +
          "nobody was paid a settlement, so depositors end the round exactly where they started — " +
          "which is the claim `docs/DEPOSITOR.md` makes about an auction that finds no buyer.",
      ),
    ];
  },
};

const stage4: Stage = {
  id: "4",
  title: "THE CLAIM — the decoder meets bytes the contract actually emitted",
  async run(ctx) {
    const tx = lastTx(ctx, "deposit:absorbs_lapse")!;
    const { decoded, skipped } = await eventsOfTx(ctx, tx);
    const lapse = decoded.find((l) => l.event.name === LAPSE);
    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");

    const checks: Check[] = [
      mkCheck(
        "decode.readable",
        "epoch_lapsed decodes off the wire — the first time this decoder has seen a real event",
        "decoded",
        lapse === undefined ? `skipped: ${skipped.join(", ") || "(not found)"}` : "decoded",
        lapse !== undefined,
        "Written 2026-08-21 against `events.rs` and tested against a fixture. A fixture agrees " +
          "with whatever wrote it; this does not.",
      ),
    ];
    if (lapse === undefined) return checks;

    const ev = lapse.event as Extract<DecodedEvent, { name: "epoch_lapsed" }>;
    checks.push(
      mkCheck(
        "decode.round",
        "it names the round that lapsed",
        ctx.round,
        ev.round,
        ev.round === ctx.round,
        "Carried as a TOPIC rather than in the data, so an indexer can filter for it without " +
          "decoding every event the vault emits.",
      ),
      mkCheck(
        "decode.pps",
        "the pps it carries is the one the chain reports",
        String(e.last_pps),
        String(ev.pps),
        ev.pps === e.last_pps,
      ),
      mkCheck(
        "decode.wclaims_present",
        "wclaims survived the decode, which is the field most easily left out",
        ">= 0",
        String(ev.wclaims),
        ev.wclaims >= 0n,
        "`events.rs` says why it is on all four finalization events: nothing on-chain asserts it, " +
          "so it is the one an implementation drops without failing a test. An indexer that " +
          "cannot read it is short by the whole withdrawal-queue credit.",
      ),
      mkCheck(
        "decode.notional_offered",
        "and the notional the round had offered, which is the only amount a lapse reports",
        "> 0",
        String(ev.notionalOffered),
        ev.notionalOffered > 0n,
        "There is no `notional_sold` on this event because there is nothing to report: the branch " +
          "is only reached when it is zero.",
      ),
    );
    return checks;
  },
};

const stage5: Stage = {
  id: "5",
  title: "the regression — a lapsed round in history no longer refuses the reconstruction",
  async run(ctx) {
    // Deliberately from the DEPLOYMENT transaction, not from this run's: the bug was that the
    // window is cumulative, so one lapse anywhere in the vault's life refused every future diff.
    // Reading from this run's start would test a narrower thing and pass either way.
    const start = await ctx.reader.ledgerOf(ctx.createTx);
    const raw = await ctx.reader.rawEvents(ctx.vault, start);

    const events: LocatedEvent[] = [];
    const skipped = new Set<string>();
    let lapsesInHistory = 0;
    for (const r of raw) {
      const ev = { topics: r.topics, data: r.data, txHash: r.txHash, ledger: r.ledger };
      let name: string;
      try {
        name = eventName(ev);
      } catch {
        skipped.add("<unnameable>");
        continue;
      }
      if (name === LAPSE) lapsesInHistory += 1;
      try {
        events.push({ event: decodeEvent(ev), txHash: r.txHash, ledger: r.ledger });
      } catch {
        skipped.add(name);
      }
    }

    const state = reconstruct(events, [...skipped]);
    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    const totalAssets = await ctx.reader.read<bigint>(ctx.vault, "total_assets");
    const clock = await ledgerNow(ctx.reader);
    const chain: ChainState = {
      round: e.round,
      phase: phaseName(e.phase) as ChainState["phase"],
      notionalOffered: e.notional_offered,
      notionalSold: e.notional_sold,
      premiumCollected: e.premium_collected,
      strike: e.strike,
      openTwap: e.open_twap,
      openedAt: Number(e.opened_at),
      auctionEnd: Number(e.auction_end),
      expiry: Number(e.expiry),
      sharesOutstanding: e.shares_outstanding,
      lastPps: e.last_pps,
      totalAssets,
      ledgerTime: clock.closeTime,
    };

    console.log(
      `\n  reconstructed from ledger ${start}: ${events.length} events decoded, ` +
        `${lapsesInHistory} of them lapses\n`,
    );

    const checks = diffAgainstEpoch(state, chain, [...skipped]);
    return [
      mkCheck(
        "history.has_a_lapse",
        "the history this diff reads contains at least one lapsed round",
        ">= 1",
        String(lapsesInHistory),
        lapsesInHistory >= 1,
        "Otherwise the assertions below prove nothing about the bug: a diff that never meets an " +
          "epoch_lapsed passed before the decoder existed too.",
      ),
      ...checks,
    ];
  },
};

export const STAGES: readonly Stage[] = [stage0, stage1, stage2, stage3, stage4, stage5];

// =================================================================================================
// Runner
// =================================================================================================

export async function main(argv: readonly string[]): Promise<number> {
  const opts = parseOptions(argv, repoRoot());
  const ctx = await makeCtx(opts);
  if (ctx === null) {
    console.error(
      `\nusage: NETWORK=testnet scenario2.ts [--admin <id>] [--depositor <id>] [--deposit <stroops>]\n\n` +
        `  06-TEST-PLAN §7 scenario 2 — the lapse path. Opens a round, lets the auction close with\n` +
        `  no bids, and lets the next deposit absorb it. Bounded by auction_duration rather than\n` +
        `  epoch_duration, so it costs a minute rather than eleven.\n`,
    );
    return 2;
  }

  console.log(`\nAntares integration — 06-TEST-PLAN §7 scenario 2, the lapse path`);
  console.log(`  network   ${opts.network} via ${ctx.net.rpcUrl}`);
  console.log(`  vault     ${ctx.vault}`);

  // `runStages` prints the transaction list itself — the evidence trail is the harness's job, not
  // each scenario's, so nothing is printed here.
  return (await runStages(STAGES, ctx)) ? 0 : 1;
}

if (process.argv[1]?.endsWith("scenario2.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
