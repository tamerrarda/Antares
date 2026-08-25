---
title: Antares
deck: Covered call vaults on Stellar, built so that the way out never runs through us.
head:
  - tag: title
    content: Antares — covered call vaults on Stellar
---

Deposit XLM. Each round the vault sells a call option against it, a descending auction discovers
what that option is worth, and the premium goes to the depositors. If XLM finishes below the
strike, the pool keeps the collateral and the premium. If it finishes above, the pool pays the
difference out of its own collateral, and the depositors keep the premium.

> **Status —** Testnet only, **unaudited**, and no independent counterparty has bid.
> [Where this stands](start/status.md).

## The five-second version

You own XLM and you are willing to sell it if the price rises past a certain level. Someone pays
you, today, for the right to that upside. The payment is yours whether or not the price ever gets
there. What you give up is the part of a rally that goes past the strike.

If you have never traded an option, [start here](start/covered-call.md) — that page assumes
nothing.

## What the design guarantees

The claim this vault makes is about **trust** rather than about features: what you have to take on
faith, and what the code makes true whether or not anyone is paying attention. Four sentences, each
linking to the page that proves it:

1. **The exit cannot be closed.** Pause blocks exactly three calls — `deposit`, `bid`,
   `open_epoch`. Nine calls, including every way of getting paid, work in every state where they
   would work unpaused. → [Who can do what to your funds](trust/trust-model.md)
2. **Nobody names the outcome of a round.** One entry point closes a round, it takes no admin, and
   it reads the price as it stood at expiry — so how the round ends is a function of history, not
   of who transacted when. → [The four ways a round ends](mechanism/round-outcomes.md)
3. **The payout is bounded by the collateral behind it.** `payout = notional × (spot − strike) ÷
   spot`, and that fraction is under 1 for every positive strike. No leverage, no margin call, no
   bad debt — as arithmetic, not as a risk parameter. → [How a round is settled](mechanism/settlement.md)
4. **A dead operator cannot strand your money.** Opening and closing are permissionless, closing
   pays its caller a bounty, and a round reaches a terminal state within a bounded window past
   expiry even if the price feed can never be read again. → [If something breaks](trust/incidents.md)

All four are properties of the code that is deployed today, and none of them is worth anything
without something Antares has not yet demonstrated: that an independent counterparty will bid at
all. [Why this exists](start/why-antares.md) says so at length, including the published condition
under which this project stops.

## No yield numbers

There is no APY on this site, no expected return, and no premium forecast. While the only bidder is
a reference bot this project operates, any premium figure would be us paying ourselves and quoting
the result — the number would travel and its disclaimer would not.

That policy has a published exit condition rather than an indefinite excuse. See
[Pricing it yourself](bidder/pricing.md).

## Where to go next

| You are… | Read |
|---|---|
| New to options | [What a covered call is](start/covered-call.md) |
| Considering depositing XLM | [Depositing](depositor/depositing.md), then [What you give up](depositor/what-you-give-up.md) |
| A potential counterparty | [What you are buying](bidder/what-you-are-buying.md) |
| Deciding whether to trust this | [Who can do what to your funds](trust/trust-model.md) and [Risks, stated plainly](trust/risks.md) |
| Auditing or reviewing the code | [The properties that must always hold](trust/invariants.md) and [Contract surface](reference/contract-surface.md) |
| Integrating or building on it | [Contract surface](reference/contract-surface.md) and [What is deployed](reference/deployment.md) |
| Looking for the addresses | [What is deployed](reference/deployment.md) |

The source is at [github.com/tamerrarda/Antares](https://github.com/tamerrarda/Antares), under
Apache-2.0.
