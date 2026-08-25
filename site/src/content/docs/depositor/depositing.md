---
title: Depositing
deck: XLM in, share tokens out — but only while no option is live, and for a reason that protects you rather than us.
---

> **Status —** Testnet only, unaudited, and the only bidder is a bot this project runs. Do not
> deposit anything you would mind losing. [Where this stands](../start/status.md).

## What you get

When you deposit, you receive **share tokens** representing your slice of the pool. They are
ordinary Stellar tokens — `aXLM-E` on the deployed vault, seven decimals, SEP-41 — so you can hold,
transfer, or send them anywhere a wallet or a DEX understands a token.

Your claim is always `your shares × price per share`. The price per share (`pps`) changes **only
when a round finishes**:

```
new value = collateral at open + premium collected − payout − fee − closing bounty
pps       = new value ÷ shares outstanding at open
```

Premium pushes it up. A payout pushes it down. A round with no buyer leaves it exactly where it was.
[How a round is settled](../mechanism/settlement.md) works this through with numbers.

The closing bounty is a small slice of the premium — 25 bps of it on the deployed vault, capped by
the contract at 100 bps — paid to whoever closed the round. Anyone can close a round, including
you. It exists so that closing never depends on someone being generous.

## When your deposit becomes shares

This is the part that surprises people, so it gets the most space.

### Depositing between rounds (`Idle`)

Your XLM converts to shares immediately at the current price, and you are in from the next round.
If you happen to have an unconverted pending deposit from an earlier round, this call converts it
for you first, automatically.

### Depositing while a round is live

Your XLM is held as a **pending deposit**. It is *not* part of the collateral, no option is written
against it, and it earns nothing that round — **because it was not at risk that round.**

Letting late money share in a premium that earlier money earned would be taking from the people who
took the risk. That is the whole reason this vault does not use continuous-deposit accounting: a
covered-call vault locks collateral for the duration of a round, and capital arriving mid-round
cannot be allowed to dilute the premium earned by capital that was actually exposed.

Two things you can do with a pending deposit:

- **Cancel it**, at any time, in any phase, for as long as it is still pending — you get the exact
  amount back. This is the one instant exit that works during a live round, and it is safe
  precisely because that money never backed an option. It works while the vault is paused.
- **Convert it to shares** once the round finishes — **and do not forget this step.** Until you
  convert, the money earns nothing, and while it is sitting there you cannot start a *new* pending
  deposit during a different live round.

**Conversion happens at the vault's price at the moment you convert**, not at a price frozen when
you deposited. Capital that sat pending took none of the intervening rounds' risk, so it enters at
today's price. That also means converting and cancel-then-redeposit are worth **exactly the same**,
which is why cancellation stays open for a pending deposit's whole life. Waiting costs you the
yield you would have earned as shares; it does not cost you price.

### Why shares are only ever minted between rounds

A share minted mid-round at an old price would acquire a claim on the live round's outcome that its
capital never backed. If the price then rose, total claims would exceed the pool and solvency would
break.

Burns are different and are allowed in any phase: burned shares stay in the round's denominator
snapshot, so the exiting holder gets exactly this round's price and nobody else's claim moves.

To guarantee that a usable window exists every cycle, a new round cannot open until `min_idle_gap`
has passed since the last one finalized — **two hours** on the deployed vault, and the contract
enforces that this gap is at least `epoch_duration ÷ 50` so it scales with the round rather than
being a fixed hour on a two-week option.

## The limits you will actually hit

| Limit | Value on the deployed vault | What happens |
|---|---|---|
| **Minimum deposit** | 10 XLM | Smaller deposits are rejected (`BelowMinDeposit`) rather than silently rounded to zero shares |
| **Deposit cap** | 100 000 XLM — roughly $19 600 at XLM's price on 2026-08-22 | Deposits are refused (`DepositCapExceeded`) once collateral plus pending deposits would exceed it. Nothing is lost; you simply cannot enter yet |
| **One pending deposit at a time** | — | If you have an unconverted pending deposit from an *earlier* round, a deposit during a live round is refused (`UnredeemedPending`) until you convert or cancel |
| **Paused** | — | An admin can stop new deposits. Pause can never touch the way out |
| **Worthless pool** | — | If the pool is genuinely worth less than one stroop per share-unit, minting is refused (`VaultWorthless`) rather than dividing by zero. Withdrawals still work — that asymmetry is the point |

The "one pending deposit" rule is narrower than it sounds, and it is the one most likely to
surprise you:

- Adding to the **same** round's pending is fine — it accumulates.
- Depositing **between rounds** converts the old one for you automatically.
- Only a deposit during a *different* live round, on top of an unconverted older one, is refused.

The refusal exists because the pending-deposit slot is one slot per address. Overwriting it would
strand the old amount inside the vault's accounting forever.

## The first deposit into a fresh vault

The very first deposit permanently locks **1 000 stroops** of shares — 0.0001 shares, a fraction of
a cent — inside the contract itself. It comes out of the first depositor's own mint, and it is
never redeemable, because the vault has no path that spends its own balance.

This is a standard defence. Without it, a holder could burn the supply back to nearly zero, at which
point every subsequent small deposit would mint zero shares while its XLM joined the pool — and the
next depositor's capital would silently belong to the attacker. The contract validates that
`min_deposit` is greater than that floor at construction *and* on every parameter change, so the
subtraction can never take a first depositor to zero.

Both mints emit their SEP-41 `mint` event and together sum to the total supply, so an indexer
rebuilding supply from the event stream gets the same number the contract reports. If you are
checking `Σ balances == shares_outstanding` yourself,
[**count the vault's own address**](../trust/invariants.md#i5-share-supply-is-exact) — a check
that skips it reports a permanent 1 000-stroop shortfall and is wrong.

## One thing the vault cannot protect you from

**XLM sent directly to the contract address is gone.** Deposits must go through `deposit()`. A plain
transfer to the vault's address belongs to nobody, is credited to no one, and there is no sweep
function to recover it — deliberately, because code that can move unattributed funds can move
attributed ones.

The same is true of burning your share tokens, or sending them to the contract's own address. The
token standard permits both and the vault can undo neither.

## Next

- [Getting your money out](withdrawing.md) — the three exit routes and their timing
- [What you give up](what-you-give-up.md) — the cost of the trade, in coins
- [Risks, stated plainly](../trust/risks.md)
