---
title: Where this stands
deck: One vault, on testnet, unaudited, and priced by an auction nobody has yet bid into. This page is the single home for that sentence.
---

Every other page on this site links here rather than repeating it. If a page describes something
that is designed rather than deployed, it says so at that point and links back here.

## In one table

| | |
|---|---|
| The contract | **Written, tested and deployed.** What separates it from a mainnet deployment is an audit and a proven counterparty, not a rewrite |
| Network | **Stellar testnet only.** No mainnet deployment exists |
| Audit | **None.** No external party has audited this code |
| Vaults deployed | **One** — `aXLM-E`, a 3-day round struck 3 % out of the money |
| Price source | An external CEX & DEX XLM/USD feed — **a third-party contract this project does not control** |
| Independent counterparties | **None.** The only bidder is a reference bot this project operates |
| Published yield figures | **None**, deliberately — see [Pricing it yourself](../bidder/pricing.md) |

Addresses, hashes, parameters and the deployment transactions are on
[What is deployed](../reference/deployment.md). For anything live — the current round, what it sold,
how it ended — read the contract or its events on an explorer. **This site describes the mechanism;
it does not mirror the chain**, and nothing here updates itself.

## What this site claims, and what it does not

**It claims the mechanism.** Every entry point, every guard, every branch and every number on this
site is the shipped contract's, checked against the source rather than described from memory. The
arithmetic is reproducible from figures printed on the same page.

**It does not claim a market.** An auction with nobody in it discovers no price. Until an address
outside this project fills one, the premium is a number this project paid itself, and it is treated
as evidence of nothing.

**It does not claim correctness.** See below.

## Testnet is the network, not the design

Everything here was built to mainnet semantics from the first line — the same accounting, the same
trust model, the same failure handling. Testnet is a network parameter rather than a different
design, and that is a checkable constraint rather than a slogan: **the binary deployed to mainnet
must hash identical to the one that ran on testnet and was audited.** Everything that differs
between the two networks is a constructor argument or an admin call. There are no build flags, no
conditional compilation and no network branches in the contract, and a static source check refuses
any that appear.

## One instance is deployed; five are designed

The design provides for **five instances of the same binary** running side by side on different
terms — how long a round runs and how far out of the money the strike sits — each with its own share
token (`aXLM-A` … `aXLM-E`) and its own auction. The reason is honesty about what is not known: one
vault answering one set of terms cannot distinguish *"nobody wants to sell options on XLM"* from
*"nobody wants **these** terms"*.

**Only `aXLM-E` is deployed.** Anywhere this site describes the five, it is describing a design, and
it says so.

## The counterparty is us, and it is labelled

The only bidder is an open-source reference bot operated by this project. It is deliberately naive:
it targets a configured premium in basis points and does not model volatility. It exists to test the
mechanism, not to set a price. **Its fills are not market evidence and are not treated as any.**

If you are an independent party reading this, you are the thing this project most needs and does not
have. [Pricing it yourself](../bidder/pricing.md) is written for you, and a refusal with a reason is
worth more to us than a fill.

## Unaudited means unaudited

Every invariant is asserted by this project's own tests: a property suite run after every state
transition, three fuzz targets — call-sequence, auction and settlement math — and a differential
reference implementation written in Python from the spec rather than from the Rust, whose replay
matches the contract's own arithmetic byte for byte.

**An internal security review was carried out** against known Soroban vulnerability classes. Unlike
everything else in that list, **there is no published artifact behind that sentence** — no report you
can open, no findings list you can count. It is a statement by the people who wrote the code about
work they did on it, and it is written here as one rather than presented as evidence.

**None of that is an audit.** Nobody outside this project has reviewed this code, and the review that
has been done was done by the people who wrote the thing. Every correctness claim on this site is
still ours, checked by people who wanted it to be true.

## Testnet is wiped on a schedule

Stellar's test network is reset roughly every quarter, with at least two weeks' notice. A reset
deletes all contract state: the vault, your shares, your pending deposit, any unclaimed withdrawal or
payout. Nothing survives it and nothing can be restored from it. Transaction hashes stop resolving on
explorers too, which is why closed rounds are archived into the repository as they happen.

This is a calendar rather than a risk. Check the next reset date before depositing anything, and
claim promptly rather than at leisure.
