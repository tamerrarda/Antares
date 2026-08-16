# Antares — Bidder Guide

You are the counterparty. This document is written for you: what you are buying, exactly what it
costs, what it pays, how to bid, and where it can go wrong. Nothing here is a pitch — the
economics either work for you or they don't, and you are better equipped than us to judge that.

> **Status: pre-alpha, testnet only, not audited.** During testnet the only bidder is a reference
> bot operated by the project team and labeled as such everywhere it appears. If you are reading
> this as an independent party, you are the thing this project most needs and does not yet have.

---

## 1. What you are buying

A **cash-settled European call option on XLM**, written by the vault against collateral it
already holds.

- **You pay:** a premium, up front, in XLM. Nothing else, ever.
- **You never post:** strike × notional. There is no margin, no collateral requirement, no
  liquidation, no obligation of any kind after the fill.
- **At expiry:** if `spot > strike`, the vault pays you
  `payout = notional × (spot − strike) / spot`, in XLM. If `spot ≤ strike`, you get nothing and
  the option expires worthless.
- **Your maximum loss** is the premium you paid. **Your maximum gain** is bounded by
  `payout < notional` for every possible spot (as spot → ∞ the ratio approaches but never
  reaches 1).

Because the payout is denominated in the same asset it is measured against, this is not identical
to a classic USD-settled call — it converges to the notional rather than growing without bound.
Price it accordingly.

### The capital point

Under physical settlement a counterparty must hold `strike × notional` to write or take the other
side. Here you post the premium alone — roughly a 20× lower capital barrier. That is the
deliberate design choice that makes being a counterparty possible in a thin market at all.

---

## 1b. There is more than one auction

During the counterparty phase several vaults run **concurrently**, identical in every respect
except their terms — how long the option runs and how far out of the money the strike sits. Each
issues its own share token and runs its own auction, so you can price them against each other and
fill only the terms that work for you. That is the whole point: we do not know which duration and
which moneyness a real counterparty wants, and asking five questions at once is faster than asking
the same one five times. If none of them are priced attractively, the useful answer is to tell us
which one came closest and by how much.

## 2. The auction

Each epoch the vault offers its entire collateral as notional, at a strike fixed when the epoch
opens (`strike = TWAP × (1 + strike_bps_otm)`), through a **descending-price Dutch auction**:

```
premium_bps(t) = start_bps − (start_bps − floor_bps) × elapsed / auction_duration
```

The price starts high and falls linearly to a floor over the auction window. There is no fixed
premium: the clearing price is whatever a bidder accepts, and it is recognized **at fill**, not
at offer.

**Bidding:**

```rust
bid(bidder: Address, notional: i128, max_premium_bps: u32) -> i128  // returns filled notional
```

- `max_premium_bps` is **your slippage guard and it is mandatory.** If the curve is above your
  number, the bid reverts. You can never be filled at a worse price than you signed for,
  regardless of ordering or ledger timing.
- **Partial fills are the norm.** You are filled `min(notional, remaining)`. Bid what you want;
  take what's there.
- **Re-bidding accumulates** into a single position record per (round, bidder). Bid early at a
  high price and again later at a lower one if you like — each fill is priced at its own moment
  on the curve.
- Premium transfers from your account **inside the same transaction** as the fill.

**What will reject your bid:**

| Rejection | Why it exists |
|---|---|
| `PremiumAboveMax` | your own slippage guard |
| `InTheMoney` | spot has reached or passed the strike. The descending curve cannot price intrinsic value, so the vault refuses rather than sell it cheaply |
| `BelowMinFill` | dust guard; exception: the final sliver of an offer may be smaller |
| `ZeroPremium` | a fill so small the premium rounds to zero — a free option, refused |
| `SoldOut` | the offer is fully subscribed |
| `AuctionClosed` / `WrongPhase` | the auction window has passed |
| `OracleUnreachable` | the price check the in-the-money guard depends on could not be read. Distinct from `InTheMoney` on purpose: an outage is not a market signal, and we count the two separately so a feed failure is never recorded as absent demand |
| `AllowlistForbidden` | launch control only; the code path is permissionless and the allowlist is disabled publicly (the disabling transaction is itself on-chain evidence) |

---

## 3. Getting paid

**Payouts are pull-based. Nothing is ever pushed to you.**

After settlement, if the round finished in the money:

```rust
claim_payout(round: u32, bidder: Address) -> i128
```

Your payout is recomputed from your own immutable fill record against the round's recorded
settlement price: `⌊your_notional × (spot − strike) / spot⌋`. Claim whenever you like — the
balance is persistent contract state and does not expire.

This is deliberate: settlement is O(1) and never iterates bidders, because a settlement whose
cost grows with participation is a denial-of-service surface aimed at everyone's exit. The cost
to you is one transaction and its fee.

**If the epoch is voided** (see §5): `claim_refund(round, bidder)` returns your premium exactly —
no pro-rata math, no rounding loss.

---

## 4. Settlement price — what decides your payout

Settlement uses a **TWAP** from Reflector's external CEX & DEX XLM/USD feed — aggregated deep
off-chain markets, never a thin on-chain order book. A single tick never decides a settlement.

Three guards sit in front of it, and all three are permissionless to retry:

1. **Staleness** — if the feed is older than the bound, `settle()` reverts. Anyone may retry.
2. **Self-consistency** — the short TWAP is compared against a longer guard TWAP of the same
   moment, at the point in time settlement is anchored to. A feed artifact skews the short window
   and not the long one; a real market move carries both. **It does not trigger on genuine price
   moves** — a real rally settles normally and pays you. Settlement itself takes the **median** of
   several samples in each window, so a single bad print cannot decide your payout.
3. **Sanity bound** — a coarse 100× check against the last settled price.

**The price is fixed at expiry, not at the moment someone calls.** Settlement reads the feed as it
stood when the option expired, so calling early, late, or not at all cannot change what you are
paid — and nobody can improve their outcome by waiting. `settle()` is permissionless and pays its
caller a small bounty out of the round's premium, so if the keeper disappears you can settle the
round yourself, get paid for doing it, and claim. Nobody can withhold your payout.

---

## 5. Ways an epoch ends without paying you

Both are normal states, not failures — and both are defined in advance:

- **LAPSED** — nobody bid. There is no option, no premium, nothing happened. Irrelevant to you
  if you didn't fill.
- **VOIDED** — the oracle was unusable past a defined bound after expiry. The epoch is annulled:
  **your premium is refunded in full**, payout is zero, depositors gain nothing. An oracle
  failure is nobody's fault and nobody profits from it. `void_epoch()` is permissionless and only
  possible when the feed was unusable **around expiry** — a fact fixed by history that no later
  event changes. So settling and voiding are mutually exclusive from the moment the option
  expires, and neither side can elect the outcome by choosing when to transact. **You cannot be
  voided out of a payout by a working oracle, and you cannot recover a premium by waiting.**

---

## 6. Risks, stated plainly

- **Unaudited, and not yet built.** The design is frozen; the contract is being implemented
  against it. Every invariant will be asserted by our own tests — necessary, not sufficient.
  Testnet only.
- **The vault can refuse to sell** at any price you'd accept if the option has drifted into the
  money. You may show up and find nothing to buy.
- **Upgradeability.** The contract is upgradeable behind an admin key on testnet (a timelocked
  multisig before any mainnet deployment). Whoever holds that key can change the code. This is
  the protocol's one real trust concentration and it is disclosed, not hidden.
- **Oracle dependency.** Bounded by the guards above and by the payout formula — even a fully
  compromised feed cannot extract more than one epoch's sold notional, and there is no leverage
  anywhere in the system. Bounding is not eliminating.
- **No liquid venue to hedge vega.** XLM futures and perpetuals exist (delta hedging is
  possible); XLM options do not trade on a major venue, so you cannot lay off volatility risk.
  This is the single hardest fact about being a counterparty here, and it is why this project
  treats counterparty discovery as an open question rather than an assumption.
- **Thin market.** You may be the only bidder. An uncontested Dutch auction walks to the floor —
  good for you, and a signal that price discovery isn't happening yet.

---

## 6b. A request, if you bid on testnet

The XLM is free; **the prices are not.** The strike comes from the live XLM/USD feed, settlement
uses the real price path, and the parameters were derived from XLM's measured realized
volatility — so the option you are pricing is the option we intend to sell for real money, at the
size we intend to sell it (the vault is capped at 100 000 XLM, about $16 k of notional).

What is useful to us is therefore **a decision you would stand behind with your own capital**. A
fill placed casually because the tokens are free tells us nothing and, worse, tells us something
false. If our number is wrong, saying *"I'd want 140 bps for that, not 76"* is worth more to this
project than a fill — and it is the finding we will publish.

## 7. Pricing it yourself

We publish no expected returns, no APY, and no premium forecasts — for you or for depositors.
What we publish is the mechanism and the raw on-chain facts.

To price a round you need `strike_bps_otm`, `epoch_duration`, spot, and your own volatility view.
`scripts/check-params.ts` in this repository computes Black-Scholes fair value for any parameter
set across a volatility band; use it, or your own model. If the curve's floor sits above your
fair value, do not bid — and please tell us, because that is exactly the finding this project is
trying to surface.

The reference bidder (`bidder/`) is open source and deliberately naive: it targets a configured
premium in bps and does not model volatility. It exists to test the mechanism, not to set a
price. Do not treat its fills as market evidence — we don't.

---

## 8. Talking to us

Findings, refusals and "your parameters are wrong" are more valuable to this project than fills.
If you looked at this and decided not to bid, the reason is the most useful thing you could send
us — open an issue.
