---
title: Bidding, and getting paid
deck: One signed call with a mandatory slippage guard, one pull-based claim that never expires — and one deadline that is yours to manage.
---

# Bidding, and getting paid

## The call

```rust
fn bid(bidder: Address, notional: i128, max_premium_bps: u32) -> i128;  // returns notional filled
```

- **`max_premium_bps` is your slippage guard and it is mandatory.** If the curve is above your
  number, the bid reverts. You can never be filled at a worse price than you signed for, regardless
  of transaction ordering or ledger timing.
- **Partial fills are the norm.** You are filled `min(notional, remaining)`. Bid what you want; take
  what is there. The minimum fill is 100 XLM on the deployed vault, with the final sliver of an
  offer exempt.
- **Re-bidding accumulates** into a single position record per (round, bidder). Bid early at a high
  price and again later at a lower one if you like — each fill is priced at its own moment on the
  curve.
- **The premium transfers from your account inside the same transaction as the fill**, after the
  state is written.

The curve, the auction window, and every rejection code are on
[How the premium is discovered](../mechanism/auction.md). Two of them have a workflow consequence
worth stating here:

- **`OracleUnreachable` is not `InTheMoney`.** The first means the price check the in-the-money
  guard depends on could not be read; the second means spot has actually reached the strike. They
  are separate codes on purpose, and this project counts them separately, so a feed outage is never
  recorded as absent demand — the measurement its own
  [stop condition](../start/why-antares.md#the-stop-condition) depends on.
- **`AllowlistForbidden` expires.** The gate is a launch control with a timestamp fixed at
  deployment and **no setter that can extend it**. Read it from `config()` before you spend any time
  on this: on the deployed vault it is **2026-09-07T09:11:23Z**. The admin can open bidding earlier
  — that transaction is itself on-chain evidence — and cannot keep it closed.

## Getting paid

**Payouts are pull-based. Nothing is ever pushed to you.**

```rust
fn claim_payout(round: u32, bidder: Address) -> i128;
```

Your payout is recomputed from your own immutable fill record against the round's recorded
settlement price: `⌊your_notional × (spot − strike) ÷ spot⌋`. Claim whenever you like — the balance
is persistent contract state and **does not expire**.

This is deliberate: settlement is O(1) and never iterates bidders, because a settlement whose cost
grows with participation is a denial-of-service surface aimed at everyone's exit. The cost to you is
one transaction and its fee.

**If the round was voided:** `claim_refund(round, bidder)` returns your premium **exactly** — every
fill's own `premium_paid` back, with no pro-rata arithmetic and no rounding loss, unlike the payout,
which is pro-rata.

Both calls are unpausable. Neither requires anything from us.

### Finding it later is your job

There is no on-chain function that lists your fills — a claim is addressed to a specific round — and
after about a month an unclaimed record may be archived. **Archival does not lose it**: the claim
transaction restores it automatically. It does mean a naive lookup returns nothing.

The web interface in this repository keeps an index of which addresses filled which rounds and
reads it alongside the chain, so it can show you what you are owed long after the event. Two honest
limits:

1. **That is a convenience we run, not a property of the chain.** Your claim is on-chain and does
   not expire; *finding* it is easier while we are here. If you are integrating directly, record
   your round numbers at fill time.
2. **A quarterly testnet reset deletes unclaimed balances outright.** Claim promptly rather than at
   leisure, and check the next reset date before taking a position you intend to hold to expiry.

## The settlement price, and why calling early cannot change it

Settlement reads the feed as it stood **when the option expired**, not at the moment someone calls.
Calling early or late returns the same number, so no caller can move the price in their own favour
by choosing when to call.

`close_round()` is permissionless and pays its caller a bounty out of the round's premium — 25 bps
on the deployed vault. **If the keeper disappears you can close the round yourself, be paid for
doing it, and claim.** Nobody can withhold your payout.

What protects the number itself, at settlement:

1. **A median, not an average.** Samples are taken across each window and reduced to a median, over
   an odd set, so a single bad print cannot move your payout. The short window requires **all three**
   of its samples to be readable — a median of two would be decided by a tie-break rather than by
   outvoting the outlier it exists to absorb. The consequence for you: a genuinely gappy feed annuls
   the round and refunds you, where a weaker rule would have settled on two points.
2. **A coarse 100× sanity bound** against the last settled price.

The staleness bound and the self-consistency breaker run when a round *opens*, where "the feed is
current" is a meaningful question and a rejection can be retried into a good read. Neither runs at
settlement, and that is deliberate: the expiry window is frozen history, so a rejected read could
never clear on retry, and a breaker there could only ever convert a settleable round into an
annulled one and confiscate a payout you had earned.

## The deadline, stated plainly

**This one can cost you, and it is written here rather than left for you to discover.**

The price feed keeps a bounded history — 255 ticks at a five-minute resolution, less the guard
window, leaving the expiry window readable for about **20 hours 15 minutes** past expiry. Past that,
nobody can read it, so the round cannot be decided on evidence. It finalizes **UNRESOLVED**: the
premium stays with depositors, the payout is zero.

There is a second way into the same outcome, and it exists so no failure can leave the collateral in
limbo: **at 21 hours past expiry the round closes as UNRESOLVED without consulting the price feed at
all.** That path is reached whenever the adapter could not produce a usable reading for the whole
preceding window. In the ordinary case it produces the same result a working feed would have
produced at that moment, so it cannot be used by anyone to change how a round ends.

**The exception is worth your attention if you are in the money:** if the feed alters its own update
interval mid-round — from the 300 seconds it runs today to about 311, which is
`(unresolved_after + guard_window) ÷ 255` and a lengthening of roughly 3.5 % — that equivalence can
break, and a round that was settleable can close as UNRESOLVED instead. Opening a round re-checks
the live feed, so the exposure is one round rather than open-ended. You can remove it entirely by
closing the round early.

If the round was out of the money, UNRESOLVED is exactly where a normal settlement would have left
you. **If it was in the money, you lose the payout as well as the premium.** Closing is
permissionless, pays a bounty, and takes one transaction — and **you are the party who knows whether
you are in the money.**

### The narrow case where it bites through no fault of yours

The feed was genuinely dead at expiry *and* nobody annulled the round during the window when voiding
was available — from the end of the grace period until the history ages out, roughly **eight hours**
(12 h to about 20 h 15 m past expiry). `close_round()` is open to you throughout.

### Why the rule is written this way, since it is not written in your favour

The alternative is to refund the premium, and **that pays you to wait.** Out of the money, letting
the clock run out would return 100 % of your premium — and no bounty funded out of that same premium
can ever be large enough to outbid a full refund. Retaining the premium is the only version under
which **nobody who could cause a delay gains by one.**

One asymmetry survives it, and you should hear it from us: depositors collectively keep more if an
in-the-money round drifts past the deadline. But drift is an absence of action, not an action;
closing is permissionless, and you are the party holding a payout-sized incentive and about twenty
hours to prevent it. That is what makes the outcome a function of history rather than of who stayed
awake.

We would rather tell you about a real cost than claim a property we cannot back. If you can find a
way for someone to *bring that drift about*, that is a vulnerability and it is named in scope on
[Reporting a vulnerability](../reference/security.md).

## The three ways a round ends without paying you

| | What happens to you |
|---|---|
| **LAPSED** — nobody bid | Nothing. There is no option and no premium. Irrelevant if you did not fill |
| **VOIDED** — the feed was unusable at expiry, past the grace period | **Your premium is refunded in full.** Payout zero. Depositors gain nothing. You cannot be voided out of a payout by a working oracle, and you cannot manufacture a void by waiting |
| **UNRESOLVED** — see above | Premium retained by depositors, payout zero |

All three are defined in advance and all three are normal states, not failures.
