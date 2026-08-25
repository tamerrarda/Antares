---
title: How the premium is discovered
deck: A descending auction on chain, with no privileged quoter and no volatility oracle.
---

The premium is discovered, not assumed. A descending-price auction is the only mechanism that
prices an option on Stellar today without a volatility feed — and Stellar has no reliable
volatility feed.

Nobody here decides what the option is worth. There is no key that names a price and no server
whose answer you have to accept: a public curve falls, and whoever thinks it is cheap enough signs a
transaction. That is the property the rest of this page is the mechanism for.

## The curve

When a round opens, the vault offers **all** of the collateral it holds as notional, at a strike
fixed at that moment, and starts a linear decay in basis points of that notional:

```
premium_bps(t) = start_bps − ⌊(start_bps − floor_bps) × elapsed ÷ auction_duration⌋
```

On the deployed vault that is `280 − ⌊225 × elapsed ÷ 2700⌋`, falling over **45 minutes** from
**2.80 %** of notional to **0.55 %**. Both bounds are published in the `epoch_opened` event before
anyone bids, so the whole curve is public in advance.

Three details that matter if you are checking the arithmetic:

- **The floor is applied to the subtracted term, not to the result.** Flooring what is taken away
  makes the price very slightly higher — at most one basis point, in the vault's favour.
- **The floor price is a bound, never a transaction.** The curve reaches exactly `floor_bps` at
  `auction_end`, and a bid at `auction_end` is refused, so the reserve is approached and never
  undercut.
- **The curve reads the round's own snapshot of the parameters.** An admin changing parameters
  mid-auction cannot move a live bidder's terms; a change takes effect from the next round.

Why linear rather than geometric: linear is integer-exact, which is what lets a differential
reference implementation in a second language check it byte for byte. A geometric curve would widen
the economically live part of the window — by 1.1× to 1.8× at the shipped band, and widest exactly
where the linear tail is shortest — and it is on record as the designated successor. See
[Pricing it yourself](../bidder/pricing.md#the-curves-shape).

## Bidding

```rust
fn bid(bidder: Address, notional: i128, max_premium_bps: u32) -> i128;  // returns notional filled
```

`bid` is open to anyone in the sense that no gatekeeper decides who may be a bidder — but it is
**signed by the bidder**, unlike `open_epoch` and `close_round`, which take no authorization at
all. Two senses of permissionless, and they are not the same thing.

- **`max_premium_bps` is your slippage guard, and it is mandatory.** If the curve sits above your
  number, the bid reverts. You cannot be filled at a worse price than you signed for, regardless of
  ordering or ledger timing.
- **Partial fills are the norm.** You are filled `min(notional, offered − sold)`. In a thin market,
  all-or-nothing means no fills at all.
- **Re-bidding accumulates** into a single position record per (round, bidder). Bid early at a high
  price and again later at a lower one if you like; each fill is priced at its own moment on the
  curve.
- **The premium transfers inside the same transaction as the fill**, after the state is written.

What happens in order, on a successful bid: the guards run, the fill size is computed, the premium
is computed, the fill is recorded against the bidder, `notional_sold` and `premium_collected` are
incremented, the phase flips to `Active` if the offer is now full, and only then does the XLM move.
State first on every path.

**Premium is recognised at fill, never at offer.** Multiple fills at different points on the decay
curve produce different premiums, and the ledger reflects that. Accounting built around "the
premium is known when the round opens" is the single easiest way to make this contract unfixable
later.

## Every way a bid is refused

| Error | Code | Why it exists |
|---|---|---|
| `Paused` | 1 | New deposits, new bids and new rounds can be paused. It can never block a claim, a refund, or the closing of a round |
| `WrongPhase` | 2 | The auction window has passed, or the offer is fully subscribed. The phase moves before a late bid is evaluated, so this is the only code you will see for either |
| `OracleUnreachable` | 13 | The price check the in-the-money guard depends on could not be read. Deliberately distinct from `InTheMoney`: an outage is not a market signal, and the two are counted separately so a feed failure is never recorded as absent demand |
| `AllowlistForbidden` | 30 | Launch control only, and it expires on a timestamp fixed at deployment. Past that this rejection cannot occur |
| `PremiumAboveMax` | 31 | Your own slippage guard |
| `BelowMinFill` | 32 | Dust guard — 100 XLM on the deployed vault. The final sliver of an offer is exempt |
| `InTheMoney` | 34 | Spot has reached or passed the strike (see below) |
| `ZeroPremium` | 35 | A fill so small that the premium floors to zero — a free option, refused |
| `InvalidAmount` | 40 | A non-positive notional |
| `InvalidAddress` | 53 | A bid signed by the vault's own address. A self-transfer succeeds while moving nothing, so without this guard a fill could be recorded against a premium that never arrived |

`SoldOut` used to be code 33 and is **retired**: the phase flips to `Active` the instant the offer
fills, and the phase check runs before the fill size is computed, so no transaction can reach a
zero fill. It is removed rather than reserved, because an unreachable code is ABI an integrator has
to handle and can never observe.

## The in-the-money guard

If the freshest reading shows `spot ≥ strike`, the bid is refused — and so is a bid placed when
that check cannot be read at all.

The reason is that the strike is fixed while the curve descends. Once the option is at or in the
money it has intrinsic value, and a descending curve cannot price intrinsic value: any fill would
sell it for at most the curve premium. Refusing is strictly better for depositors, and an auction
that clears empty costs them nothing.

The cost is on the bidder's side and it is real: **you may show up and find nothing to buy.**

## What happens to the rest

**Unsold notional stays in the vault**, unencumbered, earning nothing that round. It is not
re-offered at a different strike mid-round — a second offer inside one round would make the
position path-dependent and the accounting much harder to reason about.

**At `auction_end`:** if anything sold, the round becomes `Active` and runs to expiry. If nothing
sold, the round is **lapsed** — premium zero, collateral untouched, share price unchanged, and the
next round may open as soon as the idle gap has passed.

A lapse is a first-class outcome with its own event, not a failure to hide. An auction that clears
empty is a data point about demand.

## The allowlist, and when it stops existing

The vault ships with a bidder allowlist **enabled**, and with an expiry timestamp fixed at
construction that has **no setter anywhere in the contract**. The admin can open bidding early —
that transaction is itself on-chain evidence — and has no way at all to extend the gate. Past the
expiry, `bid` ignores the allowlist entirely and re-enabling the flag does nothing.

On the deployed vault the expiry is **2026-09-07T09:11:23Z**, readable from `config()`, from the
`initialized` event, and from the committed deployment record. The contract caps any such timestamp
at 30 days from construction.

This is deliberate rather than generous. "We will open bidding soon" is a promise, and the
[stop condition](../start/why-antares.md#the-stop-condition) that can end this project is measured
in rounds where the allowlist is off. A launch control that could be left on indefinitely would be
a way of never having to find out.
