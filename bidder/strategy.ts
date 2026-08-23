/**
 * What the bidder does this pass — one pure function, for the same reason `keeper/decide.ts` is one.
 *
 * Nothing here touches a network, so every rule below is a unit test rather than an integration
 * test. `vault.ts` supplies the view and executes the decision; this file decides.
 *
 * # The strategy seam, and what v1 deliberately is not
 *
 * 08-OFFCHAIN §2 asks for a **naive** v1 and says so in the open: it does not estimate volatility,
 * it does not price the option, and it has no opinion about whether the premium on offer is a good
 * one. It buys at or below a number a human put in a config file. That is not a placeholder for a
 * model — it is the honest description of what a self-operated reference bidder can claim, and the
 * README carries the same sentence where a user will read it.
 *
 * The seam is `Strategy`: one method, pure, from the auction's public state to a bps number. An
 * independent party plugging real pricing in replaces that method and nothing else. Keeping the
 * risk caps *outside* the strategy is deliberate — a strategy that could raise its own position
 * limit is a strategy that can lose more than its operator agreed to.
 *
 * # Why the curve is not re-derived here
 *
 * `EpochInfo.current_premium_bps` is the contract's own curve evaluated at `now`, and 02's view
 * comment says why it exists: so the keeper and the UI do not each reimplement the decay and get it
 * subtly different. A bidder computing its own would be the third copy, and the one with money on
 * it. The same argument covers `phase`, which the view has already lazy-resolved.
 *
 * # Bidding is a race and the contract is the referee
 *
 * The decision below can be stale by the time it lands — the curve keeps falling and other bidders
 * keep filling. Two things make that safe rather than merely likely-to-work. `max_premium_bps` is
 * the bidder's **own** argument, identical at simulation and execution (D-84), so no price it did
 * not name can be charged to it. And a fill that no longer fits is refused by the contract, not
 * silently truncated. So this file aims at the common case and lets the chain reject the rest,
 * which is why every rule here is a *reason not to send* rather than a promise about what happens.
 */

/** Phase as `epoch()` reports it — already lazy-resolved by the view, not re-derived here. */
export type Phase = "Idle" | "Auction" | "Active";

/** What `epoch()` returns, narrowed to what a bid decision needs. */
export interface AuctionView {
  readonly round: number;
  readonly phase: Phase;
  /** The contract's curve at `now`. Zero outside the auction window — see `premium_bps`. */
  readonly currentPremiumBps: number;
  readonly notionalOffered: bigint;
  readonly notionalSold: bigint;
  /** From the round's own `params` snapshot, not from `Config` — the round is governed by its own. */
  readonly minFill: bigint;
}

/** The operator's limits. Read from the environment once and never written by a strategy. */
export interface RiskCaps {
  /** Most notional to take in any single round. */
  readonly maxNotional: bigint;
  /** Most notional to hold across every round that has not paid out yet. */
  readonly maxPortfolioNotional: bigint;
}

/** What this bidder is already carrying, from its own record of unclaimed fills. */
export interface Portfolio {
  readonly openNotional: bigint;
}

/**
 * The pricing seam. One method, pure, and the only thing an independent implementation replaces.
 *
 * It returns the premium in bps **at or below which this strategy will buy**, so a lower number is
 * a more patient bidder. It cannot see the risk caps and cannot change them.
 */
export interface Strategy {
  readonly name: string;
  targetBps(view: AuctionView): number;
}

/**
 * v1: a constant from config.
 *
 * Named `flat` rather than `default` because the name is what appears in the log line, and a reader
 * seeing `strategy=flat` should not have to look anything up to know that no model produced it.
 */
export function flatStrategy(targetBps: number): Strategy {
  return { name: "flat", targetBps: () => targetBps };
}

export type Decision =
  | { readonly kind: "wait"; readonly why: string }
  | { readonly kind: "bid"; readonly notional: bigint; readonly maxPremiumBps: number };

const wait = (why: string): Decision => ({ kind: "wait", why });
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Whether to bid this pass, and for how much.
 *
 * `allowed` is the bidder's own allowlist status, already read — `false` only when the allowlist is
 * enabled *and* this address is not on it. 08-OFFCHAIN §2 requires the refusal to be the bidder's
 * own, not the contract's: sending a bid that is certain to revert spends a fee to learn something
 * a read already said.
 */
export function decide(
  view: AuctionView,
  caps: RiskCaps,
  portfolio: Portfolio,
  strategy: Strategy,
  allowed: boolean,
): Decision {
  if (!allowed) return wait("not on the allowlist while it is enabled");
  if (view.phase !== "Auction") return wait(`phase is ${view.phase}, not Auction`);

  // Zero means the window is closed — `premium_bps` returns 0 outside it. It is also the one rate
  // that can never produce a fill even inside the window, because the contract refuses a fill whose
  // premium rounds to nothing (`ZeroPremium`). Both readings say the same thing: do not send.
  if (view.currentPremiumBps === 0) return wait("the auction window is closed");

  const target = strategy.targetBps(view);
  // The curve descends, so this is patience rather than rejection: the rate on offer is still above
  // what this strategy will pay, and waiting costs nothing but the risk that somebody else fills it.
  if (view.currentPremiumBps > target) {
    return wait(`curve at ${view.currentPremiumBps} bps is above the ${target} bps target`);
  }

  const remaining = view.notionalOffered - view.notionalSold;
  if (remaining <= 0n) return wait("the round is fully sold");

  const headroom = caps.maxPortfolioNotional - portfolio.openNotional;
  if (headroom <= 0n) return wait("the portfolio cap is reached");

  const size = min(min(caps.maxNotional, remaining), headroom);

  // The sliver exception, from the contract's side of it: a fill below `min_fill` is refused unless
  // it takes the whole remainder. So a cap that lands us under the floor is only biddable when what
  // is left is under the floor too and we are taking all of it.
  if (size < view.minFill && size !== remaining) {
    return wait(`${size} is below the ${view.minFill} minimum fill and would not clear the round`);
  }

  return { kind: "bid", notional: size, maxPremiumBps: target };
}
