---
title: What you are buying
deck: A cash-settled European call on XLM, paid for with the premium alone and nothing else, ever.
---

You are the counterparty. This section is written for you: what the instrument is, what it costs,
what it pays, and where it can go wrong. Nothing here is a pitch — the economics either work for you
or they do not, and you are better equipped than us to judge that.

> **Status —** Testnet only, unaudited. The only bidder today is an open-source reference bot this
> project operates, labelled as such everywhere it appears. If you are reading this as an
> independent party, **you are the thing this project most needs and does not have.**
> [Where this stands](../start/status.md).

## The instrument

A **cash-settled European call option on XLM**, written by the vault against collateral it already
holds.

- **You pay:** a premium, up front, in XLM. Nothing else, ever.
- **You never post:** `strike × notional`. There is no margin, no collateral requirement, no
  liquidation, and no obligation of any kind after the fill.
- **At expiry:** if `spot > strike`, the vault pays you
  `payout = ⌊notional × (spot − strike) ÷ spot⌋`, in XLM. If `spot ≤ strike`, you get nothing and the
  option expires worthless.
- **Maximum loss:** the premium you paid.
- **Maximum gain:** bounded by `payout < notional` for every possible spot — as spot rises the
  fraction approaches 1 without reaching it.

The deployed vault writes a **three-day** option struck **3 % out of the money**, with the strike
fixed from the feed's TWAP at the moment the round opens.

## Price it as a vanilla call

The XLM-denominated payout converging to `notional` is a real solvency property of the vault — it is
why no margin or liquidation engine exists here. **It is not a pricing discount.**

In USD the payout is

```
notional × (spot − strike)/spot × spot  =  notional × (spot − strike)
```

which is exactly the payoff of a standard call on `notional` XLM struck at `strike`. The numéraire
moves with the cap, so the cap has no effect on value.

*(If you have seen it argued that this payoff should be priced **below** a vanilla call because of
the cap, that argument is wrong, and it is wrong in your favour to notice. The Black-Scholes figures
this project publishes have always assumed the vanilla payoff.)*

## The capital point

Under physical settlement, a counterparty must hold `strike × notional` to write or take the other
side. Here you post the premium alone.

For the deployed vault — struck at 1.03 × spot, so `strike × notional` is 1.03 units of capital per
unit of notional — the ratio of that to what you actually post:

| At | Premium | Capital barrier vs. physical settlement |
|---|---|---|
| The top of the auction curve | 280 bps | **≈ 37× lower** |
| Fair value at σ = 103 % (90-day realized) | ≈ 247 bps | ≈ 42× lower |
| Fair value at σ = 60.2 % (60-day realized) | ≈ 102 bps | ≈ 101× lower |
| The auction reserve | 55 bps | ≈ 187× lower |

Recompute any row as `1.03 ÷ (premium_bps ÷ 10 000)`. The volatilities and the fair values are
derived on [Pricing it yourself](pricing.md); everything else comes from the deployed parameters.

That is the deliberate design choice that makes being a counterparty possible in a thin market at
all. It is also why there is no second leg: no atomic swap, no delivery failure, and no counterparty
credit risk in either direction.

## What the vault will refuse to sell you

**Anything at or in the money.** If the freshest reading shows `spot ≥ strike`, the bid is rejected
with `InTheMoney` — and a bid is also rejected if that check cannot be read at all, with a *different*
code (`OracleUnreachable`), because an outage is not a market signal and the two are counted
separately.

The strike is fixed while the curve descends, so once the option has intrinsic value any fill would
sell that value for at most the curve premium. Refusing is strictly better for depositors, and an
auction that clears empty costs them nothing.

**The cost is yours and it is real: you may show up and find nothing to buy.**

## One auction runs today; five are designed

The design provides for five instances of the same binary side by side, identical except for their
terms, each with its own share token and its own auction:

| | Duration | Strike | |
|---|---|---|---|
| **A** | 7 days | 3 % out of the money | the mainnet-target configuration |
| **B** | 7 days | 5 % | |
| **C** | 3 days | 2 % | nearest to the money |
| **D** | 14 days | 5 % | |
| **E** | 3 days | 3 % | **the one that is deployed** |

The point of five is that one vault answering one set of terms cannot distinguish *"nobody wants to
sell options on XLM"* from *"nobody wants **these** terms"*. Each carries its own premium band, sized
to its own fair value, because a set of terms nobody could profitably fill would test nothing.

**Only `aXLM-E` exists on chain today.** If none of the five would be priced attractively for you,
the useful answer is which one came closest and by how much — see
[Pricing it yourself](pricing.md#what-we-actually-want-from-you).

## Next

- [Bidding, and getting paid](bidding-and-payout.md) — the call, every rejection, the claim, and the
  deadline that can cost you
- [Pricing it yourself](pricing.md) — the measured volatility, the shipped band, and what to check
- [How the premium is discovered](../mechanism/auction.md) — the mechanism in full
