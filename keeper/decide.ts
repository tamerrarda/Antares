/**
 * What the keeper does this pass — decided in one pure function, on purpose.
 *
 * The loop reads `epoch()` and `config()` and calls this. Nothing here touches a network, so every
 * rule below is a unit test rather than an integration test, and the one rule that matters most is
 * enforced by the *type* rather than by care.
 *
 * # D-61, which is the trap in this file
 *
 * `settle`, `void_epoch` and `finalize_unresolved` were collapsed into a single `close_round`
 * **precisely so the caller cannot name the outcome.** The contract dispatches on its own anchored
 * read; the keeper does not simulate to choose between settling, voiding and finalizing, and with
 * that the whole class of "sent the wrong call" and "raced someone into a different path" bugs stops
 * existing.
 *
 * So `Action` has **no** variant that names an outcome. There is no `settle`, no `void`, no
 * `unresolved`. A future edit that wants one has to add it here, in front of this comment, which is
 * the point: the temptation is to look at the oracle first and "help", and helping is the bug.
 *
 * # Everything is idempotent because everything is permissionless
 *
 * D-09 makes `open_epoch` and `close_round` callable by anyone, so the keeper is never the only
 * actor and never the authority. Two consequences the caller has to honour: **re-simulate before
 * every call**, because the state may have moved since this decision; and treat `WrongPhase` as
 * success-noise at debug level, because it means somebody else already did the work. That is the
 * system working, not a failure — counting it as one would trip the alert threshold on a healthy
 * vault with an active community.
 */

/** Phase as `epoch()` reports it — already lazy-resolved by the view, not re-derived here. */
export type Phase = "Idle" | "Auction" | "Active";

/**
 * What `epoch()` returns, narrowed to what a decision needs.
 *
 * `phase` is the **effective** phase: a stored `Auction` past `auction_end` reads `Active` when it
 * sold and `Idle` when it did not, and `views.rs` does that derivation read-only so the keeper and
 * the UI cannot get it subtly different. Reimplementing it here would be the second copy.
 */
export interface EpochView {
  readonly round: number;
  readonly phase: Phase;
  readonly outcomePending: boolean;
  readonly expiry: number;
  readonly nextOpenAt: number;
  readonly epochDuration: number;
  readonly unresolvedAfter: number;
  /**
   * When the current round opened, and when it reached a terminal outcome — `0` while it has not.
   *
   * **No decision reads either of these**, and they are here anyway. The archive needs a round's
   * span to write its record, `epoch()` is the only call that reports it, and the alternative was a
   * second read of the same view through a second interface. `decide` ignoring a field is cheaper
   * than the keeper asking the chain the same question twice per pass.
   */
  readonly openedAt: number;
  readonly lastFinalizeTime: number;
}

export interface VaultConfig {
  readonly paused: boolean;
}

export type Action =
  | { readonly kind: "open_epoch" }
  | { readonly kind: "close_round" }
  | { readonly kind: "wait"; readonly why: string };

/**
 * The dispatch.
 *
 * `paused` gates `open_epoch` and **not** `close_round`, which is I8 rather than an oversight:
 * pause stops new risk being written and never stops a round being closed. A keeper that skipped
 * `close_round` while paused would turn a safety switch into the fund-trapping mechanism it exists
 * to avoid.
 */
export function decide(view: EpochView, config: VaultConfig, now: number): Action {
  if (view.phase === "Active") {
    if (now >= view.expiry) return { kind: "close_round" };
    return { kind: "wait", why: `round ${view.round} expires in ${view.expiry - now}s` };
  }

  if (view.phase === "Idle") {
    if (config.paused) {
      return { kind: "wait", why: "paused — new risk is not written while paused (§16)" };
    }
    if (now >= view.nextOpenAt) return { kind: "open_epoch" };
    return { kind: "wait", why: `idle gap elapses in ${view.nextOpenAt - now}s` };
  }

  // `Auction` before `auction_end`. Nothing to do: bids are DEV3's bidder and the public, and the
  // lazy lapse is resolved by whatever touches the vault next — including the `open_epoch` this
  // function will return once the phase reads `Idle` and the gap has elapsed.
  return { kind: "wait", why: "auction is live" };
}

// ---------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------

export type AlertKind = "expiry_passed_still_active" | "feed_runway_low" | "failure_streak";

export interface Alert {
  readonly kind: AlertKind;
  readonly vault: string;
  readonly message: string;
}

/**
 * How long after expiry a still-`Active` round becomes an alert.
 *
 * **One hour, and deliberately not the reachable bound.** A round left unclosed until its anchor
 * leaves the feed's depth — 20 h 15 m past expiry at shipped values (D-59, D-69) — can no longer
 * settle and finalizes as `Unresolved`. Nobody who could cause the delay profits by it, which is
 * what makes the design survivable; but an **in-the-money bidder loses his payout**, and an alert
 * that fires at the bound fires at the moment the loss becomes unavoidable rather than while it is
 * still preventable. Early on purpose (08-OFFCHAIN §1).
 */
export const EXPIRY_ALERT_AFTER = 3_600;

/**
 * Sponsorship runway below which the feed's expiry becomes an alert.
 *
 * `epoch_duration + unresolved_after` is one whole round — the span `supports_round`'s condition 7
 * requires the feed to outlast — **plus one more epoch**, so the warning arrives with a full round
 * of time to act in.
 *
 * A fixed "< 7 days" threshold is the wrong side of the event: at a 7-day epoch it fires *after*
 * condition 7 has already begun refusing to open rounds (D-68), i.e. after the thing it exists to
 * prevent.
 *
 * At the shipped `unresolved_after` of **75 600 s** (02-CONTRACT-SPEC §1, default and shipped
 * alike) that is **14.875 days on instance A and 28.875 on D**. An earlier version of this comment
 * said 14.85 and 28.85 and attributed them to shipped values; they came from the 73 200 the test
 * used, which the test itself described as *inside condition 3's window* rather than as shipped.
 * The function was right and only the attribution was wrong — which is the same shape as the
 * provisional-close finding: the arithmetic was checked and the input was not.
 */
export function runwayThreshold(view: Pick<EpochView, "epochDuration" | "unresolvedAfter">): number {
  return 2 * view.epochDuration + view.unresolvedAfter;
}

export interface FeedRunway {
  /** `expires(XLM)` on the Reflector contract, or `null` when the feed reports none. */
  readonly expiresAt: number | null;
}

/**
 * Every alert this pass raises. Pure, so the thresholds are testable without a clock or a chain.
 *
 * `failure_streak` is not raised here — it belongs to the caller's `ConsecutiveFailures` counter,
 * which knows about attempts this function cannot see.
 */
export function alerts(vault: string, view: EpochView, feed: FeedRunway, now: number): Alert[] {
  const out: Alert[] = [];

  if (view.phase === "Active" && now >= view.expiry + EXPIRY_ALERT_AFTER) {
    const late = now - view.expiry;
    out.push({
      kind: "expiry_passed_still_active",
      vault,
      message:
        `round ${view.round} expired ${late}s ago and is still Active. The anchored read stops ` +
        `being reachable at expiry + reach_limit, after which the round can only finalize as ` +
        `Unresolved and an in-the-money bidder loses his payout. close_round is permissionless.`,
    });
  }

  const threshold = runwayThreshold(view);
  if (feed.expiresAt === null) {
    out.push({
      kind: "feed_runway_low",
      vault,
      message:
        `the feed reports no expiry at all, which supports_round reads as an unfunded feed and ` +
        `refuses (condition 7). No round can open until it is sponsored.`,
    });
  } else {
    const runway = feed.expiresAt - now;
    if (runway < threshold) {
      out.push({
        kind: "feed_runway_low",
        vault,
        message:
          `feed sponsorship has ${runway}s left against a threshold of ${threshold}s ` +
          `(2 × epoch_duration + unresolved_after). Below one round's span, supports_round's ` +
          `condition 7 begins refusing to open rounds — the alert is early so there is a round's ` +
          `worth of time to sponsor it.`,
      });
    }
  }

  return out;
}
