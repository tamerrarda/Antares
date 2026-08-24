# Antares — Depositor Guide

What happens to your XLM when you deposit it, when you can get it back, and what you are giving
up in exchange for the premium. Written for someone who has never traded an option.

> **Status: pre-alpha, testnet only, not audited.** Do not deposit anything you would mind
> losing. During testnet the only buyer is a bot run by the project team, so any premium you see
> is a test of the machinery, not a market price.

---

## 1. The trade you are making

You own XLM and you are willing to sell it if the price rises past a certain level. Someone pays
you, today, for the right to that upside. That payment is the **premium**, and it is yours
whether or not the price ever gets there.

Concretely, each round:

- The vault sets a **strike** a few percent above the current price — **3 %** on the main vault.
  (Several vaults run side by side during the counterparty phase, on different terms; see §7.)
- It sells a call option on the collateral and collects a premium, which goes into the pool.
- **If XLM ends below the strike:** nothing happens. The pool keeps the collateral *and* the
  premium. This is the good case.
- **If XLM ends above the strike:** the pool pays out the difference above the strike, out of its
  own collateral, and you keep the premium. Your upside above the strike is capped.

The trade is symmetric and honest: **you earn premium every round, and in exchange you give up
the part of a rally that goes past the strike.** If you believe XLM is going to double next week,
this is the wrong product for you.

**How far above? 3 %, and that is closer than it sounds.** The strike sits where the option is
worth enough for somebody to actually buy it. When markets are calm — XLM's realized volatility
measured **65 % annualized over the last 30 days, against 103 % over the last 90 (2026-08-24)** — an option
struck 10 % away is worth almost nothing, so nobody bids and you earn nothing. Struck 3 % away it is worth buying, so
you get paid; the cost is that your upside stops at 3 % instead of 10 %. This is a real trade-off
and it is chosen deliberately, not tuned quietly: a covered call that never sells is not a
conservative version of this product, it is a vault that does nothing.

What you can never lose: more than the position itself. There is no leverage, no borrowing, no
margin call, and no liquidation anywhere in this protocol. The payout is mathematically bounded
below the collateral backing it, no matter how far the price moves.

### What that means in XLM, which is the unit you are counting in

The rest of this document measures your position in XLM, so the trade has to be shown that way
too. **When XLM rallies past the strike, you end the round with fewer XLM than you started.** Not
"less profit" — fewer coins.

Call the premium **P** — you will know it only after the auction clears, and this project publishes
no forecast of it. The payout does not depend on P at all; it is fixed by the price move alone, and
on the 7-day, 3 %-out-of-the-money vault it is exactly this:

| XLM moves | coins taken by the payout | **your coins change by** | if you had just held |
|---|---|---|---|
| −20 % | none | **+P** | same coins, −20 % in USD |
| −10 % | none | **+P** | same coins, −10 % in USD |
| unchanged | none | **+P** | same coins |
| +3 % (the strike) | none | **+P** | same coins, +3 % in USD |
| +5 % | 1.90 % | **P − 1.90 %** | same coins, +5 % in USD |
| +10 % | 6.36 % | **P − 6.36 %** | same coins, +10 % in USD |
| +20 % | 14.17 % | **P − 14.17 %** | same coins, +20 % in USD |
| +50 % | 31.33 % | **P − 31.33 %** | same coins, +50 % in USD |

P is small — it is bounded below by the auction's reserve of 0.40 % and above by 4.5 %, and an
uncontested auction clears near the reserve. So from +5 % upward the middle column is negative in
every realistic case, and it gets worse the harder XLM rallies: **at +50 % you hold roughly a third
fewer coins than you started with.** In dollars you are still ahead of where you began, but far
behind simply holding — that gap is the thing you are selling, and the premium is what you are paid
for it.

A depositor who is accumulating XLM and would be unhappy holding fewer of it after a rally should
not be in this vault, and no premium changes that.

Two things this table does not include, both small and both against you: the caller who closes the
round is paid a bounty out of the premium (capped at 1 % of it), and a protocol fee exists in the
same place and ships at zero. And it assumes the vault sold its whole option — a partial fill
scales both the premium and the payout down together, an auction that never clears leaves your
coins untouched and pays you nothing.

---

## 2. Shares and the price per share

When you deposit, you receive **share tokens** representing your slice of the pool. They are
ordinary Stellar tokens: you can hold, transfer, or send them anywhere.

The pool's value per share (`pps`) changes only at the end of a round:

```
new value = collateral at open + premium collected − payout − fee − closing bounty
pps       = new value / shares outstanding at open
```

The closing bounty is a small slice of the premium paid to whoever closed the round — anyone can,
including you. It exists so that closing never depends on someone being generous.

Premium pushes it up. A payout pushes it down. A round with no buyer leaves it exactly where it
was. Your XLM claim is always `your shares × pps`.

---

## 3. When you can move your money

This is the part that surprises people, so it gets the most space. The vault has a cycle, and
what you can do depends on where it is:

```
IDLE ──▶ AUCTION ──┬──(no bid, 45 min)──▶ lapsed ─────────────────▶ IDLE ──▶ ...
                   └──(filled)──▶ ACTIVE ──▶ (settled / annulled / unresolved) ──▶ IDLE ──▶ ...
 │           │          │
 │           └──────────┴── an option is live: collateral is committed
 │
 └── between rounds: deposits mint instantly, withdrawals pay instantly
```

### Depositing between rounds (IDLE)

Your XLM converts to shares immediately at the current `pps`, and you're in from the next round.

### Depositing while a round is live

Your XLM is held as a **pending deposit**. It is *not* part of the collateral, no option is
written against it, and it earns nothing that round — because it wasn't at risk that round.
Letting late money share in a premium that earlier money earned would be taking from the people
who took the risk.

Two things you can do with a pending deposit:

- **Cancel it** at any time, in any phase, for as long as it is still pending — you get the exact
  amount back. This is the one instant exit, and it is safe precisely because that money never
  backed an option.
- **Convert it to shares** once the round finishes — **and do not forget this step.** Until you
  convert, the money earns nothing, and while it is sitting there you cannot start a *new* pending deposit during a live round (adding to the same round's pending is fine, and depositing between rounds redeems the old one for you automatically)
  either; the interface will show a single prominent reminder with a countdown until you act. The
  fix is one click and it is always available: convert in the window, or cancel and get your XLM
  back at any time. Conversion happens at the vault's price *at the moment you convert* — not at a price frozen earlier. Waiting costs you the yield you would have earned as shares, but it does not cost you *price*:
  converting and cancelling-then-redepositing are worth exactly the same. Conversion happens in
  the next idle window (see below).

### Withdrawing between rounds (IDLE)

Burn shares, get XLM, same transaction — **if the vault is still between rounds when your
transaction lands**. Anyone can start a new round at any moment once the gap has passed, and if
that happens first, your withdrawal becomes the queued kind below instead. So the withdrawal
screen asks you to choose: *"only if it's still instant"* (the transaction fails harmlessly if a
round started) or *"go ahead either way"*. The default is the safe one.

### Withdrawing while a round is live

Your shares are burned immediately and you are queued: **you exit at this round's closing price,
whatever it turns out to be.** Once the round finishes you claim your XLM.

You cannot leave *before* the round settles, because your capital is what backs the option that
was sold. This is the one genuine lock in the system, it is bounded in *outcome* rather than in time — past a fixed limit the round can be closed without
  reading the feed at all, but somebody still has to close it, and that somebody can be you, and it
is what you are agreeing to when you deposit.

### The idle window

After **every** round — whether it settled, found no buyer, or was annulled — there is a
guaranteed gap before a new one can open, long enough to deposit, convert pending deposits, or
exit instantly. It scales with the epoch length — four hours on the weekly vault, proportionally
less or more on the others. The interface
shows a countdown; you never have to guess.

---

## 4. Rounds that end without a payout to the buyer

All three are normal, defined outcomes. None of them is an error, and none of them costs you
anything:

- **No buyer showed up (lapsed).** No option was sold, no premium was earned, your collateral
  never moved, `pps` is unchanged. **This one resolves 45 minutes into the round, not at the end of
  it** — an auction nobody bids on closes when it expires, so your money is free again the same
  hour rather than a week later. In a thin market this will happen, and it is honest to expect
  it.
- **The round was annulled.** If the price feed was unusable at expiry past a defined limit, the
  round is cancelled: buyers get their premiums refunded, no payout is made, `pps` is unchanged.
  Nobody who could cause an oracle failure profits from one — a feed's death is not something
  any participant can bring about — and nobody is trapped by one: cancellation can be triggered
  by anyone, including you.
- **Nobody closed the round in time (unresolved).** The price feed only keeps about **20 hours**
  of history. If no one closes a round before its expiry moment ages out of that history, it can no
  longer be decided on evidence, so it finalizes with **the premium kept by the pool** and no
  payout. For you this is the same as a round that expired below the strike. It is written that
  way on purpose: any rule that refunded the buyer instead would pay him to wait, and no incentive
  we could fund would outbid that. Closing is permissionless and pays a small bounty, so in
  practice it happens long before the deadline — but if you ever want to be certain, you can close
  the round yourself.

  **The same outcome is the backstop if our own price adapter breaks.** Past a limit fixed when the
  round opens, a round closes as unresolved *without reading the feed at all*. This is the
  answer to the obvious question — *what if the thing that reads prices is the thing that
  fails?* — and it is why your collateral cannot be stranded in a live round by any oracle
  condition whatsoever. The limit is set beyond the point where a working feed could still answer,
  so this path can only ever produce the result the evidence would have produced anyway.

---

## 4b. Limits you will actually hit

- **Minimum deposit.** Small deposits are rejected rather than silently rounded to zero shares.
- **Deposit cap.** The vault has a maximum size while it is young. If it is full, deposits are
  refused until someone withdraws or the cap is raised — nothing is lost, you simply cannot enter
  yet.
- **One pending deposit at a time.** If you deposited during a live round and haven't
  converted it, a further deposit **during another live round** is refused until you do (or
  cancel). Two things are still allowed, and the refusal is narrower than it sounds: adding to the
  same round's pending is fine, and depositing between rounds converts the old one for you
  automatically. This is the rule most likely to
  surprise you, which is why the interface nags about it.
- **The very first deposit** into a fresh vault permanently locks a negligible sliver of shares
  (worth a fraction of a cent) inside the contract. This is a standard defence that stops anyone
  from manipulating the share price when the pool is nearly empty.

## 5. What can go wrong

- **Whoever opens a round sets the strike's basis.** Opening is permissionless, and the strike is
  derived from the price at that moment — so a buyer who opens on a dip gets a cheaper option than
  one who opens on a rally, at your expense. The oracle's guards bound how far the basis can stray
  from the market, but not to zero. It is the sharpest of the few places where another participant's
  timing costs you something — the others being that a new round can open before your instant exit
  lands (§3), and that anyone may end an idle window as soon as it reaches its minimum width.
- **XLM sent directly to the contract address is gone.** Deposits must go through `deposit()`. A
  plain transfer to the vault's address belongs to nobody, is credited to no one, and there is no
  sweep function to recover it — deliberately, because code that can move unattributed funds can
  move attributed ones. This is a wallet mistake rather than a protocol risk, and it is
  the one the vault cannot protect you from — the same is true of burning your share tokens, or
  sending them to the contract's own address, both of which the token standard permits and neither
  of which the vault can undo.
- **The code is unaudited.** This is the largest risk by a wide margin, and it is why this is
  testnet only.
- **You cap your upside.** If XLM rallies hard, you will earn less than simply holding. That is
  the trade, not a malfunction.
- **The premium may be small, or zero.** With no established buyers, some rounds will clear at
  the reserve price and some will not clear at all.
- **Settlement can be late.** If the price feed is stale, closing retries until it works, and cannot retry indefinitely — see the deadline above.
  Your funds are not at risk, but your claim may be delayed by hours.
- **New deposits can be paused.** An admin can stop deposits, new bids and new rounds. Pause can
  never touch the way out: closing a round, requesting and claiming a withdrawal, cancelling a
  pending deposit, redeeming, and restoring an archived position all keep working while paused. See
  [`TRUST_MODEL.md`](TRUST_MODEL.md).
- **A protocol fee exists in the arithmetic and ships at zero.** It is capped at 20 % *of the
  premium* — never of your capital — and it is snapshotted when a round opens, so a change can
  never apply to a round you were already in. Any non-zero value requires a separate, publicly
  visible transaction.
- **The contract is upgradeable** by an admin key today. That is the protocol's single real
  trust concentration and it is documented in the [trust model](TRUST_MODEL.md) rather than
  buried.
- **Storage rent.** Stellar can archive dormant data. Every claim is computed from immutable
  records, so archival can delay a claim but never change or lose it — and any normal transaction
  restores what it touches.

---

## 5b. Testnet is wiped on a schedule

Stellar's test network is **reset roughly every quarter**, with at least two weeks' notice. A reset
deletes all contract state: the vault, your shares, your pending deposit, any unclaimed withdrawal.
Nothing survives it and nothing can be restored from it.

This is not a risk in the usual sense — it is a calendar. It is stated here because "do not deposit
anything you would mind losing" is a warning about uncertainty, and this is a certainty. Before
depositing, check when the next reset is scheduled; the project publishes the date it is working
against alongside each deployment, and never opens a round intended as evidence inside a reset week.

## 6. Why there are no yield numbers

You will not find an APY here, or an expected return, or a projection. While the only buyer is
our own bot, any premium figure would be us paying ourselves and then quoting the result — the
number would travel and its disclaimer would not.

Once a buyer outside our control clears an auction, we publish realized premiums as raw basis
points per round, always shown next to how many recent rounds cleared with no buyer at all. Facts
with their misses attached, never annualized.

---

## 6b. Why there is more than one vault

During the counterparty phase, five vaults run at the same time. They are the same contract with
different terms — how long each round runs (3, 7 or 14 days) and how far above the price the strike
sits (2 %, 3 % or 5 %) — and each one issues its own share token, so `aXLM-A` is not
interchangeable with `aXLM-C`.

The reason is honesty about what we don't know. One vault, one set of terms, and a run of empty
auctions tells you *nothing was sold* without telling you whether the problem was the terms or the
absence of any buyer at all. Five at once can tell those apart.

**A** — 7 days, 3 % — is the main vault and the configuration intended for mainnet. If you are
depositing and don't want to think about it, that is the one. The other four are experiments, and
they are labelled as such in the interface.

## 7. Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the contract actually works
- [`INVARIANTS.md`](INVARIANTS.md) — the properties that must always hold, and how they're tested
- [`TRUST_MODEL.md`](TRUST_MODEL.md) — who can do what to your money
