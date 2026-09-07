/**
 * The one place `events-source.ts` and `archive.ts` meet, and the only thing that knows a pass
 * happened.
 *
 * `archive.ts` is pure over `Located[]`; `events-source.ts` is the fetch. Neither can write
 * evidence on its own and neither should know about the other, so the sequencing lives here for
 * the reason `runner.ts` gives for its own thinness: what has a rule in it belongs where a unit
 * test can reach it without a chain.
 *
 * # This module existed as unreachable code for two weeks, and four rounds were lost to that
 *
 * `archive.ts` shipped 2026-08-1x with a header saying it *"has to be running when the mechanism
 * first runs"*, and nothing ever imported it outside its own tests. Four rounds closed on testnet
 * — E's two, C's and A's — and by the time anyone looked, RPC's ~7-day event window had dropped
 * every `epoch_opened` and `Filled` among them: the fills landed in ledgers 4 369 890 / 4 377 736 /
 * 4 377 737 against a retention floor that had moved to 4 387 212. Horizon does not rescue it
 * either; it no longer serves `result_meta_xdr`, so the calls survive and the events they emitted
 * do not. **A module that is correct and unreferenced is worth exactly nothing**, and the gap that
 * proves it is permanent.
 *
 * # Two rules, and both are refusals
 *
 * **Start at the horizon, never before it.** A first pass asks for `oldestLedger`, not for the
 * vault's deployment. Asking for anything older reports a real shortfall that is nonetheless not
 * *this* round's, and `Working.missedLedgers` accumulates and never resets — so one late start
 * would stamp `complete: false` on every record the keeper ever writes afterwards, including
 * rounds it watched in full. The lost history is named in the decision log, which is where a fact
 * about the project belongs, rather than in the gap field of rounds it does not describe.
 *
 * **Finalize only a round whose opening was seen.** The bucket must hold this round's
 * `epoch_opened` before anything is written. Without that guard the settlements still inside the
 * window would each produce a record for a round whose auction nobody observed — and it would
 * carry `complete: true`, because nothing was *requested* and missed. That is the precise
 * fabrication `finalize`'s own error refuses when the bucket is empty; a bucket holding only the
 * ending is the same lie with one event in it.
 */

import { hasRound, isTerminal } from "@antares/common/events";

import { finalize, observe, type WorkingStore } from "./archive.ts";
import type { EpochView } from "./decide.ts";
import type { SigmaEvidence } from "./evidence.ts";
import { fetchSince, type RpcLike } from "./events-source.ts";

export interface ArchivistDeps {
  readonly rpc: RpcLike;
  readonly store: WorkingStore;
  /** Where `evidence/<date>-<network>.json` is written. */
  readonly root: string;
  readonly network: string;
  /**
   * σ_realized for a closed round, or `null`.
   *
   * **`null` means "not computed", never "computed and absent"**, and today it is always `null`:
   * the feed reaches back 255 ticks — about 21 hours — against a round of 3 to 14 days, so σ over a
   * round cannot be recovered at its close any more than its events can. It has to be sampled
   * forward while the round runs, which is the same shape as this module and is not yet built.
   * Injected rather than hardcoded so that when it is, nothing here changes.
   */
  readonly sigma?: (view: EpochView) => Promise<SigmaEvidence | null>;
}

export interface Archivist {
  /** Fold everything the chain has emitted since the last pass into the working state. */
  collect(vaultId: string): Promise<void>;
  /** Write the round's record if it has closed and was watched from its opening. */
  close(vaultId: string, view: EpochView): Promise<string | null>;
}

/**
 * True when the vault is between rounds and has closed at least one.
 *
 * **This is a necessary condition and not a sufficient one**, which is the correction it carries.
 * It first read as "`view.round` is over", and `lastFinalizeTime` does not say that: it belongs to
 * whichever round finalized last, not to the one `view.round` names. A round that opens and then
 * **lapses lazily** produces exactly the state that breaks the reading — phase `Idle`, the new
 * round's number, and the *previous* round's finalize time — and both live instances sat in it for
 * ten hours on 2026-09-07, warning on every pass.
 *
 * Nothing wrong was written, because `terminalOf` refuses a round with no terminal event and that
 * is what the bucket check below now asks for first. But a guard that only holds because a deeper
 * one caught it is a guard reporting a failure on a healthy vault, and D-92 is the entry about what
 * a channel of false alarms costs.
 *
 * `Phase` collapses Settled/Lapsed/Voided into `Idle` — `views.rs` resolves the effective phase and
 * the keeper does not re-derive it (D-09's second copy).
 */
export function closed(view: EpochView): boolean {
  return view.phase === "Idle" && view.lastFinalizeTime > 0;
}

export function makeArchivist(deps: ArchivistDeps): Archivist {
  return {
    async collect(vaultId: string): Promise<void> {
      const held = deps.store.load(vaultId);
      // `"oldest"` rather than a number we read ourselves: `fetchSince` already has the health
      // response in hand, and a second read of a moving floor reports the ledgers that closed in
      // between as lost history. See its own comment — this was measured, not anticipated.
      const from = held.cursor === null ? { startLedger: "oldest" as const } : { cursor: held.cursor };
      const page = await fetchSince(deps.rpc, [vaultId], from);
      deps.store.save(vaultId, observe(held, page.events, page.cursor, page.missedLedgers, page.skipped));
    },

    async close(vaultId: string, view: EpochView): Promise<string | null> {
      if (!closed(view)) return null;
      const held = deps.store.load(vaultId);
      const bucket = held.rounds[String(view.round)];
      if (bucket === undefined) return null;
      const sawOpening = bucket.some(
        (l) => l.event.name === "epoch_opened" && hasRound(l.event) && l.event.round === view.round,
      );
      if (!sawOpening) return null;
      // **The round's own ending, asked for here rather than discovered as an exception.** A lapse
      // is resolved lazily, so a round can sit finished-but-unfinalized for as long as nobody
      // calls in — `Idle`, carrying its own number and the *previous* round's finalize time. Until
      // its terminal event is actually on chain there is nothing to record, and that is a normal
      // state of a healthy vault rather than a failure of this pass. `terminalOf` still refuses,
      // and still should: it is the check that cannot be skipped, this is the one that keeps a
      // waiting vault quiet.
      if (!bucket.some((l) => isTerminal(l.event))) return null;

      const { path } = finalize(deps.root, deps.store, {
        vault: vaultId,
        network: deps.network,
        round: view.round,
        openedAt: view.openedAt,
        expiry: view.expiry,
        closedAt: view.lastFinalizeTime,
        sigmaRealized: deps.sigma === undefined ? null : await deps.sigma(view),
      });
      return path;
    },
  };
}
