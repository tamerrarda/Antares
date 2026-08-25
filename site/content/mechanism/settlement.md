---
title: How a round is settled
deck: Cash-settled in XLM, out of the vault's own collateral, with a payout that arithmetic bounds below the notional it was written against.
---

# How a round is settled

Settlement happens when anyone calls `close_round()` at or after expiry and the price feed answers
for the expiry window. This page is the arithmetic. What decides *which* branch you get is
[The four ways a round ends](round-outcomes.md); what the feed does is
[The price feed](price-feed.md).

## The payout

```
if spot ≤ strike:   payout = 0
else:               payout = ⌊notional_sold × (spot − strike) ÷ spot⌋
```

Cash-settled in XLM, paid out of the collateral the vault already holds. There is no second leg:
the bidder paid the premium up front and has no further obligation, so there is no atomic swap, no
delivery failure, and no counterparty credit risk in either direction.

**The payout is strictly less than the notional sold, for every possible price.** As `spot → ∞`,
the fraction `(spot − strike) ÷ spot` approaches 1 from below and never reaches it, and the floor
can only make it smaller. So:

> **The vault can never owe more than the collateral behind the position.** No margin call, no
> liquidation engine, no bad debt, no cascading insolvency. The bound is structural, not a risk
> parameter you have to trust someone to set correctly.

This is invariant [I3](../trust/invariants.md#i3-payout-is-strictly-bounded-by-the-sold-notional).
It is also the reason a compromised price feed caps at one round's sold notional: a fake price can
move value between depositors and this round's bidders, and it can do nothing else.

At a 3 % strike, as a fraction of the notional sold:

| XLM at expiry, relative to the price at open | Payout, as a share of notional sold |
|---|---|
| −20 %, −10 %, unchanged, +3 % | **0 %** |
| +5 % | 1.90 % |
| +10 % | 6.36 % |
| +20 % | 14.17 % |
| +50 % | 31.33 % |
| +100 % | 48.50 % |

Recompute any row as `(spot − 1.03) ÷ spot` with `spot` expressed as a multiple of the price at
open.

## How the payout reaches the bidders

**Pull-based. Nothing is ever pushed.** Each bidder's share is recomputed from their own immutable
fill record against the round's recorded settlement price, and claimed with
`claim_payout(round, bidder)`.

`close_round()` is O(1) on every branch and never iterates fills. A per-bidder loop would make the
cost of the one call that must never fail grow with participation.
[Bidding, and getting paid](../bidder/bidding-and-payout.md#getting-paid) is the bidder's side of
this.

## What settlement does to the share price

**Two of the four outcomes move money, and both compute the same five numbers through the same pure
function.** A settled round passes it the price; an unresolved round passes it nothing, so the
payout is zero by definition rather than by arithmetic, and every step after that is identical code.
That shared path is the point: a second function could only ever *promise* to agree with the first.

A lapsed round and a voided round compute nothing at all — both carry the previous share price
forward untouched, because neither took anything out of the pool.

```
fee_R    = ⌊premium_R × fee_bps_snapshot ÷ 10 000⌋       rate snapshotted at open, never read at close
bounty_R = ⌊premium_R × settle_bounty_bps ÷ 10 000⌋      paid to whoever closed the round
assets_R = locked_at_open + premium_R − payout_R − fee_R − bounty_R
pps[R]   = ⌊assets_R × 10 000 000 ÷ shares_snapshot⌋
```

On the deployed vault `fee_bps` is **0** and `settle_bounty_bps` is **25** — a quarter of one per
cent of the premium, not of your capital. The contract caps the fee at 2 000 bps (20 % of the
premium) and the bounty at 100 bps (1 % of the premium), and both caps are enforced at
construction and on every parameter change.

`shares_snapshot` is the share supply **at the start of the round**. Two deliberate consequences:
pending deposits made during the round are not in it, because they earned nothing; and shares
burned by `request_withdraw` during the round *are* in it, because that holder is exiting at this
round's price.

The fee rate is snapshotted at open rather than read at close so that a change can never apply
retroactively to a round that was auctioned under a different one.

## A worked round

Ten thousand XLM in the pool, ten thousand shares outstanding, share price exactly 1.0. XLM at
0.1956 when the round opens, so the strike is `⌊0.1956 × 10 300 ÷ 10 000⌋ = 0.201468`. The whole
offer sells at 150 bps, so the premium is 150 XLM. Fee 0, bounty 25 bps of the premium = 0.375 XLM.

| XLM at expiry | Payout | Assets after | New share price |
|---|---|---|---|
| 0.185820 (−5 %) | 0 | 10 149.6250 XLM | **1.0149625** |
| 0.201468 (+3 %, exactly the strike) | 0 | 10 149.6250 XLM | **1.0149625** |
| 0.215160 (+10 %) | 636.3636 XLM | 9 513.2614 XLM | **0.9513261** |
| 0.293400 (+50 %) | 3 133.3333 XLM | 7 016.2917 XLM | **0.7016291** |

Read the last two rows carefully: in XLM terms the pool shrank. In USD terms it did not — a pool
holding 0.9513 as many coins at 1.10× the price is worth more than it started. **What was sold is
the difference between those two facts**, and [What you give up](../depositor/what-you-give-up.md)
is about exactly that.

## Checking a real round against the chain

The identity is `assets_after = assets_before + premium − payout − fee − bounty`, and the new share
price is `⌊assets_after × 10 000 000 ÷ shares⌋`.

**It takes two events, not one.** `settled` carries `premium`, `payout_total`, `fee` and the
resulting `pps`. The bounty is a separate event, `settle_bounty{round, to, amount}`, published by
the same transaction — and **not published at all when the bounty floors to zero**, which is the
case a reconciliation should expect rather than treat as a missing record. Checking the identity
against `settled` alone leaves you short the bounty term.

## Rounding

Every division floors, and always in the vault's favour.

| Computation | Direction of error | Who benefits |
|---|---|---|
| Share mint | fewer shares issued | the pool |
| Withdrawal claim | less XLM paid out | the pool |
| Share price | lower | the pool |
| Payout, total and per bidder | less XLM paid out | the pool |
| Fee | less fee paid out | the pool |
| Premium | less XLM collected | the bidder — inbound only, so solvency is unaffected |

Rounding can therefore only ever make the contract *more* solvent. A few stroops of unclaimable
dust accumulate per round. This is measured and bounded by a conservation test, and deliberately
not swept: code that can move dust is code that can move funds.

## What settlement cannot do

- It cannot be triggered at a chosen price. The feed is read as it stood **at expiry**, so calling
  early or late returns the same number.
- It cannot be triggered at a chosen outcome. One entry point dispatches on what the read returns.
- It cannot be blocked by pause. `close_round` is not pausable.
- It cannot rewrite a round. A `Round` record is written once and never rewritten — not by
  settlement, not by an upgrade, not by any admin action
  ([I7](../trust/invariants.md#i7-round-records-are-immutable)). Every unclaimed withdrawal and
  every unclaimed payout is computed from one, potentially long after the fact.
