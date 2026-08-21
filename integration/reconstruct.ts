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
 * **Narrowed 2026-08-20 by dev1@29a33d9, and the narrowing is the interesting part.** The dead
 * shares now emit their own SEP-41 `mint` to the vault address, so they ARE observable — in the
 * **token** stream. `deposited.shares_minted` still carries `credited`, deliberately: §10's shapes
 * are frozen, an added field breaks every decoder while an added event is what consumers already
 * dispatch on by name.
 *
 * The consequence is worth stating precisely rather than calling the matter closed. §10 says *"an
 * indexer must count one or the other, not both — the SEP-41 stream is the token view, the vault
 * stream is the protocol view."* After the fix those two are no longer interchangeable **for share
 * supply**: the token view sums to the real total with no constant, and the protocol view — the one
 * this module counts, because every other quantity it needs lives there — is still short by exactly
 * this floor. A residual, not a defect: the fix chose the stream that could carry it without
 * breaking the frozen shapes, which was the right trade.
 *
 * So the constant is still applied here, and still declared. Applying a documented number is a
 * strictly weaker claim than reading one off the chain, and {@link ReconstructedState.assumptions}
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
export const STATE_AFFECTING_UNDECODED: Readonly<Record<string, string>> = {};

// The list is EMPTY, and that is a measurement rather than a hope: of the 36 events the contract
// emits, 15 decode, and every one of the remaining 21 is either the SEP-41 mirror above or an
// admin/lifecycle event that moves no amount. `withdraw_requested`, `withdraw_claimed`,
// `pending_redeemed` and `deposit_cancelled` came off on 2026-08-20 (dev1@29a33d9); `epoch_lapsed`
// came off on 2026-08-21, and it was the last. The mechanism stays because §10 can gain an event
// tomorrow — an unrecognised name still lands in `benign` and gets reported, so putting one back on
// this list is a deliberate act rather than a discovery made after a total came out wrong.

/**
 * Split a run's skipped names into what §10 says is harmless and what makes a total wrong.
 *
 * `undecoded` is the table, supplied as data so the refusal path can be exercised. With the real
 * table empty there is no event name left that triggers it, and a mechanism that only runs on the
 * day somebody forgets to write a decoder is exactly the one that must not be allowed to rot.
 */
export function classifySkipped(
  skipped: readonly string[],
  undecoded: Readonly<Record<string, string>> = STATE_AFFECTING_UNDECODED,
): {
  readonly benign: readonly string[];
  readonly blocking: readonly Unmodelled[];
} {
  const benign: string[] = [];
  const blocking: Unmodelled[] = [];
  for (const name of skipped) {
    if (SEP41_MIRROR.includes(name)) {
      benign.push(name);
    } else if (name in undecoded) {
      blocking.push({ name, why: undecoded[name]! });
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
  readonly closedBy: "settled" | "epoch_voided" | "epoch_unresolved" | "epoch_lapsed" | null;

  // --- cumulative -------------------------------------------------------------------------------
  readonly sharesOutstanding: bigint;
  /** Every transfer in minus every transfer out — see the header's two-balances note. */
  readonly holdings: bigint;
  /** Credited to somebody and not yet claimed. */
  readonly liabilities: bigint;
  /**
   * Premium taken in by a round that has not closed yet.
   *
   * **Held, but belonging to nobody.** Until the round finalizes it is not decided whether the
   * premium goes to depositors (settle, lapse, unresolved) or back to the bidders (void), so it is
   * neither vault assets nor a credit to a named party. `total_assets()` excludes it, measured on
   * testnet 2026-08-21: the diff was over by exactly the open round's `premium_collected`, 5 237 068
   * stroops, and nothing else.
   */
  readonly unsettledPremium: bigint;
  /**
   * Withdrawal-queue credits from finalization that have not been claimed.
   *
   * Tracked separately from {@link liabilities} because a `withdraw_claimed` must discharge a credit
   * only if one exists. An **instant Idle** withdrawal never entered the queue — nothing credited it
   * — so discharging on every claim drove liabilities NEGATIVE by the whole withdrawn amount, which
   * is how the deploy's own smoke round trip put this reconstruction 9 999 000 stroops out.
   */
  readonly wclaimsOutstanding: bigint;
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
  unsettledPremium: 0n,
  wclaimsOutstanding: 0n,
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
        // Premium is paid in at fill time (§11), so it is a holding immediately — and it belongs to
        // nobody in particular until the round closes, which is why it is also carried as unsettled.
        s = {
          ...s,
          notionalSold: e.notionalSoldAfter,
          notionalSoldSummed: s.notionalSoldSummed + e.notional,
          premiumCollected: s.premiumCollected + e.premium,
          holdings: s.holdings + e.premium,
          unsettledPremium: s.unsettledPremium + e.premium,
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
            "Not carried by the PROTOCOL stream this module counts. Since dev1@29a33d9 they are " +
              "carried by the TOKEN stream — a second SEP-41 `mint` to the vault address — so an " +
              "indexer counting mint/burn needs no constant at all, while one counting " +
              "deposited/withdraw_claimed is short by exactly this floor. §10 says to count one " +
              "stream or the other; for share supply they stopped being interchangeable on that " +
              "commit. This line is specification, not observation, and the difference matters " +
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

      case "withdraw_requested":
        // Deliberately moves nothing. `withdraw_claimed` carries the same `shares` AND the assets,
        // and for an instant Idle withdrawal §10 emits both in one transaction — so subtracting at
        // both would double-count. Which of the two actually burns is recorded as an assumption
        // rather than decided here; see below.
        note(
          "shares leave the supply at withdraw_claimed rather than at withdraw_requested",
          "§10 gives both events the same `shares`, and an instant Idle withdrawal emits them in " +
            "ONE transaction, so scenario 1 cannot tell the two attributions apart — every total " +
            "comes out identical either way. A QUEUED withdrawal separates them by a whole round " +
            "and would decide it; until one is observed this is a choice, not a measurement. It is " +
            "attributed to the claim because that is the event carrying `amount`, and the SEP-41 " +
            "`burn` rides with it.",
        );
        break;

      case "withdraw_claimed": {
        // Discharges a queue credit ONLY as far as one exists. An instant Idle withdrawal never
        // entered the queue, so there is nothing to discharge and the assets simply leave — which
        // the first version of this got wrong, taking liabilities negative by the whole amount.
        const discharged = e.amount < s.wclaimsOutstanding ? e.amount : s.wclaimsOutstanding;
        s = {
          ...s,
          holdings: s.holdings - e.amount,
          liabilities: s.liabilities - discharged,
          wclaimsOutstanding: s.wclaimsOutstanding - discharged,
          sharesOutstanding: s.sharesOutstanding - e.shares,
        };
        break;
      }

      case "pending_redeemed":
        // The capital arrived at `deposited` and was counted then; this is the mint that was
        // deferred to a later price (D-18), so only the share side moves.
        s = { ...s, sharesOutstanding: s.sharesOutstanding + e.shares };
        break;

      case "deposit_cancelled":
        // Capital the vault was holding, returned. It never minted, so no share leg.
        s = { ...s, holdings: s.holdings - e.amount };
        break;

      case "settled":
        // `payout_total` is credited to the fills, not paid; `fee` accrues (D-39). Both become
        // liabilities here and leave holdings only when their claim event fires.
        s = {
          ...s,
          closedBy: "settled",
          lastPps: e.pps,
          liabilities: s.liabilities + e.payoutTotal + e.fee + e.wclaims,
          wclaimsOutstanding: s.wclaimsOutstanding + e.wclaims,
          // Released to depositors — it is vault assets from this instant.
          unsettledPremium: 0n,
        };
        break;

      case "epoch_voided":
        s = {
          ...s,
          closedBy: "epoch_voided",
          lastPps: e.pps,
          // The premium does not become vault assets on this branch — it becomes a debt to the
          // bidders. Cleared as unsettled and re-entered as a named credit, so it never double-counts.
          liabilities: s.liabilities + e.premiumRefunded + e.wclaims,
          wclaimsOutstanding: s.wclaimsOutstanding + e.wclaims,
          unsettledPremium: 0n,
        };
        break;

      case "epoch_lapsed":
        // The empty auction. `lazy_finalize` only takes this branch when `notional_sold == 0`, so
        // there is no payout, no fee and no premium: the only money that moves is the withdrawal
        // queue's credit. `unsettledPremium` is cleared for the same reason the siblings clear it —
        // not because a lapse releases premium, but because a lapsed round never took any, and
        // leaving a stale figure from an earlier round would be worse than a redundant zero.
        s = {
          ...s,
          closedBy: "epoch_lapsed",
          lastPps: e.pps,
          liabilities: s.liabilities + e.wclaims,
          wclaimsOutstanding: s.wclaimsOutstanding + e.wclaims,
          unsettledPremium: 0n,
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
          wclaimsOutstanding: s.wclaimsOutstanding + e.wclaims,
          unsettledPremium: 0n,
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
