---
title: The price feed
deck: Every settlement number comes from a feed this project does not control, through an adapter nobody can upgrade, behind guards that never invent a price.
---

# The price feed

Settlement correctness rests entirely on the price feed, so every failure mode gets a defined
behaviour and **none of them trap funds.**

## Which feed, and why that one

| | |
|---|---|
| Source | **An external CEX & DEX XLM/USD feed** — prices aggregated from deep off-chain markets |
| Address | [`CCYOZJCO…MJRN63`](https://stellar.expert/explorer/testnet/contract/CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63) — a third-party contract, not this project's |
| Tick resolution | 300 seconds, read live on every call |
| Feed decimals | 14, normalized to 7 by the adapter |
| Reachable depth | 255 ticks = 76 500 s |

**Deliberately not an on-chain order book**, and that choice is part of the security model rather
than a configuration detail.

A price read from a thin on-chain market is a price a single trade can set. A contract reading such
a feed can be entirely correct — every guard firing exactly as written — and still settle against a
number somebody bought for the cost of one transaction, because the manipulation happened outside
the contract and arrived as a legitimate print. **That whole class of failure is a property of the
source, not of the code that reads it**, which is why the source is pinned at construction, has no
setter, and is stated as part of the trust model rather than treated as plumbing.

## The adapter, and the thing it does not have

The vault does not call the feed directly. It calls a small **price adapter** contract that owns
every rule depending on the feed's tick and reachable depth — the sampling grid, the medians, the
normalization, and the answer to *"can this feed honour a round with this timing?"*.

The adapter's address is fixed at the vault's construction. **There is no `set_oracle` in the
contract at all**; repointing the price feed requires a reviewed code upgrade.

And the adapter itself:

> **has no admin and no upgrade path of its own.**

Its exported surface is `__constructor`, `reading`, `spot_check`, `supports_round` — asserted at
deploy — and nothing else. If it could be upgraded, whoever held that key could move every
settlement price silently, which would make it a second trust concentration as powerful as the
vault's upgrade key. It cannot, so that key is the only one there is.

## How a price is actually produced

Never a single tick. On each call the adapter takes **seven point queries** on a grid derived from
the feed's live resolution and reduces them to two medians:

- **The short window** — three samples spanning `twap_window` (15 minutes). **All three must be
  readable.** A median of two has zero outlier resistance — it is whichever of the pair the
  tie-break names — and outlier resistance is the entire reason a median was chosen over a mean.
- **The guard window** — five samples spanning `guard_window` (1 hour), of which at least three
  must be readable. If the surviving count is even, the furthest-back sample is dropped so the set
  stays odd.

Both medians are taken over an **odd** set, so there is no tie-break to specify and no second
definition to keep in sync with the Python reference implementation that checks this arithmetic
byte for byte.

A sample whose reported timestamp falls outside its own window is discarded — a stamp outside a
window is not evidence about that window.

## The guards, and which ones run when

Two read modes, and the difference is the point.

| Guard | At `open_epoch` (live) | At `close_round` (anchored to expiry) |
|---|---|---|
| Enough settlement-grade records | yes → `OracleStale`, retry | yes → this is the void branch |
| Staleness relative to *now* (`max_staleness`, 10 min) | **yes** → `OracleStale`, retry | **no** — meaningless for a frozen window |
| Positive price | yes → `OracleInvalidPrice` | yes → void |
| Self-consistency breaker (short vs guard window, `max_deviation_bps` = 1 %) | **yes** → `OracleDeviation`, retry | **no** — see below |
| Coarse 100× sanity bound against the last settled price | yes | yes |
| Feed scale unchanged since the round opened | establishes it | yes → transient, retry |

**The self-consistency breaker runs at open only, and that is deliberate rather than an omission.**
It compares a short window against a longer one *of the same moment*: a feed artifact skews the
short window hard and the long one barely, while a genuine market move carries both. So it fires on
malfunction and **never on a sustained real move**. At close, the window is frozen history that
cannot recover from a rejection — a breaker there could only ever convert a settleable round into
an annulled one and confiscate a payout the buyer had earned. The medians already carry the
artifact resistance instead.

**A feed scale change is treated as a fact about now, not about the window.** If the feed changes
its decimals mid-round, re-reading old records under the new scale rescales history rather than
reading it. A large change floors every price to zero, which is caught. A small one — 14 to 15 —
floors nothing and produces a price wrong by exactly 10×, which the 100× bound would admit. So a
mismatch reverts and the round settles normally if the feed reverts.

## The escalation ladder

Retry on a transient failure, annul only on evidence, and never invent a price. **Every rung is
permissionless.**

| Condition | Behaviour |
|---|---|
| Normal | Settle at the median of the short window as it stood at expiry |
| Adapter traps, panics or exhausts its budget | `close_round()` reverts with `OracleUnreachable`; anyone retries. This is explicitly **not** grounds to annul: it says nothing about the expiry window |
| Feed demonstrably unusable **at expiry**, before `expiry + 12 h` | Reverts with `OracleNotDeadYet`; anyone retries. The grace period exists so a transient present-tense failure is never recorded as "the feed was dead at expiry" |
| Feed demonstrably unusable **at expiry**, past `expiry + 12 h` | **Voided by anyone.** Every premium refunded exactly, payout zero, share price unchanged |
| Expiry older than the feed's reachable history (about **20 h 15 m**) | **Unresolved by anyone.** Premium kept by depositors, payout zero |
| The adapter never recovers at all | **Unresolved at `expiry + 21 h`, without calling the adapter** |

**The contract never invents a price.** No fallback settles on a fabricated or clamped value,
because a wrong settlement is strictly worse than a refunded one.

The last row is the load-bearing one. It is the only terminal path that survives an adapter that
cannot be invoked, and it is what makes *"no oracle state can trap funds"* a property of the code
rather than a sentence about it. The bound is validated on-chain to sit strictly beyond the feed's
reachable history and is bounded above so no admin setting can push it out of reach, so it returns
the outcome a working adapter could only have returned at that instant.

## What the feed has to promise before a round opens

`open_epoch` asks the adapter whether it can honour a round of this length, and the adapter answers
against **eight conditions** evaluated on its own live resolution. Among them:

- The windows can hold three and five distinct ticks on the grid that is live *now*.
- `oracle_dead_after + guard_window + settle_grace` fits inside the reachable depth — so the void
  window has a guaranteed width.
- `unresolved_after` sits **strictly above** the reachable limit, so the evidence-free fallback
  fires only after the evidence is genuinely gone, and **no higher than** the reachable limit plus
  `settle_grace`, so no admin setting can push the fallback out until it never fires.
- The feed's own sponsorship outlasts the round. A sponsorship lapse deletes records that existed
  at expiry, so an anchored read afterwards would find an empty window and void a round written
  against a perfectly healthy feed. `expires()` is public, so left unguarded an out-of-the-money
  bidder could read the eviction date and simply wait.

A round that the feed cannot honour does not open. That is the first rung of the ladder and the one
that does most of the work.

## Worst case: assume the feed is fully compromised and every guard defeated

- **Price faked high.** The vault pays out at most `notional_sold − 1` stroop, and only to bidders
  who paid real premium for those fills. The attacker must also be the bidder to collect, and
  cannot reach pending deposits or unclaimed balances.
- **Price faked low.** The payout is zero. Only bidders lose, and only their premium.

There is no leverage anywhere in the system, so **oracle compromise caps at one round's sold
notional** — and it caps there structurally, because there is nothing in the design for the loss to
scale with. Nothing is borrowed against the collateral, nothing is rehypothecated, and the payout
formula is bounded below the notional for every price the feed could name.

Bounding a risk is not eliminating it. Adding median-of-N, or a second independent feed once one
exists that meets the same source requirement, is a **new implementation and never a refactor** —
`PriceSource` is an interface precisely so that adding one does not touch the vault. That is the
fallback *mechanism*; void-and-refund is the fallback *guarantee*.
