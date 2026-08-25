---
title: What you give up
deck: The premium is small and certain. What it buys is the part of a rally above the strike — measured in coins, not in percentages.
---

# What you give up

The trade is symmetric and honest: **you earn premium every round, and in exchange you give up the
part of a rally that goes past the strike.** This page is about the second half, because it is the
half that gets soft-pedalled everywhere else.

## In XLM, which is the unit you are counting in

The rest of this site measures your position in XLM, so the cost has to be shown that way too.

**When XLM rallies past the strike, you end the round with fewer XLM than you started with.** Not
"less profit" — fewer coins.

Call the premium **P**. You will know it only after the auction clears, and this project publishes
no forecast of it. The payout does not depend on P at all; it is fixed by the price move alone. On
the deployed vault — three days, struck 3 % out of the money — it is exactly this:

| XLM moves | Coins taken by the payout | **Your coins change by** | If you had just held |
|---|---|---|---|
| −20 % | none | **+P** | same coins, −20 % in USD |
| −10 % | none | **+P** | same coins, −10 % in USD |
| unchanged | none | **+P** | same coins |
| +3 % (the strike) | none | **+P** | same coins, +3 % in USD |
| +5 % | 1.90 % | **P − 1.90 %** | same coins, +5 % in USD |
| +10 % | 6.36 % | **P − 6.36 %** | same coins, +10 % in USD |
| +20 % | 14.17 % | **P − 14.17 %** | same coins, +20 % in USD |
| +50 % | 31.33 % | **P − 31.33 %** | same coins, +50 % in USD |

Every figure in the middle column is `(spot − 1.03) ÷ spot` with `spot` as a multiple of the price
at open. Recompute any of them.

**P is small.** On the deployed vault the auction curve is bounded below by a reserve of **0.55 %**
of notional and above by a start price of **2.80 %**, and an uncontested auction walks toward the
reserve. So from +5 % upward the middle column is negative in every realistic case, and it gets
worse the harder XLM rallies: **at +50 % you hold roughly a third fewer coins than you started
with.**

In dollars you are still ahead of where you began. But you are far behind simply holding — and that
gap is the thing you are selling. The premium is what you are paid for it.

> A depositor who is accumulating XLM and would be unhappy holding fewer of it after a rally should
> not be in this vault, and no premium changes that.

## Three things the table leaves out

Two are small and both are against you:

- **The closing bounty.** Whoever closes the round is paid 25 bps of the premium — 0.25 % of P, not
  of your capital. The contract caps it at 1 % of the premium. It exists so that closing never
  depends on someone being generous, and you can collect it yourself by closing the round.
- **The protocol fee.** It exists in the arithmetic and **ships at zero**. It is capped at 20 % *of
  the premium* — never of your capital — and it is snapshotted when a round opens, so a change can
  never apply to a round you were already in. Any non-zero value requires a separate, publicly
  visible transaction, so the zero is checkable on-chain rather than promised.

The third cuts both ways:

- **A partial fill scales both sides down together.** If the auction sold half the offer, both the
  premium and the payout are halved. An auction that never clears leaves your coins untouched and
  pays you nothing.

## Where another participant's timing costs you

Three places, and the first is the sharpest.

**1. Whoever opens a round sets the strike's basis.** Opening is permissionless, and the strike is
derived from the price at that moment — so a buyer who opens on a dip gets a cheaper option than one
who opens on a rally, at your expense. The feed's guards bound how far the basis can stray from the
market (a short window is compared against a longer one of the same moment, and a divergence past
1 % refuses the open), but not to zero.

**2. A new round can open before your instant exit lands.** Anyone can open a round as soon as the
idle gap has passed. `require_idle = true` on the withdrawal turns that into a harmless revert
instead of a multi-day queue — see [Getting your money out](withdrawing.md).

**3. Anyone may end an idle window** the moment it reaches its minimum width.

**And one that is structural rather than about timing: adverse selection.** A bidder who reads the
auction curve against fair value gains at depositors' expense. The auction's reserve bounds this to
under-fair *time value* — the in-the-money guard prevents selling intrinsic value outright — but a
mechanism that cannot see volatility cannot eliminate it. It is listed as a residual risk rather
than argued away.

## Rounds that end without a payout to the buyer

All three are normal, defined outcomes, and none of them costs you anything.

- **Nobody bid (lapsed).** No option sold, no premium earned, collateral never moved, share price
  unchanged. **This resolves 45 minutes into the round**, not at the end of it, so your money is
  free again the same hour rather than three days later. In a thin market this will happen, and it
  is honest to expect it.
- **The round was annulled (voided).** The price feed was unusable at expiry past a defined limit,
  so the round is cancelled: buyers are refunded exactly, no payout is made, share price is
  unchanged. Cancellation is permissionless, so nobody is trapped by it — including you.
- **Nobody closed it in time (unresolved).** The premium stays with the pool and the payout is
  zero. For you this is the same as a round that expired below the strike. It is written that way on
  purpose: any rule that refunded the buyer instead would pay them to wait. The full reasoning,
  including the one asymmetry that survives it, is on
  [The four ways a round ends](../mechanism/round-outcomes.md#why-unresolved-keeps-the-premium-rather-than-refunding-it).

## Why there are no yield numbers

You will not find an APY here, an expected return, or a projection. While the only buyer is a bot
this project operates, any premium figure would be us paying ourselves and then quoting the result —
the number would travel and its disclaimer would not.

The policy has a published exit condition so that it cannot quietly become an excuse. Once an
address outside this project clears an auction, realized premium is published as **raw basis points
per round**, always shown beside how many recent rounds cleared with no buyer at all, and the payout
that followed. Facts with their misses attached. Annualized figures, projections and expected-yield
numbers stay off the table permanently.

## The rest of the risks

This page is about the cost of the trade when everything works. Everything that can go wrong is on
[Risks, stated plainly](../trust/risks.md) — starting with the largest by a wide margin, which is
that the code is unaudited.
