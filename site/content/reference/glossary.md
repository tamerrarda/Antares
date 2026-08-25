---
title: Glossary
deck: Every term this site uses, defined once.
---

# Glossary

## The option

| Term | Meaning |
|---|---|
| **Call option** | The right, not the obligation, to buy something at a fixed price on a fixed date |
| **Covered call** | A call sold against an asset the seller already holds, so nothing is borrowed and nothing has to be found later |
| **Strike** | The price above which the buyer's option pays. Fixed when the round opens, at a set percentage above the market price — 3 % on the deployed vault |
| **Premium** | What the buyer pays up front. It goes to depositors, and it is theirs regardless of the outcome |
| **Notional** | The amount of XLM the option is written against |
| **Out of the money / in the money** | The option is not worth exercising / is worth exercising |
| **European** | Exercisable only at expiry, never before |
| **Cash settlement** | The option pays a difference in XLM rather than delivering the asset. No second leg, no delivery risk |
| **Vega** | Sensitivity to volatility. XLM options do not trade on a major venue, so a bidder here cannot hedge it |

## The vault

| Term | Meaning |
|---|---|
| **Round / epoch** | One full cycle: the vault sells an option, it runs to expiry, and the result is recorded |
| **Phase** | Where in the cycle the vault is: `Idle`, `Auction` or `Active` |
| **Share / `pps`** | Your claim on the pool, and its value in XLM (*price per share*). Changes only when a round finishes |
| **Pending deposit** | XLM deposited during a live round. Not yet shares, not backing the option, cancellable at any time |
| **Idle window** | The guaranteed gap after every round before a new one can open — two hours on the deployed vault. Deposits mint instantly and withdrawals pay instantly in it |
| **Dead shares** | 1 000 stroops of share tokens minted to the vault itself on the first deposit and never redeemable. It floors the supply against an inflation attack |
| **Deposit cap** | The maximum total of collateral plus pending deposits the vault will accept — 100 000 XLM on the deployed vault |
| **Notional offered** | The whole of the vault's locked collateral, offered as one lot when the round opens |

## How a round ends

| Term | Meaning |
|---|---|
| **Settled** | Expiry reached and the feed answered. Premium to depositors, payout to bidders if `spot > strike` |
| **Lapsed** | The auction closed with nothing sold. No premium, no loss, share price unchanged. Resolves 45 minutes into the round |
| **Voided / annulled** | Cancelled because the price feed was unusable at expiry past a defined bound. Premiums refunded exactly, share price unchanged |
| **Unresolved** | Nobody closed the round before its expiry moment aged out of the feed's history, so it can no longer be decided on evidence. The premium stays with depositors and the payout is zero — the rule is chosen so that nobody who could cause the delay gains by it |
| **Bounty** | A slice of the premium paid to whoever calls `close_round` — 25 bps of the premium on the deployed vault, capped by the contract at 100 bps |
| **`wclaims`** | The withdrawal-queue amount credited when a round finalizes. Carried by all four finalization events |

## The auction

| Term | Meaning |
|---|---|
| **Dutch auction** | A descending-price auction: the price starts high and falls until someone accepts |
| **Reserve / floor** | The lowest premium the curve reaches. Approached at `auction_end` and never transacted at |
| **Partial fill** | Being filled less than you asked for, because that is all that remained. The expected case |
| **Slippage guard** | `max_premium_bps` — the bidder's own ceiling, mandatory on every bid |
| **Fair value** | Black-Scholes value of the option at a stated volatility, in basis points of notional. Published so the curve can be checked against it, never as a forecast |

## The price feed

| Term | Meaning |
|---|---|
| **The feed** | The external CEX & DEX XLM/USD price source the adapter reads. A third-party contract this project neither operates nor controls; its address is pinned at construction and is on [What is deployed](deployment.md) |
| **Adapter** | The separate contract that owns the sampling grid, the medians and the normalization. It has no admin and no upgrade path |
| **TWAP** | Time-weighted average price. Here it is a **median** of samples across a window, never a mean and never a single tick |
| **Anchored read** | A read of the feed as it stood at a past moment — at expiry — rather than now |
| **Reach limit** | How far back the feed's history can still be read: 255 ticks less the guard window, about 20 h 15 m at the live resolution |
| **Resolution** | The feed's tick interval, read live on every call. 300 seconds today |

## Roles

| Term | Meaning |
|---|---|
| **Depositor** | Whoever puts XLM in and holds shares |
| **Bidder / counterparty** | Whoever buys the option |
| **Keeper** | A bot that calls `open_epoch` and `close_round` on a timer. A convenience — everything it does, anyone can do, and it cannot choose how a round ends |
| **Admin** | The key that can pause, set parameters, and upgrade the code. It cannot move funds, mint shares, rewrite a round, or choose a settlement outcome |
| **Fee recipient** | The address that can pull the accrued protocol fee. The fee is zero |

## Units and conventions

| Term | Meaning |
|---|---|
| **Stroop** | One ten-millionth of an XLM. All amounts are `i128` stroops, 7 decimals |
| **Basis point (bps)** | One hundredth of a percent. 10 000 bps = 100 % |
| **`PRECISION`** | 10 000 000 — the scaling factor for price per share |
| **Permissionless** | Two senses, and they are not the same: `open_epoch` and `close_round` take **no authorization at all**; `bid` has **no gatekeeper** but is signed by the bidder |
| **Pull-based** | Nothing is ever pushed to you. Every outbound amount is claimed by its owner, so no payout path can fail for everyone because one address cannot receive |
