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

**Price it as a vanilla call.** The XLM-denominated payout converges to `notional` as spot rises,
which is a real solvency property of the vault — it is why no margin or liquidation engine exists
here. It is **not** a pricing discount. In USD the payout is
`notional × (spot − strike)/spot × spot = notional × (spot − strike)`, which is exactly the payoff
of a standard call on `notional` XLM struck at `strike`. The numéraire moves with the cap, so the
cap has no effect on value. (An earlier version of this paragraph said the opposite and told you to
price it below a vanilla call. That was wrong, and it was wrong in your favour to notice: the
Black-Scholes figures this project publishes have always assumed the vanilla payoff.)

### The capital point

Under physical settlement a counterparty must hold `strike × notional` to write or take the other
side. Here you post the premium alone. At the option's fair value on instance A that is a **23× to
49×** lower capital barrier across the volatility range measured on 2026-08-24, and, across the five
vaults, never less than **15×** lower anywhere on any of their auction curves. (This said **136×**
until 2026-08-25; that figure was computed against the assumed σ of 33.7 % the premium bands were
originally sized around, and it moved when they were re-derived against measured volatility.) That is the
deliberate design choice that makes being a counterparty possible in a thin market at all.

---

## 1b. There is more than one auction

During the counterparty phase **five vaults run concurrently** — the same contract, identical in
every respect except their terms, each with its own share token (`aXLM-A` … `aXLM-E`) and its own
auction, so you can price them against each other and fill only the terms that work for you:

| | Duration | Strike |
|---|---|---|
| **A** | 7 days | 3 % out of the money — the mainnet-target configuration |
| **B** | 7 days | 5 % |
| **C** | 3 days | 2 % — the nearest to the money |
| **D** | 14 days | 5 % |
| **E** | 3 days | 3 % |

That is the whole point: we do not know which duration and which moneyness a real counterparty
wants, and asking five questions at once is faster than asking the same one five times. Each vault
carries its own premium band, sized to its own fair value — a set of terms nobody could profitably
fill would test nothing. If none of them are priced attractively, the useful answer is to tell us
which one came closest and by how much.

## 2. The auction

Each epoch the vault offers its entire collateral as notional, at a strike fixed when the epoch
opens (`strike = TWAP × (1 + strike_bps_otm)`), through a **descending-price Dutch auction**:

```
premium_bps(t) = start_bps − (start_bps − floor_bps) × elapsed / auction_duration
```

The price starts high and falls linearly to a floor over the auction window, which is **45
minutes**. It was two hours in an earlier draft; Ribbon's published data showed long windows
widening the gap between clearing price and fair value, so it was shortened. There is no fixed
premium: the clearing price is whatever a bidder accepts, and it is recognized **at fill**, not
at offer.

**The part of that window you would actually want is shorter, and how much shorter moves with
volatility — measured, not estimated.** A rational buyer does not bid while the curve sits above
fair value. At the shipped bands and the volatility measured on 2026-08-24 (σ 103 % over 90 days),
the linear decay crosses fair value at about **minute 7** on every instance, leaving an
economically live tail of roughly **38 minutes**. Priced against the calmer 30-day window
(σ 65 %) the crossing is near minute 31 and the tail is about **13 minutes**. Either way it is
wide enough for a person to act in.

**It was not always, and the earlier answer stays on the page.** Until 2026-08-24 this section
reported a live tail of two to four minutes and concluded the auction favoured a bot. That was
true of the premium bands as they then stood — sized against an *assumed* σ of 33.7 % rather than
a measured one. When σ was measured it came back at 103 %, the bands were raised to stay coherent
with it, and the crossing moved with them. The superseded finding is recorded rather than deleted:
a document that quietly drops the claim it used to argue from is not one you should trust the rest
of. The curve's shape is decided for this build — linear stays, because it is
the only shape our verification suite can check exactly without new machinery — but a geometric
curve, which widens the live window by 1.08× to 1.67× at the shipped band and is widest exactly
where the linear tail is shortest, is on record as its designated successor, and what promotes it is
evidence, not our mood: **if the window is the reason you would not participate, saying so is
literally the named trigger** for making that change before any mainnet parameters are frozen.

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
| `WrongPhase` | the auction window has passed — the phase moves before a late bid is evaluated, so this is the only code you will see for it |
| `OracleUnreachable` | the price check the in-the-money guard depends on could not be read. Distinct from `InTheMoney` on purpose: an outage is not a market signal, and we count the two separately so a feed failure is never recorded as absent demand |
| `Paused` | new deposits, new bids and new rounds can be paused by the admin. It can never block a claim, a refund, or the closing of a round — the exit path is unpausable — but it can stop you taking a *new* position |
| `AllowlistForbidden` | launch control only, and it **expires on a timestamp fixed when the vault was deployed** — read it from `config()` before you spend any time on this. The admin can open bidding earlier (that transaction is itself on-chain evidence) but has no way to extend the gate; past the expiry this rejection cannot occur |

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

**Finding it later is your job, and we have made it as easy as we can.** There is no on-chain
function that lists your fills — a claim is addressed to a specific round — and after about a month
an unclaimed record may be archived. Archival does not lose it: the claim transaction restores it
automatically. It does mean a naive lookup returns nothing, so our interface keeps an index of
which addresses filled which rounds and reads it alongside the chain, and can still show you what
you are owed long after the event. Two honest limits: it is a convenience we run, not a property of
the chain — your claim is on-chain and does not expire, but finding it is easier while we are here —
and a quarterly testnet reset deletes unclaimed balances outright (§6c). If you are integrating
directly rather than through the app, record your
round numbers at fill time.

This is deliberate: settlement is O(1) and never iterates bidders, because a settlement whose
cost grows with participation is a denial-of-service surface aimed at everyone's exit. The cost
to you is one transaction and its fee.

**If the epoch is voided** (see §5): `claim_refund(round, bidder)` returns your premium exactly —
no pro-rata math, no rounding loss.

---

## 4. Settlement price — what decides your payout

Settlement uses a **TWAP** from Reflector's external CEX & DEX XLM/USD feed — aggregated deep
off-chain markets, never a thin on-chain order book. A single tick never decides a settlement.

**What protects the number, at settlement:**

1. **A median, not an average.** Samples are taken across each window and reduced to a median, so
   a single bad print cannot move your payout. The sample sets are always **odd** and the short
   window requires **all three** of its samples to be readable — a median of two would be decided
   by a tie-break rather than by outvoting the outlier it exists to absorb. The consequence for
   you is worth knowing: a genuinely gappy feed now annuls the round (premium refunded) where it
   previously settled on two points. This is what replaces a circuit breaker
   here: the expiry window is frozen history, so a rejected read could never "clear" on a retry —
   a breaker at settlement could only ever convert a settleable round into an annulled one and
   confiscate a payout you had earned. The estimator absorbs the artifact instead.
2. **Sanity bound** — a coarse 100× check against the last settled price.

The staleness bound and the self-consistency breaker run when an epoch *opens*, where "the feed is
current" is a meaningful question and a rejection can be retried into a good read. Neither runs at
settlement, and that is deliberate rather than an omission.

**The price is fixed at expiry, not at the moment someone calls.** Settlement reads the feed as it
stood when the option expired, so calling early or late cannot change what you are paid.
`close_round()` is permissionless and pays its caller a small bounty out of the round's premium, so
if the keeper disappears you can close the round yourself, get paid for doing it, and claim. Nobody
can withhold your payout.

**But there is a deadline, and it is yours as much as ours — read §5.**

---

## 5. Ways an epoch ends without paying you

All three are normal states, not failures — and all three are defined in advance:

- **LAPSED** — nobody bid. There is no option, no premium, nothing happened. Irrelevant to you
  if you didn't fill.
- **VOIDED** — the feed was unusable **at expiry**, and a grace period has passed. The epoch is
  annulled: **your premium is refunded in full**, payout is zero, depositors gain nothing. An
  oracle failure is nobody's fault, and nobody who could cause one profits from one — the refund
  does leave you better off than an out-of-the-money settlement would have, but a feed's death is
  not an event you or anyone else can bring about, and the guards read only its frozen history.
  This is a fact fixed by history that no later event changes, so you cannot be voided out of a
  payout by a working oracle, and you cannot manufacture a void by waiting.
- **UNRESOLVED** — nobody closed the round while expiry was still readable, **or** the price
  adapter itself was unreachable right through the window. **This one can cost you, and you should
  read it carefully.**

### The deadline, stated plainly

The price feed keeps a bounded history — **20 hours 15 minutes** at the current parameters
(`255 × resolution − guard_window` = 76 500 − 3 600 s, at the feed's own live 300-second tick;
measured in `deployments/adapter-testnet.json` as `reachLimitSeconds`), less up to one tick
depending on where expiry falls on the grid. Past that, the expiry window
can no longer be read by anyone, so the round cannot be decided on evidence. It then finalizes as
**UNRESOLVED**: the premium stays with depositors, the payout is zero.

There is a second way into the same outcome, and it exists so that no failure can leave your
collateral in limbo: **at 21 hours past expiry the round closes as UNRESOLVED without consulting
the price feed at all.** That path is reached whenever the price adapter could not produce a usable reading for the whole
preceding window — because it could not be called at all, or because the feed changed its own
update interval so that the windows we asked for no longer fit its grid. In the ordinary case it
produces the same result a working feed would have produced at that moment, so it cannot be used,
by us or by anyone, to change how a round ends. **The exception is worth your attention if you are
in the money:** if the feed alters its update interval mid-round, that equivalence can break and a
round that was settleable can close as UNRESOLVED instead. It is written here rather than left for
you to discover, and it is the same class of risk as the deadline above — one you can remove for
yourself by closing the round early.

If the round was out of the money, that is exactly where a normal settlement would have left you.
**If it was in the money, you lose the payout as well as the premium.** Closing the round is
permissionless and pays a bounty, so you can do it yourself at any point in those ~20 hours — and
you are the party who knows whether you are in the money.

The narrow case where this bites through no fault of yours: the feed was genuinely dead at expiry
*and* nobody annulled the round during the window when voiding was available — from the end of the
grace period until the history ages out, about **eight hours** (12 h to 20 h 15 m past expiry).
`close_round()` is open to you throughout.

**Why the rule is written this way**, since it is not written in your favour: the alternative is to
refund the premium, and that pays you to wait. Out of the money, letting the clock run out would
return 100 % of your premium — and no bounty funded out of that same premium can ever be large
enough to outbid it. Retaining the premium is the only version under which **nobody who could cause
a delay gains by one**. One asymmetry survives it, and you should hear it from us: depositors
collectively keep more if an in-the-money round drifts past the deadline — but drift is an
absence of action, not an action; closing is permissionless, and you are the party holding a
payout-sized incentive and ~20 hours to prevent it. That is what makes the outcome a function of
history rather than of who stayed awake. We would rather tell you about a real cost than claim a
property we cannot back.

---

## 6. Risks, stated plainly

- **Unaudited.** The contract is written, it runs on testnet, and every invariant is asserted by
  our own tests. That is necessary and not sufficient: nobody outside this project has audited it,
  and the review that has been done was done by the people who wrote the thing. Testnet only.
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
size we intend to sell it (the vault is capped at 100 000 XLM — about $20 k of notional at XLM's
price on 2026-08-24).

What is useful to us is therefore **a decision you would stand behind with your own capital**. A
fill placed casually because the tokens are free tells us nothing and, worse, tells us something
false. If our number is wrong, saying *"I'd want 200 bps for that, not 112"* is worth more to this
project than a fill — and it is the finding we will publish.

## 6c. Testnet is wiped on a schedule

Stellar's test network is **reset roughly every quarter**, with at least two weeks' notice, and a
reset deletes all contract state — including a payout or refund you have not claimed. Claim
promptly rather than at leisure, and check the next reset date before taking a position you intend
to hold to expiry. The transaction hashes you and we would point at as evidence stop resolving on
the explorer after a reset too, which is why closed rounds are archived to this repository as they
happen.

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
