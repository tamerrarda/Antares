---
title: Where this actually stands
deck: One vault, on testnet, unaudited, with no closed round yet. This page is the single home for that sentence.
---

# Where this actually stands

Every other page on this site links here rather than repeating it. If a page describes something
that is designed but not running, it says so at that point and links back to this one.

## In one table

**As of 2026-08-25.** The row that goes stale first is the round count: a round closing changes it,
and nothing on this site updates itself. For live state, read the vault contract or its events on
an explorer — [What is deployed](../reference/deployment.md) has the address.

| | |
|---|---|
| Network | **Stellar testnet only.** No mainnet deployment exists. |
| Audit | **None.** No external party has audited this code. |
| Vaults deployed | **One** — `aXLM-E`, a 3-day round struck 3 % out of the money |
| Deployed at | 2026-08-24T09:11:48Z, from a clean tree at commit `87e4224a` |
| Price source | An external CEX & DEX XLM/USD feed — **a third-party contract this project does not control** |
| Rounds closed on this vault | **None yet** |
| Independent counterparties | **None yet.** The only bidder is a reference bot this project operates |
| Published yield figures | **None**, deliberately — see [Pricing it yourself](../bidder/pricing.md) |

Addresses, hashes, parameters and the transactions are on
[What is deployed](../reference/deployment.md).

## What is proven today, and what is not

**Proven.** The deployment. The contract is on chain at real parameters, reading a live feed nobody
here operates, and it accepted a deposit and a withdrawal request in the same run. Its record says
`economicallyMeaningless: false` — the field the deploy script stamps on any instance that could
never be presented as evidence.

**Not proven.** The cycle. Phase 1's gate asks for a *closed* round at these parameters — opened,
sold, settled — and no round has closed on this instance. Until one has, everything on this site
about settlement describes tested code rather than observed behaviour.

## What changed on 2026-08-24

Until that date the deployed instance ran a **fast-test profile**: second-scale durations against a
mock price source this project controls. Its record was stamped `economicallyMeaningless: true`,
which is permanent and which bars a profile from ever being cited as demand evidence. That instance
is gone. The one running now is not a mock, and the difference is recorded in the deployment file
rather than asserted here.

The same day, the auction premium bands for all five parameter sets were re-derived. They had been
sized against an *assumed* volatility of 33.7 %; measured against a refreshed price series, XLM's
90-day realized volatility came back at **103.0 %**, and every set failed its coherence gate. The
bands were raised. Numbers on this site that depend on volatility are dated for that reason.

## One instance is deployed; five are designed

The design provides for **five instances of the same binary** running side by side on different
terms — how long a round runs and how far out of the money the strike sits — each with its own
share token (`aXLM-A` … `aXLM-E`) and its own auction. The reason is honesty about what is not
known: one vault answering one set of terms cannot distinguish *"nobody wants to sell options on
XLM"* from *"nobody wants **these** terms"*.

**Only `aXLM-E` is deployed.** Anywhere this site describes the five, it is describing a design,
and it says so.

## The counterparty is us, and it is labelled

During testnet the only bidder is an open-source reference bot operated by this project. It is
deliberately naive: it targets a configured premium in basis points and does not model volatility.
It exists to test the mechanism, not to set a price. **Its fills are not market evidence and are
not treated as any.**

If you are an independent party reading this, you are the thing this project most needs and does
not have. [Pricing it yourself](../bidder/pricing.md) is written for you, and a refusal with a
reason is worth more to us than a fill.

## Unaudited means unaudited

Every invariant is asserted by this project's own tests: a property suite run after every state
transition, three fuzz targets — call-sequence, auction and settlement math — and a differential
reference implementation written in Python from the spec rather than from the Rust, replayed
against shared vectors.

**An internal security review was carried out** against known Soroban vulnerability classes.
Unlike everything else in that list, **there is no published artifact behind that sentence** — no
report you can open, no findings list you can count. It is a statement by the people who wrote the
code about work they did on it, and it is written here as one rather than presented as evidence.

**Two things about that list are stated rather than left to be assumed.** CI in this repository has
no push trigger — it runs only when it is dispatched by hand — so those checks are a thing that
*can* be run rather than a thing that runs continuously. And the **mutation run is a gate for a
later phase, not one already passed**: it is scoped to the single module nothing else grades, at a
bar of zero survivors, and two further modules have twenty-two unjudged timeouts recorded as an open
item.

**None of that is an audit.** Every correctness claim on this site is still ours, checked by people
who wanted it to be true.

## Testnet is wiped on a schedule

Stellar's test network is reset roughly every quarter, with at least two weeks' notice. A reset
deletes all contract state: the vault, your shares, your pending deposit, any unclaimed withdrawal
or payout. Nothing survives it and nothing can be restored from it. Transaction hashes stop
resolving on explorers too, which is why closed rounds are archived into the repository as they
happen.

This is a calendar rather than a risk. Check the next reset date before depositing anything, and
claim promptly rather than at leisure.

## Gaps we know about

- **No closed round at these parameters.** Stated above; it is the Phase 1 gate.
- **The walkthrough is drafted and unfilled.** The cycle is described in full on
  [One round, end to end](../mechanism/round-lifecycle.md), but the separate
  transaction-by-transaction evidence document — the one that resolves every step to a public hash —
  sits in the repository with its narration final and every hash still marked `TBD`. A hash from a
  fast-test round would answer a different question, so none has been filled in.
- **Two live drills have results but no script.** The pause drill and the upgrade drill were
  executed against testnet on 2026-08-21 with real transactions — the first confirmed that none of
  the nine unpausable calls refused while paused and that two of them succeeded, the second spanned
  a round so that new code closed a round old code had opened. Neither has a runnable script in the
  repository, so the results are recorded and the procedure is not reproducible from a clean
  checkout. That is a gap in the evidence rather than in the design.
- **The differential corpus is red on a known open item.** The four hand-written vectors agree byte
  for byte across all four replayed sections. A generated 204-vector corpus does not: about 87 fail,
  from a single categorised cause that the repository records as a **specification** disagreement
  rather than a bug in either side — which error a bid placed after the offer sold out should
  return. It is unruled rather than unnoticed, and until it is ruled the corpus build stays red for
  that reason and no other.
- **One wasm hash is host-dependent.** The same commit compiles to the same size and the same
  exported interface on macOS and Linux, and to two different SHA-256s. Reproduce on the host that
  built the artefact; [What is deployed](../reference/deployment.md#reproducing-the-hashes) names it.
