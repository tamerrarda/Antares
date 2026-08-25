---
title: Why this exists
deck: Selling a covered call on-chain needs three things Stellar does not hand you. Antares is one contract that supplies all three, and a published condition under which the attempt is called off.
---

> **Status —** Nothing on this page is a claim that the bet has paid off. No independent
> counterparty has ever bid. [Where this stands](status.md).

## The problem

If you hold XLM and would be willing to part with it above some level, that willingness has a
price. Somebody would pay you for it today. Turning that into an on-chain product needs three
things, and none of them is free:

**1. A price for the option, discovered rather than declared.** Pricing an option normally requires
a volatility input. Stellar has no reliable volatility feed, so a vault either invents a number, or
takes one from a server, or finds a way to make the market state it. Inventing it is guesswork; a
server-quoted number is something you would have to trust.

**2. A settlement rule nobody can steer.** The round has to end at a price that does not depend on
who called the closing transaction, or when. Otherwise the outcome is negotiable by whoever
transacts first, and every guarantee downstream of it is a promise rather than a property.

**3. Accounting that does not let late capital take an earned premium.** A covered call locks
collateral for the duration of the round. Money that arrives while an option is live took none of
that option's risk, and if it minted shares immediately it would claim a share of a premium it did
not earn.

## What Antares does about each

**The price is discovered by a descending auction on chain.** Each round the vault offers its whole
collateral at a strike fixed from the feed at the moment of opening, and the premium falls linearly
from a start rate to a reserve over 45 minutes. Whoever thinks the option is cheap enough signs a
transaction. There is **no privileged quoter** — no key that names the price, no server whose answer
you have to accept. → [How the premium is discovered](../mechanism/auction.md)

**One entry point closes a round, and its caller does not choose the outcome.** `close_round` takes
no authorization at all, reads the price as it stood *at expiry*, and dispatches on what it finds.
Calling early or late returns the same number, and no caller can name the result. →
[The four ways a round ends](../mechanism/round-outcomes.md)

**Share issuance is round-gated.** Capital that arrives mid-round is held as a cancellable pending
deposit, is not written against, and converts at the price current when it converts. Burns are
allowed in any phase, because an exiting holder leaves at the round's own price. →
[Depositing](../depositor/depositing.md)

## The bet, stated as a bet

> **The counterparty is an independent bidder, and the price is discovered on-chain by a descending
> auction with no privileged quoter.**

Everything else follows from that choice — including the properties that make the vault worth using
without trusting whoever runs it:

- The exit path is unpausable and does not route through the operator. Pause blocks exactly three
  calls, all of them ways *in*. → [Who can do what to your funds](../trust/trust-model.md)
- The payout is bounded below the collateral by arithmetic, so there is no leverage anywhere in the
  system and even a fully compromised price feed caps at one round's sold notional. →
  [How a round is settled](../mechanism/settlement.md)
- A round reaches a terminal state within a bounded window past expiry whatever the feed or the
  adapter is doing, on a path that calls no external contract. →
  [If something breaks](../trust/incidents.md)

**And it only works if independent bidders actually show up.** That is the question this project
exists to answer and has not answered yet. It is a market question, not an engineering one — it
cannot be answered by writing more code.

## What is left, and why none of it is more code

The mechanism is built. Two things stand between it and a mainnet deployment, and neither is
written in Rust.

**An audit.** No external party has reviewed this code. That is a process, not a backlog item, and
the honest statement about it is on [Where this stands](status.md).

**A counterparty.** The question is whether an independent bidder will pay a premium, and at what
price. It is answered by three conditions together, all of them counted **within a single vault**
and never pooled across the concurrent ones:

- at least **3 addresses outside this project** fill;
- at least **4 consecutive rounds** with a fill;
- notional-weighted average clearing at or above
  `max(0.75 × Black-Scholes fair value at the volatility the round actually realized, 1.30 × the auction's reserve)`.

Findings — including refusals — are what gets reported, rather than metrics.

**The third condition is the one that can fail us.** An uncontested descending auction always walks
toward its floor. If clearing prices cluster at the bottom of the curve, price discovery never
happened and the mechanism has quietly degenerated into a fixed premium that hands the buyer a free
timing option. That would falsify a load-bearing assumption, and it would be reported as
falsification rather than as a fill count.

Two conditions rather than one, because a single ratio breaks. `0.75 × fair value` moves with
volatility while the reserve is an integer fixed at deployment, so below the volatility at which
the reserve *is* three-quarters of fair value — about **51 %** on the deployed vault, about **49 %**
on the mainnet-target configuration — an auction filled entirely at the reserve clears the ratio
test on its own. XLM's measured windows sit above that today
([65.1 % / 60.2 % / 103.0 %](../bidder/pricing.md#the-volatility-this-is-sized-against)), but a
quiet quarter is not a hypothetical.

`1.30 × reserve` is volatility-independent, and the margin is not close. An uncontested auction
walks the curve to its **last admissible tick** — a bid at `auction_end` itself is refused, so on
the deployed vault the lowest price anyone can transact at is **56 bps against a 55 bps reserve**,
1.8 % above it. Thirty per cent above the reserve is out of reach of walking, so a lone bidder
walking the curve fails the gate and a second bidder forcing the clear earlier passes it.
**The gate measures whether anyone was competing.**

## The stop condition

Every gate above is a *go* gate. Here is the one that ends the project:

> **If 8 consecutive rounds *and* at least 30 calendar days pass with the bidder allowlist disabled
> and no independent fill, development stops.**

Both conditions are required because an empty round ends in 45 minutes, not a week. With the
mandatory gap between rounds counted, a full empty cycle takes as little as **2 h 45 min** on the
shortest configurations, so eight of them could otherwise elapse in about 22 hours — against
evidence gathered while no counterparty was awake.

The allowlist that gates bidding **expires on a timestamp fixed when the vault is deployed**, capped
at 30 days, with no setter that can extend it. That is deliberate: the one gate that can end this
project must not be freezable by leaving a launch control switched on. On the deployed vault it
expires **2026-09-07T09:11:23Z**, and you can read that number out of `config()` yourself rather
than take our word for it.

If the stop condition triggers, we publish what happened — how many rounds, at what parameters,
what premiums were on offer, how many counterparties were approached and what they said — and then
choose, explicitly and publicly: pivot, park the code, or close.

**A project without a stop condition cannot tell you it was wrong.**
