/**
 * Vault state, rebuilt from events alone — the half of `06-TEST-PLAN.md` §7 scenario 1 that is
 * the actual claim.
 *
 * # Why this is not "drive the contract and check the result"
 *
 * §7 scenario 1 ends *"Verified from **transaction hashes + events only** (the public-verifiability
 * claim in the README is tested literally: the harness reconstructs state from events and diffs
 * against `epoch()`)"*. The parenthesis is the requirement, and the difference is not stylistic.
 *
 * A harness that calls `epoch()` and compares it to what it just did proves the contract agrees
 * with itself. A harness that rebuilds the same numbers from the **event log** and then diffs
 * proves that somebody with no repository, no view calls and no privileged access can do it — which
 * is the property the README sells and the only one an outsider can check. 02-CONTRACT-SPEC §10
 * says the same thing from the contract's side: events are *"a public interface, not logging"* and
 * *"the web UI and any indexer reconstruct state from them"*. This module is that indexer, written
 * small enough to be read in one sitting.
 *
 * # It is not a second copy of `keeper/record.ts`
 *
 * That module answers *"what happened in round N"* — the fill index, the one terminal event I10
 * allows, the history gaps — and writes it to an evidence file that outlives a testnet reset. This
 * one answers *"what does the vault hold and owe, right now"*, folding every round into a running
 * balance. Same stream, different question, and neither can be derived from the other's output.
 * Read `record.ts` before this one; the overlap is `Located`, which is three fields.
 *
 * # The modelling rule: no field is reconstructed by guessing at the Rust
 *
 * Everything below is derived from §10's normative table and §11's account of how XLM actually
 * moves. Where §10 does not settle a question — whether a pending deposit's assets are inside
 * `total_assets()`, whether a credited-but-unclaimed payout has left the pool — the answer is NOT
 * guessed. It is either expressed as an identity that holds under either reading, or the event is
 * listed in {@link ReconstructedState.unmodelled} and the caller can see the gap.
 *
 * That constraint is what makes a failing diff worth reading. A reconstruction that quietly assumes
 * its way past an ambiguity produces a mismatch that says nothing about the contract, and the first
 * thing anybody does with such a harness is adjust the reconstruction until it agrees.
 *
 * # The two balances, and why holdings alone would not do
 *
 * §11's transfers move XLM; §10's other amounts move *entitlements*. So this tracks both:
 *
 *   - **holdings** — every actual transfer in or out. Deposits and premium in; claimed payouts,
 *     claimed refunds, claimed withdrawals, claimed fees and settle bounties out.
 *   - **liabilities** — amounts credited to somebody and not yet claimed: `payout_total` awaiting
 *     `payout_claimed`, `premium_refunded` awaiting `refund_claimed`, `fee` awaiting `fee_claimed`,
 *     `wclaims` awaiting `withdraw_claimed`.
 *
 * `holdings - liabilities` is then a quantity that does not depend on which side of the accounting
 * line `total_assets()` draws for an unclaimed credit, because a credit that has not been claimed
 * appears in both terms. That identity is the strongest events-only statement available here, and
 * {@link diffAgainstEpoch} asserts it as one.
 */

import type { DecodedEvent } from "@antares/common/events";

/**
 * D-36's inflation-attack floor, and the one number here that **no event carries**.
 *
 * Measured on testnet 2026-08-20 against vault CDAVCVEV…, from two transaction hashes:
 * `deposited.shares_minted` and the SEP-41 `mint` both reported 9 999 000 for a 10 000 000 deposit
 * into an empty vault, and `epoch().shares_outstanding` afterwards was 1 000. So the floor is
 * minted to the contract itself and **is not observable in the event stream at all** — an
 * events-only indexer's share total is short by exactly this much, permanently, from a vault's
 * first deposit onward.
 *
 * It is applied here because the constant is public (D-36, 02-CONTRACT-SPEC), so an outsider
 * reading the specification can apply it too. But applying a documented constant is a strictly
 * weaker claim than reading a number off the chain, and {@link ReconstructedState.assumptions}
 * says so on every run rather than letting a green diff imply otherwise.
 */
export const DEAD_SHARES = 1_000n;

/** An event with the transaction it arrived in. Structurally `keeper/record.ts`'s `Located`. */
export interface LocatedEvent {
  readonly event: DecodedEvent;
  readonly txHash: string;
  readonly ledger: number;
}

/** A fact the reconstruction had to supply from the specification because no event carried it. */
export interface Assumption {
  readonly what: string;
  readonly why: string;
}

/**
 * An event §10 defines and the decoder does not register, which the fold therefore never sees.
 *
 * This is the gap that matters, and it does not arrive as a decoding error the fold could catch:
 * `fetchSince` filters unregistered names out and returns them under `skipped`, deliberately —
 * *"a thrown error is a visible gap; a skipped one is invisible"*. So the names come in from the
 * caller and are classified here, because whether a missing decoder is harmless depends entirely
 * on whether the event moves an amount.
 */
export interface Unmodelled {
  readonly name: string;
  readonly why: string;
}

/**
 * §10's SEP-41 stream — the token view of mints, burns and transfers the vault stream already
 * reports. Missing decoders for these are harmless BY THE SPEC rather than by luck: §10 ends the
 * token-events section with *"an indexer must count one or the other, not both — the SEP-41 stream
 * is the token view, the vault stream is the protocol view."* This module counts the protocol view.
 */
export const SEP41_MIRROR: readonly string[] = ["mint", "burn", "transfer", "approve"];

/**
 * §10 vault and epoch events that move an amount and have **no decoder registered**.
 *
 * Any of these in a run's `skipped` list makes the reconstruction wrong by an unknown quantity, so
 * it refuses instead of producing a total that looks complete. DEV-PROTOCOL §3 splits §10 by the
 * emitting module, so each entry names whose it is to register rather than being fixed here.
 */
export const STATE_AFFECTING_UNDECODED: Readonly<Record<string, string>> = {
  withdraw_requested:
    "DEV1's (vault.rs). `{round, shares}` — whether the shares leave `shares_outstanding` at " +
    "request or at claim is not decidable from §10, and for an instant Idle withdrawal both fire " +
    "in one transaction, so scenario 1's last step cannot be reconstructed without it.",
  withdraw_claimed:
    "DEV1's (vault.rs). `{round, shares, amount}` — the assets actually leaving the vault and the " +
    "shares actually burnt. Without it the withdrawal is invisible to an events-only reader while " +
    "being the step 6a's gate ends on.",
  pending_redeemed: "DEV1's (vault.rs). `{round, amount, shares, pps}` — mints shares at a later price.",
  deposit_cancelled: "DEV1's (vault.rs). `{round, amount}` — returns capital the vault was holding.",
  epoch_lapsed:
    "DEV2's (epoch). `{notional_offered, pps, wclaims}` — a finalization event carrying `pps` and " +
    "a withdrawal-queue credit, so a lapsed round silently drifts an indexer that cannot read it.",
};

/** Split a run's skipped names into what §10 says is harmless and what makes a total wrong. */
export function classifySkipped(skipped: readonly string[]): {
  readonly benign: readonly string[];
  readonly blocking: readonly Unmodelled[];
} {
  const benign: string[] = [];
  const blocking: Unmodelled[] = [];
  for (const name of skipped) {
    if (SEP41_MIRROR.includes(name)) {
      benign.push(name);
    } else if (name in STATE_AFFECTING_UNDECODED) {
      blocking.push({ name, why: STATE_AFFECTING_UNDECODED[name]! });
    } else {
      // Admin and lifecycle events, and anything §10 gained after this was written. Not assumed
      // harmless: an unrecognised name is reported so the list above can be extended deliberately.
      benign.push(name);
    }
  }
  return { benign, blocking };
}

export interface ReconstructedState {
  /** The highest round an `epoch_opened` announced; 0 when none has. */
  readonly round: number;

  // --- current round, reset by every `epoch_opened` ---------------------------------------------
  readonly notionalOffered: bigint;
  /** From the last `bid_filled.notional_sold_after` — the contract's own running total. */
  readonly notionalSold: bigint;
  /**
   * The same quantity summed from each fill's own `notional`.
   *
   * Kept separately so the two can be compared. §10 publishes both a per-fill amount and a running
   * total in the same event; if they ever disagree the event ABI is internally inconsistent, and
   * that is a finding no comparison against `epoch()` would produce — the contract would agree
   * with itself either way.
   */
  readonly notionalSoldSummed: bigint;
  readonly premiumCollected: bigint;
  readonly strike: bigint;
  readonly openTwap: bigint;
  readonly openedAt: number;
  readonly auctionEnd: number;
  readonly expiry: number;
  /** `null` until the round closes; the name of the event that closed it once it has. */
  readonly closedBy: "settled" | "epoch_voided" | "epoch_unresolved" | null;

  // --- cumulative -------------------------------------------------------------------------------
  readonly sharesOutstanding: bigint;
  /** Every transfer in minus every transfer out — see the header's two-balances note. */
  readonly holdings: bigint;
  /** Credited to somebody and not yet claimed. */
  readonly liabilities: bigint;
  /** The `pps` carried by the most recent finalization event; `null` before the first close. */
  readonly lastPps: bigint | null;

  readonly assumptions: readonly Assumption[];
  /** Populated from the caller's `skipped` list — see {@link classifySkipped}. */
  readonly unmodelled: readonly Unmodelled[];
  /** Every event the fold consumed, in order — so a failing diff can be traced to a transaction. */
  readonly consumed: readonly { readonly name: string; readonly txHash: string }[];
}

/**
 * `EpochInfo` fields that events cannot supply, named rather than silently skipped.
 *
 * A diff that quietly omits a field reads as "everything agrees". Each entry below says why the
 * event log cannot produce it, so the omission is a claim somebody can argue with.
 */
export const NOT_RECONSTRUCTIBLE: Readonly<Record<string, string>> = {
  current_premium_bps:
    "a function of the ledger clock, not of any event. `epoch_opened` carries every input the " +
    "decay curve needs (§10 says so deliberately), so it is COMPUTABLE from events plus a " +
    "timestamp — but it is not a stored value the log records, and comparing a locally evaluated " +
    "curve against the contract's belongs in a curve test, not in a state diff.",
  next_open_at:
    "derived from `last_finalize_time + min_idle_gap`. `min_idle_gap` is a parameter, and no event " +
    "in §10 carries `params` except `initialized` and `params_changed`, neither of which is " +
    "registered in the decoder yet.",
  void_available_at: "same shape — `expiry + oracle_dead_after`, and the parameter is not in the stream.",
  locked_assets:
    "no event carries it and none of §10's amounts sum to it. `notional_sold` is what backs the " +
    "sold options, but whether `locked_assets` equals it, exceeds it by a collateral rule, or is " +
    "denominated differently is not decidable from the event ABI — and a reconstruction that " +
    "picked one would be testing its own guess.",
  outcome_pending:
    "a flag about the vault's internal progress through close_round, not an amount. §10 has no " +
    "event for entering or leaving the state.",
  params: "carried only by `initialized` and `params_changed`, neither registered yet.",
  phase:
    "a function of the ledger clock and the last event, so it IS derivable — see `phaseAt`, which " +
    "is kept separate because it needs a time and every field above does not.",
};

/**
 * Phase at a given ledger time, from the event log.
 *
 * Separate from the fold because it is the one answer that changes without an event happening: a
 * round moves from Auction to Active because the clock passed `auction_end`, and nothing is
 * emitted when it does.
 */
export function phaseAt(state: ReconstructedState, ledgerTime: number): "Idle" | "Auction" | "Active" {
  if (state.round === 0 && state.openedAt === 0) return "Idle";
  if (state.closedBy !== null) return "Idle";
  return ledgerTime < state.auctionEnd ? "Auction" : "Active";
}

const EMPTY: ReconstructedState = {
  round: 0,
  notionalOffered: 0n,
  notionalSold: 0n,
  notionalSoldSummed: 0n,
  premiumCollected: 0n,
  strike: 0n,
  openTwap: 0n,
  openedAt: 0,
  auctionEnd: 0,
  expiry: 0,
  closedBy: null,
  sharesOutstanding: 0n,
  holdings: 0n,
  liabilities: 0n,
  lastPps: null,
  assumptions: [],
  unmodelled: [],
  consumed: [],
};

/**
 * Fold a decoded event stream into vault state.
 *
 * `from` is the state to continue from — `undefined` means "from the vault's creation", which is
 * the only starting point that makes the share total meaningful, because D-36's floor is applied
 * at the first mint and cannot be recovered later.
 */
export function reconstruct(
  events: readonly LocatedEvent[],
  skipped: readonly string[] = [],
  from?: ReconstructedState,
): ReconstructedState {
  let s = from ?? EMPTY;
  const assumptions: Assumption[] = [...s.assumptions];
  const consumed: { name: string; txHash: string }[] = [...s.consumed];
  const seenBefore = new Set(s.unmodelled.map((u) => u.name));
  const unmodelled: Unmodelled[] = [
    ...s.unmodelled,
    ...classifySkipped(skipped).blocking.filter((u) => !seenBefore.has(u.name)),
  ];

  const note = (what: string, why: string): void => {
    if (!assumptions.some((a) => a.what === what)) assumptions.push({ what, why });
  };

  for (const { event: e, txHash } of events) {
    consumed.push({ name: e.name, txHash });

    switch (e.name) {
      case "epoch_opened":
        s = {
          ...s,
          round: e.round,
          notionalOffered: e.notionalOffered,
          notionalSold: 0n,
          notionalSoldSummed: 0n,
          premiumCollected: 0n,
          strike: e.strike,
          openTwap: e.openTwap,
          openedAt: e.openedAt,
          auctionEnd: e.auctionEnd,
          expiry: e.expiry,
          closedBy: null,
        };
        break;

      case "bid_filled":
        // Premium is paid in at fill time (§11), so it is a holding immediately and belongs to
        // nobody in particular until the round closes.
        s = {
          ...s,
          notionalSold: e.notionalSoldAfter,
          notionalSoldSummed: s.notionalSoldSummed + e.notional,
          premiumCollected: s.premiumCollected + e.premium,
          holdings: s.holdings + e.premium,
        };
        break;

      case "deposited": {
        // §10: `shares_minted` is 0 for the pending case, and `instant` distinguishes them. The
        // assets arrive either way — a pending deposit is capital the vault is holding, whatever
        // `total_assets()` chooses to call it — so holdings takes the amount in both branches and
        // the two-balances identity absorbs the difference.
        const firstMint = s.sharesOutstanding === 0n && e.sharesMinted > 0n;
        if (firstMint) {
          note(
            `D-36's ${DEAD_SHARES} dead shares, added at the first mint`,
            "No event carries them. Measured on testnet 2026-08-20: `deposited.shares_minted` and " +
              "the SEP-41 `mint` both reported the CREDITED amount, and `epoch().shares_outstanding` " +
              "was higher by exactly this floor. The constant is public, so an outsider can apply " +
              "it — but this line is specification, not observation, and the difference matters " +
              "when the whole point of the run is what an outsider can verify.",
          );
        }
        s = {
          ...s,
          holdings: s.holdings + e.amount,
          sharesOutstanding: s.sharesOutstanding + e.sharesMinted + (firstMint ? DEAD_SHARES : 0n),
        };
        break;
      }

      case "settled":
        // `payout_total` is credited to the fills, not paid; `fee` accrues (D-39). Both become
        // liabilities here and leave holdings only when their claim event fires.
        s = {
          ...s,
          closedBy: "settled",
          lastPps: e.pps,
          liabilities: s.liabilities + e.payoutTotal + e.fee + e.wclaims,
        };
        break;

      case "epoch_voided":
        s = {
          ...s,
          closedBy: "epoch_voided",
          lastPps: e.pps,
          liabilities: s.liabilities + e.premiumRefunded + e.wclaims,
        };
        break;

      case "epoch_unresolved":
        // Premium is RETAINED by depositors rather than credited to anyone, so it creates no
        // liability; the fee does, exactly as the settle branch does (D-64, and §10 says the field
        // exists for precisely this reconciliation).
        s = {
          ...s,
          closedBy: "epoch_unresolved",
          lastPps: e.pps,
          liabilities: s.liabilities + e.fee + e.wclaims,
        };
        break;

      case "fee_accrued":
        // Already counted: `settled.fee` and `epoch_unresolved.fee` carry the same amount, and §10
        // emits this alongside them rather than instead of them. Counting both would double it.
        break;

      case "payout_claimed":
      case "refund_claimed":
        s = { ...s, holdings: s.holdings - e.amount, liabilities: s.liabilities - e.amount };
        break;

      case "fee_claimed":
        s = { ...s, holdings: s.holdings - e.amount, liabilities: s.liabilities - e.amount };
        break;

      case "settle_bounty":
        // Paid to the caller out of the pool (D-44) and never credited first, so it is a transfer
        // out with no liability leg.
        s = { ...s, holdings: s.holdings - e.amount };
        break;

      default: {
        // Exhaustiveness, checked by the compiler rather than at run time: a new entry in
        // `DecodedEvent` fails typecheck here instead of being folded in as a no-op, which is how
        // an indexer starts under-counting without anybody editing it.
        const unreachable: never = e;
        throw new Error(`unhandled decoded event: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return { ...s, assumptions, unmodelled, consumed };
}
