---
title: Risks, stated plainly
deck: Everything that can go wrong, ordered by how likely it is to matter to you — starting with the one that dwarfs the rest.
---

This page collects every stated risk in one place. Nothing here is hedged, and nothing is left for a
footnote.

## 1. The code is unaudited

**This is the largest risk by a wide margin, and it is why this is testnet only.**

Every invariant is asserted by this project's own tests: a property suite run after every state
transition, three fuzz targets — call-sequence, auction and settlement math — and a differential
reference implementation written in Python from the spec rather than from the Rust, replayed
against shared vectors.

**An internal security review was carried out** against known Soroban vulnerability classes.
Unlike everything else in that list, **there is no published artifact behind that sentence** — no
report you can open, no findings list you can count. It is a statement by the people who wrote the
code about work they did on it, and it is written here as one rather than presented as evidence.

**One thing about that list is stated rather than left to be assumed.** A mutation run also exists,
at a bar of zero survivors, and it is **scoped to the single module nothing else grades** — the
others are covered by a byte-for-byte differential against references written from the spec, which
is the sharper instrument where both exist. It is not a blanket claim about the whole crate, and it
is not written here as one.

**None of that is an audit.** Nobody outside this project has reviewed this code, and the review that
has been done was done by the people who wrote the thing.

## 2. The counterparty side is unproven

No professional options market makers operate on Stellar. XLM futures and perpetuals exist, so delta
can be hedged; **XLM options do not trade on a major venue**, so a bidder cannot lay off volatility
risk.

This is the project's largest open question and it is a market question, not a code one. It is also
the thing the whole design rests on: an auction with nobody in it discovers no price, and a vault
whose auctions never clear earns its depositors nothing. Every correctness property on this site can
hold perfectly while that stays true.

The failure this project is most exposed to is therefore **counterparty concentration** — a bidder
base small enough that its departure takes the premium to zero — and it is not a failure more code
can fix. There is a
[published condition under which this project stops](../start/why-antares.md#the-stop-condition).

## 3. Testnet is wiped on a schedule

Stellar's test network is reset roughly every quarter, with at least two weeks' notice. A reset
deletes **all** contract state: the vault, your shares, your pending deposit, any unclaimed
withdrawal, any unclaimed payout or refund. Nothing survives it and nothing can be restored from it.
Transaction hashes stop resolving on explorers.

**This is a calendar, not an uncertainty.** Check the next reset date before depositing, and claim
promptly rather than at leisure.

## 4. The contract is upgradeable behind an admin key

Today that key is a single address held by this project. Whoever holds it can replace the contract's
code, which means that in the limit they can do anything the guarantees on this site rule out.

This is the protocol's one real trust concentration, and it is chosen deliberately over immutability
because the code is unaudited: immutability before an audit is an unfixable bug waiting to happen.
Before any mainnet deployment it becomes a timelocked multisig whose delay exceeds a full round plus
the bound past which a round closes regardless of the feed.

The full statement, including what upgradeability does *not* cover, is on
[Who can do what to your funds](trust-model.md#3-upgradeability-the-honest-part).

## 5. Oracle dependency

Settlement correctness rests entirely on the price feed. The design bounds this — a deep aggregated
off-chain feed rather than any manipulable on-chain market, medians rather than ticks, a staleness
bound, a self-consistency breaker, and a dead-feed policy that never traps funds. Even a fully
compromised feed cannot extract more than one round's sold notional, because there is no leverage
anywhere in the system.

**Bounding a risk is not eliminating it**, and no amount of testnet activity proves behaviour under
real volatility. [The price feed](../mechanism/price-feed.md) is the full envelope.

## 6. Adverse selection

A bidder who times the auction curve against fair value gains at depositors' expense. The auction's
reserve bounds this to under-fair *time value* — the in-the-money guard prevents selling intrinsic
value outright — but a volatility-blind mechanism cannot eliminate it.

## 7. You cap your upside, measured in coins

If XLM rallies hard, you will end the round with **fewer XLM than you started with** and you will
have earned less than simply holding. That is the trade, not a malfunction, and
[What you give up](../depositor/what-you-give-up.md) puts a table on it.

## 8. The premium may be small, or zero

With no established buyers, some rounds will clear at the reserve and some will not clear at all. An
auction that lapses costs depositors nothing and earns them nothing.

## 9. Settlement can be late

If the price feed is stale, closing reverts and anyone may retry — and it cannot retry indefinitely.
Your funds are not at risk, but your claim may be delayed by hours. The deadline is on
[The four ways a round ends](../mechanism/round-outcomes.md).

## 10. Timing costs imposed by other participants

- Whoever opens a round sets the strike's basis, so a buyer who opens on a dip gets a cheaper option
  at depositors' expense. The feed's guards bound how far the basis can stray, but not to zero.
- A new round can open before your instant exit lands — `require_idle` turns that into a harmless
  revert.
- Anyone may end an idle window the moment it reaches its minimum width.

## 11. New deposits can be paused

An admin can stop deposits, new bids and new rounds. **Pause can never touch the way out**: closing
a round, requesting and claiming a withdrawal, cancelling a pending deposit, redeeming, claiming a
payout or refund, and restoring an archived position all keep working while paused. But it can stop
you taking a *new* position.

## 12. A protocol fee exists in the arithmetic

It **ships at zero**, and at zero because no transaction ever set it — not because a deploy argument
happened to be zero — so any non-zero value leaves a public transaction behind. It is capped at 20 %
*of the premium*, never of your capital, and it is snapshotted when a round opens, so a change can
never apply to a round you were already in.

## 13. Storage rent and archival

Stellar can archive dormant data. Every claim is computed from immutable records, so archival can
delay a claim but never change or lose it, and any normal transaction restores what it touches. A
public `restore_position(user)` call exists for the same reason.

For a bidder there is a discoverability cost: an unclaimed payout may be archived after about a
month, and there is no on-chain function that lists your fills. See
[Bidding, and getting paid](../bidder/bidding-and-payout.md#finding-it-later-is-your-job).

## 14. Mistakes the vault cannot undo

- **XLM sent directly to the contract address is gone.** Deposits must go through `deposit()`. A
  plain transfer belongs to nobody, is credited to no one, and there is no sweep function —
  deliberately, because code that can move unattributed funds can move attributed ones.
- **Burning your share tokens, or sending them to the contract's own address**, is permitted by the
  token standard and cannot be undone by the vault.

These are wallet mistakes rather than protocol risks, and they are the ones the vault cannot protect
you from.

## 15. For counterparties specifically

- **The vault can refuse to sell** at any price you would accept, if the option has drifted into the
  money. You may show up and find nothing to buy.
- **A thin market.** You may be the only bidder. An uncontested Dutch auction walks to the floor —
  good for you, and a signal that price discovery is not happening yet.
- **The unresolved deadline can cost you a payout you earned**, if nobody closes the round in about
  twenty hours. You can remove that risk yourself by closing the round; it is permissionless and
  pays a bounty.

## 16. No distribution

This project has no users, no integrations and no audience. Being technically correct does not
produce a counterparty, and nothing in the design substitutes for one. Open source and public
progress are the only mitigation on offer, and they are a weak one.

## 17. Two limits of the evidence itself

- **One wasm hash is host-dependent.** The same commit compiles to the same size and the same
  exported interface on macOS and Linux, and to two different SHA-256s — the type table is emitted in
  a different order and every index into it follows. Reproduce on the host that built the artefact;
  [What is deployed](../reference/deployment.md#reproducing-the-hashes) names it.
- **One stated precondition in I10.** If the price feed lengthens its own tick interval mid-round,
  the oracle-free fallback can fire while an anchored read would still have answered, costing an
  in-the-money buyer their payout. Exposure is one round rather than open-ended, because opening a
  round re-checks the live feed.

---

If you find something on this site that contradicts the code, **that contradiction is the
vulnerability.** [Report it as one](../reference/security.md).
