---
title: What a covered call is
deck: The trade itself, explained for someone who has never traded an option.
---

This page assumes nothing. It is about the trade, not about Antares — everything here would be true
of a covered call sold anywhere. If you already trade options, skip to
[One round, end to end](../mechanism/round-lifecycle.md).

## 1. The trade

A **call option** is the right, but not the obligation, to buy something at a fixed price on a
fixed date. The fixed price is the **strike**. The date is the **expiry**. Whoever wants that right
pays for it up front, and the payment is the **premium**.

Selling a call against XLM you already hold is a **covered call**. Covered means the thing you
would owe is already in your possession — you are not borrowing anything, and you are not promising
to find XLM later.

So:

- You hold XLM.
- You sell someone the right to buy it at a price above where it trades today.
- They pay you the premium now, and it is yours whether or not they ever use the right.
- If XLM ends up above the strike, the right is worth something and you pay out. If it ends below,
  the right expires worthless and you keep everything.

## 2. The analogy, if it helps

You are selling insurance on an upward move. The buyer pays you a fixed amount every round for a
payout that only happens if XLM rises past an agreed line. Most rounds the line is not crossed and
you simply keep the payment. When it is crossed, you pay — but you agreed to the line in advance,
and you still keep the payment.

Like any insurer, you are paid for taking a risk that is real. The premium is not free money; it is
the price of the risk.

## 3. The two outcomes, spelled out

The vault's strike sits **3 % above** the price when the round opens, and the round runs for
**three days** ([the shipped parameters](../reference/deployment.md#parameters)).

**XLM finishes at or below the strike.** The option expires worthless. The pool keeps all of its
XLM *and* the premium. This is the base case and the one the strategy is built around.

**XLM finishes above the strike.** The option is worth the amount by which XLM exceeded the strike,
and the pool pays it — in XLM, out of its own collateral. There is no second transaction and nothing
to deliver; the difference is simply deducted. The depositors still keep the premium.

That second case is the whole cost of the trade, and it is worth being concrete about, because it
is not "less profit" — it is fewer coins. [What you give up](../depositor/what-you-give-up.md)
puts numbers on it.

## 4. Why the strike sits so close

Three per cent sounds tight. It is chosen, not tuned quietly.

An option's value comes from the chance it finishes in the money. Struck far away it is worth almost
nothing, so nobody buys it and the vault earns nothing. Struck close, it is worth buying — and the
cost is that your upside stops sooner.

XLM's own volatility is what decides where that line falls. Measured from daily closes through
2026-08-22: **65.1 % annualized over 30 days, 60.2 % over 60, and 103.0 % over 90**
([how this is measured](../bidder/pricing.md#the-volatility-this-is-sized-against)). At those
levels a three-day option struck 3 % away is worth roughly 1.0 % to 2.5 % of the notional, which is
enough for the auction to have something to discover. Struck **10 %** away the same option is worth
**0.09 %** at the calmer measure and **0.78 %** at the more volatile one — a tenth and a third of
what the 3 % strike fetches. A covered call that never sells is not a conservative version of this
product; it is a vault that does nothing.

## 5. What "cash-settled" means here, and why it matters

Most option contracts settle by delivery: the buyer hands over `strike × quantity` and receives the
asset. Antares does not do that. It settles in **cash** — meaning in XLM, the same asset the vault
already holds — by paying the difference:

```
payout = notional_sold × (spot − strike) ÷ spot
```

Two consequences follow, and both are load-bearing:

- **The buyer never has to hold `strike × notional`.** They pay the premium and nothing else, ever.
  That is what makes being a counterparty possible in a market this thin.
- **The vault can never owe more than it holds.** As the price rises, `(spot − strike) ÷ spot`
  approaches 1 but never reaches it, so the payout is always strictly less than the notional
  backing it. No margin call, no liquidation, no bad debt — the bound is arithmetic.

[How a round is settled](../mechanism/settlement.md) works this through with numbers.

## 6. The words you will meet

| Term | Meaning |
|---|---|
| **Strike** | The price above which the buyer's option pays. Fixed when the round opens, 3 % above the market price. |
| **Premium** | What the buyer pays up front. It goes to depositors, and it is theirs regardless of the outcome. |
| **Notional** | The amount of XLM the option is written against. |
| **Round / epoch** | One full cycle: the vault sells an option, it runs to expiry, the result is recorded. |
| **Out of the money** | The option is not currently worth exercising — XLM is below the strike. |
| **In the money** | XLM is above the strike, so the option has value. |
| **Cash-settled** | The option pays a difference in XLM rather than delivering the asset. |

The full list, including the Antares-specific terms, is in the
[glossary](../reference/glossary.md).
