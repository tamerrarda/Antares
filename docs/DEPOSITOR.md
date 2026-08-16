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

- The vault sets a **strike** a few percent above the current price — currently **3 %**.
- It sells a call option on the collateral and collects a premium, which goes into the pool.
- **If XLM ends below the strike:** nothing happens. The pool keeps the collateral *and* the
  premium. This is the good case and it is also the common one.
- **If XLM ends above the strike:** the pool pays out the difference above the strike, out of its
  own collateral, and you keep the premium. Your upside above the strike is capped.

The trade is symmetric and honest: **you earn premium every round, and in exchange you give up
the part of a rally that goes past the strike.** If you believe XLM is going to double next week,
this is the wrong product for you.

**How far above? Currently 3 %, and that is closer than it sounds.** The strike sits where the
option is worth enough for somebody to actually buy it. When markets are calm — XLM's realized
volatility has recently been around a third of its yearly range — an option struck 10 % away is
worth almost nothing, so nobody bids and you earn nothing. Struck 3 % away it is worth buying, so
you get paid; the cost is that your upside stops at 3 % instead of 10 %. This is a real trade-off
and it is chosen deliberately, not tuned quietly: a covered call that never sells is not a
conservative version of this product, it is a vault that does nothing.

What you can never lose: more than the position itself. There is no leverage, no borrowing, no
margin call, and no liquidation anywhere in this protocol. The payout is mathematically bounded
below the collateral backing it, no matter how far the price moves.

---

## 2. Shares and the price per share

When you deposit, you receive **share tokens** representing your slice of the pool. They are
ordinary Stellar tokens: you can hold, transfer, or send them anywhere.

The pool's value per share (`pps`) changes only at the end of a round:

```
new value = collateral + premium collected − payout − fee
pps       = new value / shares outstanding
```

Premium pushes it up. A payout pushes it down. A round with no buyer leaves it exactly where it
was. Your XLM claim is always `your shares × pps`.

---

## 3. When you can move your money

This is the part that surprises people, so it gets the most space. The vault has a cycle, and
what you can do depends on where it is:

```
IDLE ──▶ AUCTION ──▶ ACTIVE ──▶ (settled / lapsed / annulled) ──▶ IDLE ──▶ ...
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
  convert, the money earns nothing, and while it is sitting there you cannot make a *new* deposit
  either; the interface will show a single prominent reminder with a countdown until you act. The
  fix is one click and it is always available: convert in the window, or cancel and get your XLM
  back at any time. Conversion happens at the vault's price *at the moment you convert* — not at a price frozen earlier. Waiting neither gains nor costs you anything:
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
was sold. This is the one genuine lock in the system, it is bounded by the epoch length, and it
is what you are agreeing to when you deposit.

### The idle window

After **every** round — whether it settled, found no buyer, or was annulled — there is a
guaranteed gap before a new one can open, long enough to deposit, convert pending deposits, or
exit instantly. It scales with the epoch length (a few hours on a weekly cycle). The interface
shows a countdown; you never have to guess.

---

## 4. Rounds that end without a premium

Both are normal, defined outcomes. Neither is an error and neither costs you anything:

- **No buyer showed up (lapsed).** No option was sold, no premium was earned, your collateral
  never moved, `pps` is unchanged. In a thin market this will happen, and it is honest to expect
  it.
- **The round was annulled.** If the price feed becomes unusable past a defined limit, the round
  is cancelled: buyers get their premiums refunded, no payout is made, `pps` is unchanged. Nobody
  profits from an oracle failure and nobody is trapped by one — cancellation can be triggered by
  anyone, including you.

---

## 4b. Limits you will actually hit

- **Minimum deposit.** Small deposits are rejected rather than silently rounded to zero shares.
- **Deposit cap.** The vault has a maximum size while it is young. If it is full, deposits are
  refused until someone withdraws or the cap is raised — nothing is lost, you simply cannot enter
  yet.
- **One pending deposit at a time.** If you deposited during a live round and haven't converted
  it, a second deposit is refused until you do (or cancel). This is the rule most likely to
  surprise you, which is why the interface nags about it.
- **The very first deposit** into a fresh vault permanently locks a negligible sliver of shares
  (worth a fraction of a cent) inside the contract. This is a standard defence that stops anyone
  from manipulating the share price when the pool is nearly empty.

## 5. What can go wrong

- **The code is unaudited.** This is the largest risk by a wide margin, and it is why this is
  testnet only.
- **You cap your upside.** If XLM rallies hard, you will earn less than simply holding. That is
  the trade, not a malfunction.
- **The premium may be small, or zero.** With no established buyers, some rounds will clear at
  the reserve price and some will not clear at all.
- **Settlement can be late.** If the price feed is stale, settlement retries until it works.
  Your funds are not at risk, but your claim may be delayed by hours.
- **The contract is upgradeable** by an admin key today. That is the protocol's single real
  trust concentration and it is documented in the [trust model](TRUST_MODEL.md) rather than
  buried.
- **Storage rent.** Stellar can archive dormant data. Every claim is computed from immutable
  records, so archival can delay a claim but never change or lose it — and any normal transaction
  restores what it touches.

---

## 6. Why there are no yield numbers

You will not find an APY here, or an expected return, or a projection. While the only buyer is
our own bot, any premium figure would be us paying ourselves and then quoting the result — the
number would travel and its disclaimer would not.

Once a buyer outside our control clears an auction, we publish realized premiums as raw basis
points per round, always shown next to how many recent rounds cleared with no buyer at all. Facts
with their misses attached, never annualized.

---

## 7. Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the contract actually works
- [`INVARIANTS.md`](INVARIANTS.md) — the properties that must always hold, and how they're tested
- [`TRUST_MODEL.md`](TRUST_MODEL.md) — who can do what to your money
- [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) — risks we know about and accept
