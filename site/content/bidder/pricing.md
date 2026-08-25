---
title: Pricing it yourself
deck: No expected returns, no APY, no forecasts. Here is the mechanism, the measured volatility, and the arithmetic to check the curve against your own model.
---

# Pricing it yourself

This project publishes **no expected returns, no APY, and no premium forecasts** — for you or for
depositors. What it publishes is the mechanism and the raw on-chain facts.

To price a round you need `strike_bps_otm`, `epoch_duration`, spot, and your own volatility view.
Everything below is the arithmetic this project uses on itself, published so that you can disagree
with it precisely.

## The volatility this is sized against

**Measured, never assumed.** The estimator, in full:

- Daily XLM/USDT closes, 91 of them covering **2026-05-24 to 2026-08-22**, committed to the
  repository as `deployments/xlm-price-series.json` — which records its own source and the exact
  endpoint the series was fetched from, so the input is reproducible rather than described.
- Log returns, **sample** standard deviation, annualized by `√365`.

| Window | Realized volatility |
|---|---|
| 30 days | **65.1 %** |
| 60 days | **60.2 %** ← σ_low |
| 90 days | **103.0 %** ← σ_high |

Recompute it from the committed series; the estimator is a twenty-line function in
`scripts/check-params.ts`, and the file refuses a series whose declared cadence is not daily rather
than silently rescaling it.

**This is not the same quantity as the per-round realized volatility** that the
[Phase 2 clearing gate](../start/why-antares.md#the-roadmap-and-what-each-gate-demands) is measured
against. That one is five-minute log returns of the price feed the round settles against, in
population form, over a single round. This one judges whether a parameter set is coherent at deploy
time. A number from one is not evidence about the other, and this project publishes the exact
definition of both so a third party can recompute the gate rather than trust it.

## Fair value, and where the curve sits relative to it

Black-Scholes on the call the vault writes, with `r = 0` — the position is XLM-denominated
collateral against an XLM-denominated strike, so there is no financing leg to discount. Because the
strike is `spot × (1 + otm)`, spot cancels and the answer depends only on the offset, the horizon
and σ. So it can be stated in basis points of notional without a price at all.

For the deployed vault — **three days, 3 % out of the money, auction band [55, 280] bps over
45 minutes**:

| σ | Fair value | Curve crosses fair value at | Economically live tail |
|---|---|---|---|
| 60.2 % (60-day) | 102 bps | minute 35.5 | **9.5 minutes** |
| 65.1 % (30-day) | 118 bps | minute 32.3 | **12.7 minutes** |
| 103.0 % (90-day) | 247 bps | minute 6.7 | **38.3 minutes** |

The crossing point is `(280 − fair) ÷ 225 × 45` minutes, from the linear decay. A rational buyer
does not bid while the curve sits above fair value, so the tail is the part of the window you would
actually want. Either way it is wide enough for a person to act in.

### The earlier answer stays on the page

Until 2026-08-24 the repository's own bidder guide reported a live tail of **two to four minutes**
and concluded the auction favoured a bot. That was true of the premium bands as they then stood —
sized against an *assumed* σ of 33.7 % rather than a measured one. When σ was measured it came back
at 103 %, every parameter set failed its coherence gate, the bands were raised, and the crossing
moved with them.

The superseded finding is recorded rather than deleted. A document that quietly drops the claim it
used to argue from is not one you should trust the rest of.

### The curve's shape

Linear stays for this build, because it is integer-exact and is therefore the only shape the
differential verification suite can check byte for byte without new machinery. A **geometric** curve
is on record as the designated successor, and against the shipped band it would widen the live tail
like this:

| σ | Linear tail | Geometric tail | |
|---|---|---|---|
| 60.2 % | 9.5 min | **17.2 min** | 1.81× |
| 65.1 % | 12.7 min | **21.2 min** | 1.67× |
| 103.0 % | 38.3 min | **41.5 min** | 1.08× |

`p(t) = start × (floor ÷ start)^(t ÷ duration)`, crossing fair value at
`t = duration × ln(fair ÷ start) ÷ ln(floor ÷ start)`. The gain is largest exactly where the linear
tail is shortest — in a calm market, which is when a short window would actually deter you. What
promotes the change is evidence, not mood:

> **If the window is the reason you would not participate, saying so is the named trigger** for
> making that change before any mainnet parameters are frozen.

## The gates every parameter set has to pass

A vault whose band cannot contain the option's fair value tests nothing. These are checked at deploy
time against σ measured on the day, and a failure refuses the deploy:

| Gate | Rule | The deployed vault |
|---|---|---|
| 1 | `premium_start_bps ≥ fair(σ_high)` | 280 vs 247 — the start sits 13.5 % above fair value at σ_high, so a normal move in σ does not refuse the set overnight |
| 2 | `premium_floor_bps ≥ fair(σ_low) ÷ 2` | 55 vs 51.2 |
| 3 | `max_deviation_bps < strike_bps_otm ÷ 2` | 100 vs 150 — the breaker is tuned to the strike, never the reverse |
| 4 | `fair(σ_high) ÷ fair(σ_low) ≤ start ÷ floor` | 2.41 vs 5.09 — the band has to be able to span the regime at all |
| 5 | `1.30 × premium_floor_bps ≤ 0.75 × fair(σ_low)` | 71.5 vs 76.8 |

Gates 2 and 5 together put the reserve inside a window about 15 % wide, so **the floor is not a
choice.** Raising it makes the option dearer at the end of the auction and so bears directly on
whether anyone bids; that is a trade the gate forces rather than one it hides.

## The reference bidder, and why its fills are not evidence

The open-source reference bidder in `bidder/` is **deliberately naive**: it targets a configured
premium in basis points and does not model volatility. It exists to test the mechanism, not to set a
price. It announces that it is self-operated in its first line and prints it at startup.

**Do not treat its fills as market evidence. We do not.**

## What we actually want from you

Findings, refusals and *"your parameters are wrong"* are more valuable to this project than fills.

If our number is wrong, **"I'd want 200 bps for that, not 55"** is worth more than a fill — and it
is the finding we would publish. If you looked at this and decided not to bid, the reason is the most
useful thing you could send us.

### And if you do bid on testnet

The XLM is free; **the prices are not.** The strike comes from the live XLM/USD feed, settlement uses
the real price path, and the parameters were derived from XLM's measured realized volatility. The
option you are pricing is the option this project intends to sell for real money, at the size it
intends to sell it — the vault is capped at 100 000 XLM, about $19 600 of notional at XLM's price on
2026-08-22.

What is useful is therefore **a decision you would stand behind with your own capital.** A fill
placed casually because the tokens are free tells us nothing and, worse, tells us something false.

## The hardest fact about being a counterparty here

**There is no liquid venue to hedge vega.** XLM futures and perpetuals exist, so delta hedging is
possible. XLM options do not trade on a major venue, so you cannot lay off volatility risk.

That is the single hardest fact about this position, and it is why this project treats counterparty
discovery as an open question rather than as an assumption. Every other risk is on
[Risks, stated plainly](../trust/risks.md).

## Tools

- `scripts/check-params.ts` computes Black-Scholes fair value for any parameter set across a
  volatility band and runs all five gates. Use it, or your own model.
- `bidder/` is the reference implementation, if you want a starting point rather than a price.
- [Contract surface](../reference/contract-surface.md) has the ABI if you are integrating directly.
