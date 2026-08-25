---
title: Getting your money out
deck: Three exit routes, none of which passes through the operator, and none of which pause can close.
---

Every route below works while the vault is **paused**. Two of them pay immediately; the third pays
once the live round has been closed — and closing is itself permissionless, so **the one thing that
has to happen first is a transaction you can send yourself.** That is invariant
[I8](../trust/invariants.md#i8-the-exit-path-cannot-be-paused), and it is the property that makes it
safe for anyone to hold a pause key at all.

## The three routes

| Route | When | What you get | Timing |
|---|---|---|---|
| **Cancel a pending deposit** | Any phase, while it is still pending | The exact amount you deposited | Immediate |
| **Withdraw between rounds** | While the vault is `Idle` | Shares burned, XLM paid, same transaction | Immediate |
| **Queue a withdrawal** | While a round is live | Shares burned now, XLM at this round's closing price | When the round finalizes |

## Cancelling a pending deposit

```rust
fn cancel_pending_deposit(from: Address) -> i128;
```

Works in any phase, including while a round is live and including while the vault is paused, and
returns the exact amount — no pricing, no rounding, no queue. It is safe precisely because that
capital never backed an option.

## Withdrawing between rounds

```rust
fn request_withdraw(from: Address, shares: i128, require_idle: bool) -> i128;
```

Burn shares, get XLM, same transaction — **if the vault is still between rounds when your
transaction lands.** Opening a round is permissionless, so anyone can start one the moment the gap
has passed, and if that happens first your withdrawal becomes the queued kind instead.

That is what `require_idle` is for:

- `require_idle = true` — the call **reverts harmlessly** (`WrongPhase`) if a round started first.
  Nothing is burned, nothing is queued, you try again in the next window. This is the safe choice
  and it is what the interface defaults to.
- `require_idle = false` — go ahead either way, accepting that you may end up queued.

The flag exists because an `open_epoch` landing one ledger ahead of you should never silently
convert an instant exit into a multi-day one.

**The pool can always honour every instant exit at once.** Between rounds, `locked_assets ×
10 000 000 ≥ shares_outstanding × pps` always holds, so the vault is never in a state where the
first few exits are paid and the rest bounce — invariant
[I9](../trust/invariants.md#i9-instant-withdrawals-are-always-covered).

## Queuing a withdrawal during a live round

Your shares are burned immediately and a claim is recorded against the round. **You exit at this
round's closing price, whatever it turns out to be** — not at yesterday's price, and not at a price
you can choose.

Once the round finalizes:

```rust
fn claim_withdraw(from: Address) -> i128;
```

`claimable = ⌊your burned shares × pps[round] ÷ 10 000 000⌋`, and there is no path in the contract
that pays out a round which has not finalized.

Two details worth knowing:

- A second request in the same live round **accumulates** into the existing record rather than
  replacing it.
- A request made while an *older* finalized claim is still unclaimed **pays out the old one first**,
  automatically, in the same transaction. There is one claim slot per address, and a silent
  overwrite would destroy a claim you had already earned.

## The one genuine lock

You cannot leave *before* a live round finalizes, because your capital is what backs the option
that was sold. This is the single lock in the system and it is what you agree to when you deposit.

It is bounded in **outcome** rather than in time: past a fixed limit — `expiry + 21 hours` at the
deployed vault's parameters — the round can be closed without reading the price feed at all. But
somebody still has to make that call, and **that somebody can be you.** Closing is permissionless
and pays the caller 25 bps of the round's premium.

So the worst case is not "waiting for us". It is one transaction you can send yourself.
[If something breaks](../trust/incidents.md) is the page for that.

## The idle window

After **every** round — settled, lapsed, voided or unresolved — there is a guaranteed gap before a
new one can open. On the deployed vault it is **two hours**, and the contract enforces that it is at
least `epoch_duration ÷ 50` so it scales with the round length.

In that window you can deposit, convert a pending deposit, or exit instantly.

**Anyone may end the idle window** as soon as it reaches its minimum width — the gap is a floor, not
a reservation. That is a real cost of another participant's timing, and `require_idle` is the
protection against it.

## What can delay a claim, and what cannot change it

**Late is a defined state; wrong is not.** If the price feed cannot be read, closing reverts and may
be retried by anyone — but not indefinitely. The deadline is in
[The four ways a round ends](../mechanism/round-outcomes.md#unresolved-nobody-looked-in-time-or-the-adapter-itself-failed).
Your funds are not at risk; your claim may be delayed by hours.

**Storage rent.** Stellar can archive dormant data. Every claimable amount is a pure function of
immutable records, so archival can delay a claim but never change or lose it. Any normal
transaction restores what it touches, and there is a public `restore_position(user)` call that
anyone can make for anyone — including while the vault is paused — so a returning depositor with an
archived entry has a deterministic route rather than a support ticket.

**A finalized round is never rewritten.** Not by settlement, not by an upgrade, not by any admin
action ([I7](../trust/invariants.md#i7-round-records-are-immutable)). Every unclaimed withdrawal is
computed from one, potentially long after the fact. If history could be rewritten, every pending
claim would be at the mercy of whoever could rewrite it.

## The nine calls that always work

Whatever else is broken, and whether or not the vault is paused:

`close_round` · `request_withdraw` · `claim_withdraw` · `claim_payout` · `claim_refund` ·
`claim_fee` · `cancel_pending_deposit` · `redeem_shares` · `restore_position`

Pause blocks exactly three things — `deposit`, `bid`, `open_epoch` — and all three are ways *in*.
Pause therefore needs no timeout: a timeout would imply that pause *can* hold funds hostage.
