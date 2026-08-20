/**
 * The diff — an events-only reconstruction against what `epoch()` says, in the vocabulary every
 * other gate in this repository reports in.
 *
 * # What a failure here means, and what it does not
 *
 * A mismatch is **not** automatically a contract bug. There are three candidates and the report has
 * to keep them apart, because they have entirely different owners:
 *
 *   1. the contract's state is wrong,
 *   2. the event ABI does not carry enough to reconstruct the state — §10 calls itself *"a public
 *      interface"* whose consumers *"reconstruct state from them"*, so this is a §10 defect,
 *   3. this module models §10 wrongly.
 *
 * Only (3) is fixed by editing this file, and (3) is the one a harness author reaches for first.
 * So the checks below are written to be falsifiable against the specification rather than against
 * the contract's answer: each one names the §10 term it is summing. If a check fails and the terms
 * it names are the right ones, the finding is (1) or (2) and belongs in `plan/`, not here.
 *
 * # The refusal, and why it comes first
 *
 * `events.decoders_complete` runs before every comparison and fails the whole diff when a §10 event
 * that moves an amount has no decoder. Every total below would still compute — that is the danger.
 * A share balance missing one `withdraw_claimed` is not *approximately* right; it is a number with
 * no defined meaning, and reporting it next to a passing round number invites exactly the reading
 * the refusal exists to prevent.
 */

import { mkCheck, sameValue, type Check } from "@antares/common/checks";

import { classifySkipped, NOT_RECONSTRUCTIBLE, phaseAt, type ReconstructedState } from "./reconstruct.ts";

/**
 * What the chain says, read once, at a known ledger time.
 *
 * Deliberately a plain structure rather than the generated `EpochInfo`: the diff is driven from
 * fixtures in unit tests, and requiring the full binding type there would mean either building a
 * 20-field object per test or reaching for `as any`. The fields named here are the ones the event
 * log can speak to; {@link NOT_RECONSTRUCTIBLE} says why the rest are absent.
 */
export interface ChainState {
  readonly round: number;
  readonly phase: "Idle" | "Auction" | "Active";
  readonly notionalOffered: bigint;
  readonly notionalSold: bigint;
  readonly premiumCollected: bigint;
  readonly strike: bigint;
  readonly openTwap: bigint;
  readonly openedAt: number;
  readonly auctionEnd: number;
  readonly expiry: number;
  readonly sharesOutstanding: bigint;
  readonly lastPps: bigint;
  /** `total_assets()`, read in the same pass. */
  readonly totalAssets: bigint;
  /** The ledger's clock at the moment of reading — never `Date.now()`. See `ledger-clock.ts`. */
  readonly ledgerTime: number;
}

/** One comparison: what the events say, what the chain says, and the §10 terms that produced it. */
function cmp(id: string, what: string, fromEvents: unknown, fromChain: unknown, terms: string): Check {
  return mkCheck(`events.${id}`, what, fromChain, fromEvents, sameValue(fromEvents, fromChain), terms);
}

export function diffAgainstEpoch(
  state: ReconstructedState,
  chain: ChainState,
  skipped: readonly string[] = [],
): Check[] {
  const { benign, blocking } = classifySkipped(skipped);
  const checks: Check[] = [
    mkCheck(
      "events.decoders_complete",
      "every §10 event that moves an amount has a decoder, so the totals below have a meaning",
      "none missing",
      blocking.length === 0 ? "none missing" : blocking.map((b) => b.name).join(", "),
      blocking.length === 0,
      blocking.length === 0
        ? `Skipped and harmless: ${benign.length === 0 ? "(nothing)" : benign.join(", ")} — §10's ` +
            "SEP-41 mirror and the admin stream, neither of which this reconstruction counts."
        : `Missing: ${blocking.map((b) => `${b.name} — ${b.why}`).join(" | ")}`,
    ),
  ];
  if (blocking.length > 0) return checks;

  checks.push(
    cmp(
      "round",
      "the round number the log's last epoch_opened announced",
      state.round,
      chain.round,
      "epoch_opened.round",
    ),
    cmp(
      "phase",
      "the phase implied by the log and the ledger clock",
      phaseAt(state, chain.ledgerTime),
      chain.phase,
      "epoch_opened.auction_end plus the presence of a terminal event — the Auction→Active " +
        "transition emits nothing, so this is the one field the clock decides and the log does not.",
    ),
    cmp(
      "notional_offered",
      "the notional the round put up for sale",
      state.notionalOffered,
      chain.notionalOffered,
      "epoch_opened.notional_offered",
    ),
    cmp(
      "notional_sold",
      "the notional actually filled",
      state.notionalSold,
      chain.notionalSold,
      "the last bid_filled.notional_sold_after of the round",
    ),
    mkCheck(
      "events.notional_sold_self_consistent",
      "§10's per-fill notional sums to the running total §10 publishes beside it",
      state.notionalSold,
      state.notionalSoldSummed,
      state.notionalSold === state.notionalSoldSummed,
      "Both sides of this come from the event ABI, so it is a statement ABOUT §10 rather than " +
        "about the vault: a disagreement means bid_filled's two amounts contradict each other, " +
        "which no comparison against epoch() could surface because the contract would agree with " +
        "itself under either value.",
    ),
    cmp(
      "premium_collected",
      "the premium the fills paid in",
      state.premiumCollected,
      chain.premiumCollected,
      "the sum of bid_filled.premium over the round",
    ),
    cmp("strike", "the round's strike", state.strike, chain.strike, "epoch_opened.strike"),
    cmp(
      "open_twap",
      "the TWAP the round opened at",
      state.openTwap,
      chain.openTwap,
      "epoch_opened.open_twap",
    ),
    cmp("opened_at", "when the round opened", state.openedAt, chain.openedAt, "epoch_opened.opened_at"),
    cmp("auction_end", "when bidding closed", state.auctionEnd, chain.auctionEnd, "epoch_opened.auction_end"),
    cmp("expiry", "when the round expires", state.expiry, chain.expiry, "epoch_opened.expiry"),
    cmp(
      "shares_outstanding",
      "the share supply, dead-share floor included",
      state.sharesOutstanding,
      chain.sharesOutstanding,
      "deposited.shares_minted and withdraw_claimed.shares, plus D-36's floor at the first mint — " +
        "and the floor is the one term NO event carries. See DEAD_SHARES; the run's assumptions " +
        "list says so beside this result.",
    ),
    cmp(
      "net_assets",
      "what the vault holds, less what it has credited and not yet paid",
      state.holdings - state.liabilities - state.unsettledPremium,
      chain.totalAssets,
      "net = holdings - liabilities - unsettledPremium. holdings = deposited.amount + " +
        "bid_filled.premium - (payout_claimed + refund_claimed + " +
        "fee_claimed + settle_bounty + withdraw_claimed).amount; liabilities = settled.payout_total " +
        "+ settled.fee + wclaims + epoch_voided.premium_refunded, less what has been claimed. The " +
        "difference is deliberately the quantity that does NOT depend on which side of the line " +
        "total_assets() puts an unclaimed credit, because such a credit appears in both terms. " +
        "unsettledPremium is the third term and it was learned the hard way: premium taken by a " +
        "round that has not closed is held but belongs to nobody — depositors on settle, lapse or " +
        "unresolved, the bidders back on void — and total_assets() excludes it. Measured on " +
        "testnet 2026-08-21, where this check was over by exactly the open round premium and " +
        "nothing else.",
    ),
  );

  if (state.lastPps !== null) {
    checks.push(
      cmp(
        "last_pps",
        "price per share after the last close",
        state.lastPps,
        chain.lastPps,
        "the pps carried by settled / epoch_voided / epoch_unresolved / epoch_lapsed — §10 puts it " +
          "on all four finalization events precisely so an indexer cannot drift by missing one.",
      ),
    );
  }

  return checks;
}

/** The `EpochInfo` fields this diff deliberately does not compare, and why — printed with the run. */
export function omissions(): string[] {
  return Object.entries(NOT_RECONSTRUCTIBLE).map(([field, why]) => `${field}: ${why}`);
}
