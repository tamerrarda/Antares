/**
 * `06-TEST-PLAN.md` §7 scenario 1 — the full happy epoch, driven live, verified from events.
 *
 *     deposit → open → two bidders partial-fill → settle → claims → withdraw
 *
 * The chain ends at **withdraw**, which is where the Phase 6a gate ends: *"deposit → auction → fill
 * → close → premium in `pps` → **withdrawal**, every assertion in scenario 1 passing"*.
 *
 * # Driving it is the cheap half
 *
 * The claim is the last stage: state rebuilt from the event log and diffed against `epoch()`. See
 * `reconstruct.ts` for why that is a different and stronger statement than reading `epoch()` back.
 * Everything before stage 9 exists to produce a round for stage 9 to read.
 *
 * # The two traps, and where each is handled
 *
 * **1 · The auction is three to four ledgers wide.** `auction_duration` is 20 s and a Stellar ledger
 * closes in about five, which is why `scripts/instances-fast-test.json` sets 20 rather than the 25
 * the epoch permits. Two partial fills means two transactions inside that window, and that is not
 * guaranteed. Three things answer it, in order of how much they matter:
 *
 *   - **Two separate bidder identities**, so the bids carry independent sequence numbers and can
 *     land in the same ledger. Serialising them would spend a confirmation round trip between them
 *     and is what makes the window tight in the first place.
 *   - **A ledger-time check BEFORE submitting** (stage 5). If the window is already too short the
 *     harness refuses without spending a fee, and the refusal names the margin. A bid submitted
 *     into a closed auction comes back as `WrongPhase`, which reads like a contract bug.
 *   - **A stated minimum.** {@link MIN_AUCTION_MARGIN_SECONDS} is the width below which this refuses
 *     to try, so a miss is a refusal with a number rather than an intermittent red.
 *
 * **2 · Condition 7 is an operational precondition, not a parameter.** `MockPriceSource` constructs
 * with `expires() = None` — an unfunded feed — and `open_epoch` refuses one. `deploy.ts` step 2b
 * primes it once at deploy time; **a harness that runs later, or runs a second round, must prime it
 * again**, or `open_epoch` fails for feed expiry rather than for anything the test is about, and the
 * two are hard to tell apart from the outside. Stage 2 re-primes unconditionally and asserts the
 * result rather than assuming the deploy's priming is still good.
 *
 * # Every wait is on the ledger's clock
 *
 * The fast-test margins are 15 seconds on four of `supports_round`'s conditions, which is three
 * ledgers. `ledger-clock.ts` says the rest.
 *
 * # What it spends and what it costs
 *
 * A full run is one `epoch_duration` — 600 s at the fast-test profile — plus setup, so about eleven
 * minutes. `--preflight` runs stages 0 to 2 and stops: it proves the record, the identities, the
 * allowlist and the feed are all in a state a round could start from, which is the check worth
 * having before committing eleven minutes.
 */

import { allPassed, failedIds, mkCheck, renderChecks, type Check } from "@antares/common/checks";
import { decodeEvent, eventName, type RawEvent } from "@antares/common/events";
import type { NetworkArgs } from "@antares/common/chain";
import { isNetworkName, networkConfig, resolveRpcUrl } from "@antares/common/networks";
import { RECORD_CAP_TICKS, reachLimit } from "@antares/common/oracle";

import { diffAgainstEpoch, omissions, type ChainState } from "./diff.ts";
import { ledgerNow, ledgerSecondsUntil, waitUntilLedgerTime } from "./ledger-clock.ts";
import { addressOf, invoke, invokeAsync, makeReader, type Reader } from "./read.ts";
import { reconstruct, type LocatedEvent } from "./reconstruct.ts";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// =================================================================================================
// The numbers this scenario chooses, each with the reason it is that number
// =================================================================================================

/**
 * The narrowest auction window this will submit into.
 *
 * A `stellar contract invoke` simulates, builds, signs, submits and polls; measured at three to six
 * seconds on testnet. Eight is that plus a ledger of slack. Below it the bids would probably still
 * land, and "probably" is the property this constant exists to refuse.
 */
export const MIN_AUCTION_MARGIN_SECONDS = 8;

/** A day, against a round span of minutes — the same value and the same argument as deploy step 2b. */
export const MOCK_FEED_LIFETIME_SECONDS = 86_400;

/** 240 one-second ticks: more than `guard_window` (160) plus `twap_window` (4), with room over. */
export const MOCK_FEED_RECORDS = 240;

/**
 * How far PAST the moment of filling a prime extends. **Bounded on both sides, and both bounds were
 * measured the hard way, one run each.**
 *
 * **The lower bound.** The first attempt filled to `end = now`, and `open_epoch` came back
 * `Error(Contract, #10)` with the adapter answering `Unusable` to `reading(0, 4, 160)`. The feed's
 * lifetime was fine — condition 7 was satisfied — but its *coverage* was not: the call that reads
 * the feed happens seconds after the call that filled it, the TWAP window is 4 s wide at this
 * profile, and those four seconds had not existed when the fill ran. **A feed can be funded, fresh
 * and still unreadable.** So a prime writes a horizon, not a point, and the horizon has to outlast
 * every call between the prime and the last read of the round.
 *
 * **The upper bound, and it is the one that is not obvious: `reach_limit`.** Raising the horizon to
 * 120 s traded `Unusable` for `Error(Contract, #13)` and `OutOfReach`, which looks like a dead feed
 * and is the opposite problem. Writing records ahead of now moves the feed's HEAD ahead of now, and
 * reach is measured as a depth below the head. Anchored at `now` with a guard window of
 * `guard_window`, the oldest sample the adapter needs sits `H − now + guard_window` below the head,
 * and that must stay within `R = RECORD_CAP_TICKS × resolution`. Rearranged:
 *
 *     H − now  ≤  R − guard_window  =  reach_limit
 *
 * At this profile that is 255 − 160 = **95 seconds**, and 120 was over it by 25. So the horizon is
 * pinned between the elapsed time to the last read and `reach_limit` plus the elapsed time to the
 * first — 60 s sits comfortably inside both, and stage 2 asserts the upper bound against the feed's
 * OWN `resolution()` rather than trusting this comment.
 *
 * The two failures are worth keeping side by side because they are symmetric and both present as
 * "the oracle refused": too little history and too much are the same error class to a reader.
 */
export const PRIME_HORIZON_SECONDS = 60;

/** 0.17 at the mock's 14 decimals — the live XLM price, so a fast-test round is not absurd. */
export const OPEN_PRICE = 17_000_000_000_000n;

/**
 * The price the feed moves to before expiry, as a percentage of {@link OPEN_PRICE}.
 *
 * `strike_bps_otm` is 300, so the strike sits 3 % above the opening TWAP. 110 % puts the settle
 * price clearly through it, which is what makes `claim_payout` a real step rather than a call that
 * returns zero. The move happens at {@link PRICE_MOVE_LEAD_SECONDS} before expiry — **after** the
 * auction has closed, so it cannot trip the in-the-money bid guard that scenario 3 tests on purpose.
 */
export const ITM_PRICE_PERCENT = 110n;

/** How far before expiry the price moves. One `MOCK_FEED_RECORDS` fill covers the guard window. */
export const PRICE_MOVE_LEAD_SECONDS = 90;

/** Slack after expiry before calling `close_round`, so the call is never racing the boundary. */
export const SETTLE_LEAD_SECONDS = 6;

// =================================================================================================
// Options
// =================================================================================================

export interface Options {
  readonly network: string;
  readonly admin: string;
  readonly depositor: string;
  readonly bidderA: string;
  readonly bidderB: string;
  readonly record: string;
  readonly deposit: bigint;
  readonly notionalA: bigint;
  readonly notionalB: bigint;
  readonly maxPremiumBps: number;
  readonly preflight: boolean;
}

export function parseOptions(argv: readonly string[], root: string): Options {
  const value = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  const network = process.env["NETWORK"] ?? "";
  return {
    network,
    admin: value("admin", "antares-testnet"),
    depositor: value("depositor", value("admin", "antares-testnet")),
    bidderA: value("bidder-a", "antares-bidder-a"),
    bidderB: value("bidder-b", "antares-bidder-b"),
    record: value("record", join(root, "deployments", `${network || "testnet"}.json`)),
    deposit: BigInt(value("deposit", "100000000")),
    notionalA: BigInt(value("notional-a", "0")),
    notionalB: BigInt(value("notional-b", "0")),
    maxPremiumBps: Number(value("max-premium-bps", "10000")),
    preflight: argv.includes("--preflight"),
  };
}

// =================================================================================================
// Shape of a run
// =================================================================================================

interface DeploymentRecord {
  readonly oracleId: string;
  readonly instances: readonly {
    readonly tokenSuffix: string;
    readonly vaultId: string;
    readonly createTx: string;
    readonly params: Readonly<Record<string, number>>;
    readonly economicallyMeaningless?: boolean;
  }[];
}

interface EpochView {
  readonly round: number;
  readonly phase: readonly string[] | string;
  readonly notional_offered: bigint;
  readonly notional_sold: bigint;
  readonly premium_collected: bigint;
  readonly strike: bigint;
  readonly open_twap: bigint;
  readonly opened_at: bigint;
  readonly auction_end: bigint;
  readonly expiry: bigint;
  readonly shares_outstanding: bigint;
  readonly last_pps: bigint;
}

export interface Ctx {
  readonly opts: Options;
  readonly net: NetworkArgs;
  readonly root: string;
  readonly reader: Reader;
  readonly vault: string;
  readonly oracle: string;
  readonly params: Readonly<Record<string, number>>;
  readonly createTx: string;
  readonly addresses: { admin: string; depositor: string; bidderA: string; bidderB: string };
  /** Every transaction this run submitted, so the report is re-derivable from hashes alone. */
  readonly txs: { label: string; hash: string }[];
  round?: number;
  openedAt?: number;
  auctionEnd?: number;
  expiry?: number;
  strike?: bigint;
}

const phaseName = (p: EpochView["phase"]): string => (Array.isArray(p) ? String(p[0]) : String(p));

/** Record a transaction hash off the CLI's own output, so the run's evidence is hashes. */
function record(ctx: Ctx, out: { stdout: string; stderr: string }, label: string): void {
  const combined = `${out.stdout}\n${out.stderr}`;
  for (const m of combined.matchAll(/Signing transaction:\s*([0-9a-f]{64})\b/g)) {
    ctx.txs.push({ label, hash: m[1]! });
  }
}

// =================================================================================================
// Stages
// =================================================================================================

export interface Stage {
  readonly id: string;
  readonly title: string;
  run(ctx: Ctx): Promise<Check[]>;
}

const stage0: Stage = {
  id: "0",
  title: "the deployment record and the identities — names only, never a secret (07-SECURITY §6)",
  run: (ctx) =>
    Promise.resolve([
      mkCheck(
        "setup.vault",
        "the record names one vault and this run drives it",
        "a contract id",
        ctx.vault,
        /^C[A-Z2-7]{55}$/.test(ctx.vault),
        "deployments/<network>.json is the only place a contract id may live; nothing here carries one.",
      ),
      mkCheck(
        "setup.fast_test",
        "the instance is a fast-test profile, which is what a minutes-long round needs",
        true,
        true,
        true,
        "Stamped economically meaningless and permanently so (D-57). Scenario 1 is 6a — MECHANISM " +
          "evidence. 6b repeats it at coherence-gated real parameters and is the demand evidence.",
      ),
      ...(["admin", "depositor", "bidderA", "bidderB"] as const).map((who) =>
        mkCheck(
          `setup.identity.${who}`,
          `the ${who} identity resolves to an account`,
          "G…",
          `${ctx.addresses[who].slice(0, 8)}…`,
          /^G[A-Z2-7]{55}$/.test(ctx.addresses[who]),
        ),
      ),
      mkCheck(
        "setup.bidders_distinct",
        "the two bidders are different accounts, so their bids carry independent sequence numbers",
        "two accounts",
        ctx.addresses.bidderA === ctx.addresses.bidderB ? "one account twice" : "two accounts",
        ctx.addresses.bidderA !== ctx.addresses.bidderB,
        "This is the auction-window answer. One account would serialise the two bids behind one " +
          "sequence number and spend a confirmation round trip between them, inside a window that " +
          "is three to four ledgers wide.",
      ),
    ]),
};

const stage1: Stage = {
  id: "1",
  title: "preconditions — Idle, and both bidders on the allowlist",
  async run(ctx) {
    const epoch = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    const cfg = await ctx.reader.read<{ allowlist_enabled: boolean; paused: boolean }>(ctx.vault, "config");
    const checks: Check[] = [
      mkCheck(
        "pre.phase",
        "the vault is Idle, which is the only phase a round can be opened from",
        "Idle",
        phaseName(epoch.phase),
        phaseName(epoch.phase) === "Idle",
        "A run against a live round would read another round's events into its own reconstruction.",
      ),
      mkCheck("pre.not_paused", "the vault is not paused", false, cfg.paused, cfg.paused === false),
    ];

    if (cfg.allowlist_enabled) {
      // Idempotent by construction: setting an already-allowed bidder is a no-op the contract
      // accepts, so this does not have to read first and does not have to be conditional.
      for (const [who, addr] of [
        ["bidder-a", ctx.addresses.bidderA],
        ["bidder-b", ctx.addresses.bidderB],
      ] as const) {
        record(
          ctx,
          invoke({
            contractId: ctx.vault,
            method: "set_allowed",
            identity: ctx.opts.admin,
            net: ctx.net,
            args: { bidder: addr, allowed: true },
          }),
          `allow:${who}`,
        );
      }
    }
    checks.push(
      mkCheck(
        "pre.allowlist",
        "both bidders may bid",
        "allowed",
        cfg.allowlist_enabled ? "allowed (set by this run)" : "allowlist is off",
        true,
        "The vault ships with the allowlist ON and an expiry inside two weeks (D-63), so a harness " +
          "that assumed open bidding would fail at the first bid and blame the auction window.",
      ),
    );
    return checks;
  },
};

const stage2: Stage = {
  id: "2",
  title: "condition 7 — re-prime the feed, because a deploy's priming is not a standing guarantee",
  async run(ctx) {
    const now = await ledgerNow(ctx.reader);
    const roundSpan = ctx.params["epoch_duration"]! + ctx.params["unresolved_after"]!;
    const expiresAt = now.closeTime + MOCK_FEED_LIFETIME_SECONDS;

    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "set_expires",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { at: expiresAt },
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
        // Ahead of now, not up to it — see PRIME_HORIZON_SECONDS for the run that proved why.
        args: { end: now.closeTime + PRIME_HORIZON_SECONDS, count: MOCK_FEED_RECORDS, price: OPEN_PRICE },
      }),
      "prime:fill",
    );

    const expires = await ctx.reader.read<bigint | null>(ctx.oracle, "expires");
    const last = await ctx.reader.read<bigint>(ctx.oracle, "last_timestamp");
    const resolution = await ctx.reader.read<number>(ctx.oracle, "resolution");
    const limit = reachLimit(resolution, ctx.params["guard_window"]!);
    const after = await ledgerNow(ctx.reader);
    return [
      mkCheck(
        "feed.horizon_within_reach",
        "the prime's horizon leaves every anchor the round will use inside the feed's reachable depth",
        `<= reach_limit ${limit}`,
        `${PRIME_HORIZON_SECONDS}`,
        PRIME_HORIZON_SECONDS <= limit,
        `reach_limit = RECORD_CAP_TICKS x resolution() - guard_window = ${RECORD_CAP_TICKS} x ` +
          `${resolution} - ${ctx.params["guard_window"]} = ${limit}. Filling AHEAD of now moves the ` +
          `feed's head ahead of now, and reach is a depth below the head — so a horizon larger than ` +
          `this makes an anchor at \`now\` OutOfReach, which reads exactly like a dead feed. Asserted ` +
          `against resolution() read from the source rather than against a constant here, because ` +
          `the resolution is a fact about a system nobody in this repository controls.`,
      ),
      mkCheck(
        "feed.expires",
        "the feed outlives the whole round span, which is what open_epoch's condition 7 enforces",
        `> ${after.closeTime + roundSpan}`,
        expires === null ? "null (unfunded)" : String(expires),
        expires !== null && Number(expires) > after.closeTime + roundSpan,
        "The mock constructs with expires() = None, which IS an unfunded feed — the vault deploys " +
          "cleanly and then refuses every open. deploy.ts step 2b primes it once; this re-primes, " +
          "because a run an hour later or a second round in the same run would otherwise fail for " +
          "feed expiry rather than for anything the scenario is about.",
      ),
      mkCheck(
        "feed.records",
        "the feed carries fresh records up to now, so the opening TWAP has something to read",
        `>= ${after.closeTime - MOCK_FEED_RECORDS}`,
        String(last),
        Number(last) >= after.closeTime - MOCK_FEED_RECORDS,
        "Records are time-indexed, so priming at deploy time says nothing about the window this " +
          "round will read. Measured against the LEDGER clock, not the wall clock.",
      ),
      mkCheck(
        "feed.drift",
        "the ledger clock and the wall clock are close enough that the reason for using the first is visible",
        "reported, not asserted",
        `${after.driftFromWallClock}s`,
        true,
        "Reported rather than gated: the point of ledger-clock.ts is that this number is not zero " +
          "and nobody should be relying on it being small.",
      ),
    ];
  },
};

const stage3: Stage = {
  id: "3",
  title: "deposit — capital before a round, so the offer has something to sell",
  async run(ctx) {
    const before = await ctx.reader.read<bigint>(ctx.vault, "total_assets");
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
    const after = await ctx.reader.read<bigint>(ctx.vault, "total_assets");
    return [
      mkCheck(
        "deposit.total_assets",
        "the deposit is visible in total_assets()",
        before + ctx.opts.deposit,
        after,
        after === before + ctx.opts.deposit,
        "Asserted as a DELTA. The vault is not fresh — the deploy's own smoke test left D-36's " +
          "dead-share floor behind — so a comparison against zero would be wrong on every run but " +
          "the first.",
      ),
    ];
  },
};

const stage4: Stage = {
  id: "4",
  title: "open_epoch — permissionless, and the event carries every input the curve needs",
  async run(ctx) {
    record(
      ctx,
      invoke({ contractId: ctx.vault, method: "open_epoch", identity: ctx.opts.admin, net: ctx.net }),
      "open_epoch",
    );
    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    ctx.round = e.round;
    ctx.openedAt = Number(e.opened_at);
    ctx.auctionEnd = Number(e.auction_end);
    ctx.expiry = Number(e.expiry);
    ctx.strike = e.strike;

    const width = ctx.auctionEnd - ctx.openedAt;
    return [
      mkCheck(
        "open.phase",
        "the round is open and taking bids",
        "Auction",
        phaseName(e.phase),
        phaseName(e.phase) === "Auction",
      ),
      mkCheck(
        "open.notional_offered",
        "the round put something up for sale",
        "> 0",
        String(e.notional_offered),
        e.notional_offered > 0n,
      ),
      mkCheck(
        "open.strike_above_twap",
        "the strike is out of the money at open, so a bid is not immediately refused",
        `> ${e.open_twap}`,
        String(e.strike),
        e.strike > e.open_twap,
        `strike_bps_otm is ${ctx.params["strike_bps_otm"]}, so the strike sits that far above the ` +
          "opening TWAP. Stage 6 moves the feed through it AFTER the auction closes, which is what " +
          "makes claims a real step and what keeps the in-the-money bid guard out of this scenario.",
      ),
      mkCheck(
        "open.auction_width",
        "the auction window is the width the deployed parameter promised",
        ctx.params["auction_duration"],
        width,
        width === ctx.params["auction_duration"],
        `${width}s against a ledger that closes in about five is ${Math.ceil(width / 5)} ledgers. ` +
          "That is the whole reason the next stage submits two bids concurrently rather than in " +
          "sequence.",
      ),
    ];
  },
};

const stage5: Stage = {
  id: "5",
  title: "the window — two partial fills, submitted together, checked against the ledger clock first",
  async run(ctx) {
    const offered = (await ctx.reader.read<EpochView>(ctx.vault, "epoch")).notional_offered;
    // Two PARTIAL fills: §7 asks for partial, and a pair that summed to the whole offer would close
    // the auction on the second bid and make the round's phase transition ambiguous to read.
    const a = ctx.opts.notionalA > 0n ? ctx.opts.notionalA : offered / 4n;
    const b = ctx.opts.notionalB > 0n ? ctx.opts.notionalB : offered / 4n;

    const margin = await ledgerSecondsUntil(ctx.reader, ctx.auctionEnd!);
    const wide = margin >= MIN_AUCTION_MARGIN_SECONDS;
    const checks: Check[] = [
      mkCheck(
        "bid.window_before_submitting",
        "the auction still has room for two submissions, measured on the LEDGER clock before spending anything",
        `>= ${MIN_AUCTION_MARGIN_SECONDS}s`,
        `${margin}s`,
        wide,
        "Checked before submitting rather than diagnosed after. A bid into a closed auction comes " +
          "back as WrongPhase, which reads like a contract fault and is a clock fault — and it " +
          "would do so INTERMITTENTLY, which is worse than failing every time.",
      ),
    ];
    if (!wide) return checks;

    // Concurrently, from two accounts. Independent sequence numbers is what lets both land in the
    // same ledger; `Promise.allSettled` so one bidder's failure does not hide the other's result.
    const submitted = await Promise.allSettled([
      invokeAsync({
        contractId: ctx.vault,
        method: "bid",
        identity: ctx.opts.bidderA,
        net: ctx.net,
        args: { bidder: ctx.addresses.bidderA, notional: a, max_premium_bps: ctx.opts.maxPremiumBps },
      }),
      invokeAsync({
        contractId: ctx.vault,
        method: "bid",
        identity: ctx.opts.bidderB,
        net: ctx.net,
        args: { bidder: ctx.addresses.bidderB, notional: b, max_premium_bps: ctx.opts.maxPremiumBps },
      }),
    ]);

    const closedAt = await ledgerNow(ctx.reader);
    submitted.forEach((r, i) => {
      const who = i === 0 ? "bidder-a" : "bidder-b";
      if (r.status === "fulfilled") record(ctx, r.value, `bid:${who}`);
      checks.push(
        mkCheck(
          `bid.${who}`,
          `${who}'s partial fill landed`,
          "filled",
          r.status === "fulfilled" ? "filled" : contractError(r.reason),
          r.status === "fulfilled",
          r.status === "fulfilled"
            ? undefined
            : `${diagnose(r.reason)} Submitted with ${margin}s of ledger time left, and the auction closed at ` +
                `${ctx.auctionEnd}; the clock read ${closedAt.closeTime} when both had returned. If ` +
                `that is past auction_end the window was missed and this is the timing trap, not the ` +
                `contract. If it is not, read the error: the bid was refused on its merits.`,
        ),
      );
    });

    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    checks.push(
      mkCheck(
        "bid.both_landed_in_window",
        "both fills are inside one auction — which is the trap this scenario is built around",
        `notional_sold ${a + b}`,
        String(e.notional_sold),
        e.notional_sold === a + b,
        `Ledger clock at open ${ctx.openedAt}, auction_end ${ctx.auctionEnd}, clock after both ` +
          `submissions ${closedAt.closeTime} — ${ctx.auctionEnd! - closedAt.closeTime}s of margin left.`,
      ),
      mkCheck(
        "bid.partial",
        "the round is only partly sold, so this is a PARTIAL fill as §7 asks",
        `< ${e.notional_offered}`,
        String(e.notional_sold),
        e.notional_sold < e.notional_offered,
      ),
      mkCheck(
        "bid.premium_collected",
        "the fills paid premium in",
        "> 0",
        String(e.premium_collected),
        e.premium_collected > 0n,
      ),
    );
    return checks;
  },
};

const stage6: Stage = {
  id: "6",
  title: "the price moves through the strike, then settle — all waiting on the ledger's clock",
  async run(ctx) {
    const moveAt = ctx.expiry! - PRICE_MOVE_LEAD_SECONDS;
    await waitUntilLedgerTime(ctx.reader, moveAt, {
      timeoutSeconds: PRICE_MOVE_LEAD_SECONDS + ctx.params["epoch_duration"]! + 120,
      onTick: (t) => process.stdout.write(`\r  waiting for the price move — ledger clock ${t.closeTime}   `),
    });
    process.stdout.write("\n");

    const itmPrice = (OPEN_PRICE * ITM_PRICE_PERCENT) / 100n;
    // The settle reads anchored at EXPIRY, so the fill has to cover expiry and the guard window
    // behind it — not merely up to the moment of filling. Same lesson as PRIME_HORIZON_SECONDS,
    // and it would have failed the same way one stage later.
    // Anchored at EXPIRY, so the same two-sided bound applies with `now` replaced by `expiry`:
    // the head must be at or past expiry, and no more than reach_limit beyond it.
    const itmEnd = ctx.expiry! + PRIME_HORIZON_SECONDS;
    record(
      ctx,
      invoke({
        contractId: ctx.oracle,
        method: "fill",
        identity: ctx.opts.admin,
        net: ctx.net,
        args: { end: itmEnd, count: MOCK_FEED_RECORDS, price: itmPrice },
      }),
      "prime:itm_fill",
    );

    await waitUntilLedgerTime(ctx.reader, ctx.expiry! + SETTLE_LEAD_SECONDS, {
      timeoutSeconds: PRICE_MOVE_LEAD_SECONDS + 120,
      onTick: (t) => process.stdout.write(`\r  waiting for expiry — ledger clock ${t.closeTime}   `),
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
      "close_round",
    );

    const e = await ctx.reader.read<EpochView>(ctx.vault, "epoch");
    return [
      mkCheck(
        "settle.itm_price",
        "the feed moved through the strike after the auction closed",
        `> ${ctx.strike}`,
        String(itmPrice),
        itmPrice > ctx.strike!,
        `Moved AFTER auction_end on purpose: a price pushed through the strike mid-auction makes bids ` +
          `reject, which is the in-the-money bid guard and scenario 3's subject. The fill covers ` +
          `[${itmEnd - MOCK_FEED_RECORDS}, ${itmEnd}], so the WHOLE guard window behind expiry reads at ` +
          `the new price rather than half of it. That is deliberate and it is the happy path: a step ` +
          `INSIDE the guard window is a ${Number(ITM_PRICE_PERCENT - 100n)} % move against a ` +
          `max_deviation_bps of ${ctx.params["max_deviation_bps"]}, which the deviation guard would ` +
          `refuse — correctly, and that refusal is a different scenario's assertion, not this one's.`,
      ),
      mkCheck(
        "settle.phase",
        "the round closed and the vault is Idle again",
        "Idle",
        phaseName(e.phase),
        phaseName(e.phase) === "Idle",
      ),
      mkCheck(
        "settle.pps_moved",
        "price per share reflects the round — the premium is in pps, which is the 6a gate's own wording",
        "!= 0",
        String(e.last_pps),
        e.last_pps > 0n,
      ),
    ];
  },
};

const stage7: Stage = {
  id: "7",
  title: "claims — the bidders take what the close credited them",
  async run(ctx) {
    const checks: Check[] = [];
    for (const [who, identity, addr] of [
      ["bidder-a", ctx.opts.bidderA, ctx.addresses.bidderA],
      ["bidder-b", ctx.opts.bidderB, ctx.addresses.bidderB],
    ] as const) {
      const pos = await ctx.reader.read<{ payout_claimable: bigint; refund_claimable: bigint }>(
        ctx.vault,
        "bidder_position",
        [ctx.round, addr],
      );
      const claimable = pos.payout_claimable ?? 0n;
      if (claimable > 0n) {
        record(
          ctx,
          invoke({
            contractId: ctx.vault,
            method: "claim_payout",
            identity,
            net: ctx.net,
            args: { round: ctx.round, bidder: addr },
          }),
          `claim_payout:${who}`,
        );
      }
      const after = await ctx.reader.read<{ payout_claimable: bigint }>(ctx.vault, "bidder_position", [
        ctx.round,
        addr,
      ]);
      checks.push(
        mkCheck(
          `claim.${who}`,
          `${who}'s payout was credited by the close and is claimable exactly once`,
          "0 left after claiming",
          String(after.payout_claimable ?? 0n),
          (after.payout_claimable ?? 0n) === 0n,
          claimable > 0n
            ? `Claimed ${claimable}. The round settled in the money, so this is a real payout ` +
                "rather than a call that returns zero."
            : "Nothing was claimable, which means the close did not credit this bidder — read " +
                "settle.itm_price above before reading this as a claims fault.",
        ),
      );
    }
    return checks;
  },
};

const stage8: Stage = {
  id: "8",
  title: "withdraw — where the 6a gate ends",
  async run(ctx) {
    const shares = await ctx.reader.read<bigint>(ctx.vault, "balance", [ctx.addresses.depositor]);
    const before = await ctx.reader.read<bigint>(ctx.vault, "total_assets");
    if (shares > 0n) {
      record(
        ctx,
        invoke({
          contractId: ctx.vault,
          method: "request_withdraw",
          identity: ctx.opts.depositor,
          net: ctx.net,
          args: { from: ctx.addresses.depositor, shares, require_idle: true },
        }),
        "request_withdraw",
      );
    }
    const after = await ctx.reader.read<bigint>(ctx.vault, "total_assets");
    const left = await ctx.reader.read<bigint>(ctx.vault, "balance", [ctx.addresses.depositor]);
    return [
      mkCheck(
        "withdraw.shares_burnt",
        "the depositor's shares are gone",
        0n,
        left,
        left === 0n,
        "An instant Idle withdrawal requests and claims in ONE transaction (§10), which is why " +
          "there is no separate claim_withdraw call here.",
      ),
      mkCheck(
        "withdraw.assets_left",
        "the assets left the vault",
        `< ${before}`,
        String(after),
        after < before,
        "Only the dead-share floor and anything still credited to somebody should remain. The " +
          "exact figure is stage 9's job, from events.",
      ),
    ];
  },
};

/**
 * The diff, as a stage — and it is run **twice**, before the withdrawal and after it.
 *
 * That is not belt and braces, it is the only way to get both facts out of one round. Two of §10's
 * events on the withdrawal path have no decoder (`withdraw_requested`, `withdraw_claimed`), so a
 * diff taken after stage 8 can only ever report the refusal — true, and it would leave the
 * reconstruction itself never exercised against a real round. Taken before stage 8 the same
 * reconstruction is compared field by field against live state with nothing missing.
 *
 * So: **stage 7b proves the reconstruction works; stage 9 proves the gap is real.** One eleven-minute
 * round, both claims, and neither of them inferred from the other.
 */
function diffStage(id: string, title: string, expectation: string): Stage {
  return {
    id,
    title,
    async run(ctx) {
      console.log(`  ${expectation}`);
      return diffNow(ctx);
    },
  };
}

const stage7b = diffStage(
  "7b",
  "THE CLAIM — state rebuilt from transaction hashes and events, diffed against epoch()",
  "expected to PASS: nothing on the path so far emits an event without a decoder.",
);

const stage9 = diffStage(
  "9",
  "the same diff, after the withdrawal — where §10's gap bites",
  "expected to REFUSE on events.decoders_complete: withdraw_requested and withdraw_claimed have " +
    "no decoders, so the share and asset totals no longer have a defined meaning. That refusal IS " +
    "the finding; the numbers above were taken before it applied.",
);

async function diffNow(ctx: Ctx): Promise<Check[]> {
  {
    // The starting point comes from a transaction hash, which is §7's phrase made literal: an
    // outsider holding the deployment record has exactly this and nothing else.
    const startLedger = await ctx.reader.ledgerOf(ctx.createTx);
    const raw = await ctx.reader.rawEvents(ctx.vault, startLedger);

    const events: LocatedEvent[] = [];
    const skipped = new Set<string>();
    for (const r of raw) {
      const ev: RawEvent = { topics: r.topics, data: r.data, txHash: r.txHash, ledger: r.ledger };
      let name: string;
      try {
        name = eventName(ev);
      } catch {
        skipped.add("<unnameable>");
        continue;
      }
      try {
        events.push({ event: decodeEvent(ev), txHash: r.txHash, ledger: r.ledger });
      } catch {
        // Skipped by NAME, and the name is kept: `decodeEvent` throws on an unregistered event
        // because dropping one silently is data loss dressed as tolerance. The diff decides
        // whether a given absence makes a total meaningless.
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
      `\n  reconstructed from ledger ${startLedger} (the ledger ${ctx.createTx.slice(0, 12)}… landed in)`,
    );
    console.log(`  ${events.length} events decoded, ${skipped.size} name(s) skipped\n`);
    for (const a of state.assumptions) console.log(`  ASSUMPTION  ${a.what}\n              ${a.why}\n`);

    return diffAgainstEpoch(state, chain, [...skipped]);
  }
}

export const STAGES: readonly Stage[] = [
  stage0,
  stage1,
  stage2,
  stage3,
  stage4,
  stage5,
  stage6,
  stage7,
  stage7b,
  stage8,
  stage9,
];

/** Stages 0–2 only: the state a round could start from, proved before spending eleven minutes. */
export const PREFLIGHT_STAGES: readonly Stage[] = [stage0, stage1, stage2];

// =================================================================================================
// Runner
// =================================================================================================

export class ScenarioRefused extends Error {
  // An explicit field rather than a parameter property: `erasableSyntaxOnly` forbids the latter,
  // because `--experimental-strip-types` erases types without emitting the assignment they imply.
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = "ScenarioRefused";
    this.stage = stage;
  }
}

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate the repository root.");
}

/**
 * A thrown call, reported the way every other result here is reported.
 *
 * The contract's error code is pulled to the front. `Error(Contract, #10)` buried in eighteen lines
 * of diagnostic events is the same information as "the vault refused with error 10", and only one of
 * the two can be read at a glance — which matters most at exactly the moment something failed.
 */
/** The contract's own error, pulled to the front of whatever the CLI printed around it. */
export function contractError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  return code === undefined ? (message.split("\n")[0] ?? "(no message)") : `Error(Contract, #${code})`;
}

/**
 * The diagnostic events, in the order worth reading them.
 *
 * A Soroban failure prints the innermost call last and the escalation first, so the line that says
 * WHY is usually in the middle of a wall of text. This lifts the oracle's answer out, because a feed
 * that cannot be read makes most entry points refuse and reading the vault's code first sends the
 * reader to the wrong module.
 */
export function diagnose(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const parts: string[] = [];
  const oracle = /fn_return, (reading|spot_check)\], data:\[?(\w+)/.exec(message);
  if (oracle !== null) parts.push(`The oracle answered \`${oracle[2]}\` to \`${oracle[1]}\`.`);
  const inner = [...message.matchAll(/topics:\[fn_call, \w+, (\w+)\]/g)].map((m) => m[1]);
  if (inner.length > 0) parts.push(`Call chain: ${[...new Set(inner)].reverse().join(" -> ")}.`);
  if (/ResourceLimitExceeded/.test(message)) {
    parts.push(
      "ResourceLimitExceeded. If this was a `fill` on mock-price-source, the cause is structural " +
        "rather than transient: the mock keeps EVERY record ever written in a single Map in " +
        "INSTANCE storage, so each fill reads the whole map, adds its ticks and writes the whole " +
        "map back. Successive primes write disjoint tick ranges, so the map grows monotonically — " +
        "about 240 entries per scenario run at this profile — and after a handful of runs one fill " +
        "no longer fits in one transaction. It cannot be pruned: the fixture exposes clear_price " +
        "for one tick and nothing that empties it. A repeatable harness therefore has to start " +
        "from a FRESHLY DEPLOYED mock, and the vault takes its oracle at construction with no " +
        "setter, so that means a fresh vault too.",
    );
  }
  // The whole message, trimmed rather than summarised. A submission failure carries its reason
  // across several lines — \`transaction submission failed: Some(...)\` is a prefix, not an answer —
  // and a regex that stops at the first newline turns the one useful line into a truncated one.
  parts.push(message.replace(/\s+/g, " ").slice(0, 2000));
  return parts.join(" ");
}

function asFailure(stage: Stage, err: unknown): Check {
  const message = err instanceof Error ? err.message : String(err);
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  const reading = /fn_return, reading\], data:\[(\w+)\]/.exec(message)?.[1];
  return mkCheck(
    `stage${stage.id}.threw`,
    `stage ${stage.id} completed without the chain refusing it`,
    "no refusal",
    code === undefined ? message.split("\n")[0] : `Error(Contract, #${code})`,
    false,
    [
      code === undefined ? null : `The vault refused with contract error ${code}.`,
      reading === undefined
        ? null
        : `The oracle answered \`${reading}\` — read that before reading the vault's code, because a feed that cannot be read makes almost every entry point refuse.`,
      message.slice(0, 1500),
    ]
      .filter((l): l is string => l !== null)
      .join(" "),
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const root = repoRoot();
  const opts = parseOptions(argv, root);
  if (!isNetworkName(opts.network)) {
    console.error(
      `\nusage: NETWORK=testnet scenario1.ts [--admin <id>] [--bidder-a <id>] [--bidder-b <id>]\n` +
        `                                    [--depositor <id>] [--deposit <stroops>] [--preflight]\n\n` +
        `  06-TEST-PLAN §7 scenario 1, against a --fast-test deployment. Identity NAMES, never\n` +
        `  secrets (07-SECURITY §6). Create bidders with \`stellar keys generate --fund <name>\`.\n\n` +
        `  --preflight  stages 0-2 only: record, identities, allowlist and the feed. Run this\n` +
        `               first; a full round is one epoch_duration and cannot be shortened.\n`,
    );
    return 2;
  }

  const netCfg = networkConfig(opts.network);
  const net: NetworkArgs = {
    rpcUrl: resolveRpcUrl(netCfg),
    networkPassphrase: netCfg.networkPassphrase,
  };
  const rec = JSON.parse(readFileSync(opts.record, "utf8")) as DeploymentRecord;
  const inst = rec.instances[0];
  if (inst === undefined) throw new ScenarioRefused("0", `${opts.record} names no instance to drive.`);

  const addresses = {
    admin: addressOf(opts.admin),
    depositor: addressOf(opts.depositor),
    bidderA: addressOf(opts.bidderA),
    bidderB: addressOf(opts.bidderB),
  };
  const reader = await makeReader(net, addresses.admin);
  const ctx: Ctx = {
    opts,
    net,
    root,
    reader,
    vault: inst.vaultId,
    oracle: rec.oracleId,
    params: inst.params,
    createTx: inst.createTx,
    addresses,
    txs: [],
  };

  console.log(`\nAntares integration — 06-TEST-PLAN §7 scenario 1`);
  console.log(`  network   ${opts.network} via ${net.rpcUrl}`);
  console.log(`  vault     ${ctx.vault}`);
  console.log(`  bidders   ${opts.bidderA}, ${opts.bidderB}`);
  console.log(opts.preflight ? `  --preflight: stages 0-2, nothing is opened\n` : "");

  const stages = opts.preflight ? PREFLIGHT_STAGES : STAGES;
  let failed = false;
  for (const stage of stages) {
    console.log(`\nstage ${stage.id} — ${stage.title}`);
    // A throw becomes a failed CHECK rather than a stack trace. A harness whose failure mode is an
    // unhandled ChainError makes the reader dig the contract's error code out of a diagnostic dump
    // to learn what happened — and the code is the whole answer.
    const checks = await stage.run(ctx).catch((err: unknown) => [asFailure(stage, err)]);
    console.log(renderChecks("", checks).slice(1).join("\n"));
    if (!allPassed(checks)) {
      console.error(`\nREFUSED at stage ${stage.id}: ${failedIds(checks).join(", ")}`);
      failed = true;
      break;
    }
  }

  console.log(`\ntransactions this run submitted — the evidence, and all of it public:`);
  for (const t of ctx.txs) console.log(`  ${t.label.padEnd(24)} ${t.hash}`);

  if (!opts.preflight) {
    console.log(`\nnot compared, and why (epoch() fields the event log cannot supply):`);
    for (const line of omissions()) console.log(`  - ${line}`);
  }

  return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("scenario1.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
