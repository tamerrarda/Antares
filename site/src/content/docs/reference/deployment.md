---
title: What is deployed
deck: Every address, hash, parameter and transaction, and how to check each of them without asking us for anything.
---

> **Status —** Stellar **testnet** only, three vaults, **unaudited**.
> [Where this stands](../start/status.md).

Everything below is committed to the repository in
`deployments/testnet.json`, written by the deploy script as it submits — not by hand, and not
afterwards. A testnet reset erases the transactions themselves, and a hash not written down at
submission cannot be recovered later at all.

## Contracts

| | Address | Wasm SHA-256 |
|---|---|---|
| **Vault** — `aXLM-E`, 3-day, 3 % OTM | [`CCYAHS4D…LBVEA`](https://stellar.expert/explorer/testnet/contract/CCYAHS4DJLGNDU7GTSDUJL4ZZ2X6VZI7IPHJM2W2SNVA6RDALEALBVEA) | `7b5f098bddd47b4b9cf8ff22b75a0ead4c41ccd741c61c8ac3dabb579a4a80f2` |
| **Vault** — `aXLM-C`, 3-day, 2 % OTM | [`CAQY7L34…2J5ENSK6`](https://stellar.expert/explorer/testnet/contract/CAQY7L34IXNMGXFRVCEBVMOQHK2G5IVELJRR35S4523CQ7JS2J5ENSK6) | the same — `7b5f098b…a4a80f2` |
| **Vault** — `aXLM-A`, 7-day, 3 % OTM | [`CD7QODWT…E462Y7K2R`](https://stellar.expert/explorer/testnet/contract/CD7QODWTVHCRIIBK62LWPA2UEVRX7N7MX6RYIL3I3CYAU2CE462Y7K2R) | the same — `7b5f098b…a4a80f2` |
| **Price adapter** — what all three vaults read | [`CBR3GSAZ…BCEN5Z`](https://stellar.expert/explorer/testnet/contract/CBR3GSAZUOFGWP5IUSIJP5ESUZPDIO42WAZ5VIFSNYZURH2VVSBCEN5Z) | `d88120b0da3250edea169996ce1840c9138a8c72c2866e846173d0d92f33242d` |
| The CEX & DEX XLM/USD feed — **a third-party contract, not ours** | [`CCYOZJCO…MJRN63`](https://stellar.expert/explorer/testnet/contract/CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63) | — |
| XLM, native Stellar Asset Contract | [`CDLZFC3S…HHGCYSC`](https://stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC) | — |

**The three vaults are the same binary.** They carry one wasm hash between them and read one
adapter; what separates them is the arguments their constructors took. That is checkable rather
than asserted: compare the hashes above, and read each vault's `config` for the terms below.

**The adapter is pinned at the vault's construction and is immutable** — there is no setter, so
changing the price source requires a reviewed code upgrade. The adapter itself has no admin and no
upgrade path at all; its exported surface is `__constructor`, `reading`, `spot_check`,
`supports_round`, asserted at deploy.

A mock price source exists in the repository and is **deployed nowhere.** It is the test double that
lets dead-feed, rescale and trap cases be forced, which a live feed cannot be made to do on demand.

## Share token

| | |
|---|---|
| Symbols | `aXLM-E`, `aXLM-C`, `aXLM-A` — one per vault |
| Name | Antares XLM Vault Share |
| Decimals | 7 |
| Interface | SEP-41, implemented inside the vault contract |

The suffix is a constructor argument, and it exists because concurrent vaults issue
non-interchangeable tokens. Showing them all as `aXLM` in a wallet would be a way for someone to
believe they hold something they do not. **A share in one vault is not a share in another**, and
there is no path between them: they price against different rounds and settle against different
strikes.

## Parameters

The shipped set, not a demonstration set. These are the sixteen `EpochParams` fields the
constructor takes, plus the four constructor arguments that are not `EpochParams` fields.

**The table below is `aXLM-E`'s.** The other two differ in five fields and in nothing else:

| | `aXLM-E` | `aXLM-C` | `aXLM-A` |
|---|---|---|---|
| `epoch_duration` | 259 200 — 3 days | 259 200 — 3 days | **604 800 — 7 days** |
| `strike_bps_otm` | 300 — 3 % | **200 — 2 %** | 300 — 3 % |
| `premium_start_bps` | 280 | **325** | **500** |
| `premium_floor_bps` | 55 | **72** | **112** |
| `allowlist_expires_at` | 2026-09-07T09:11:23Z | 2026-09-11T10:05:35Z | 2026-09-11T10:07:28Z |

A nearer strike and a longer round are both worth more, which is why `aXLM-C` and `aXLM-A` open
above `aXLM-E`'s band and floor above it too. **All three allowlists have now expired**, and there
is no setter that can restore one: bidding on every vault is permissionless.

| Parameter | Raw | Means |
|---|---|---|
| `epoch_duration` | 259 200 | **3 days** from open to expiry |
| `auction_duration` | 2 700 | **45 minutes** of descending auction |
| `min_idle_gap` | 7 200 | **2 hours** minimum between rounds |
| `strike_bps_otm` | 300 | strike is **3 %** above the TWAP at open |
| `premium_start_bps` | 280 | auction starts at **2.80 %** of notional |
| `premium_floor_bps` | 55 | reserve is **0.55 %** of notional |
| `twap_window` | 900 | **15-minute** short window, 3 samples, all required |
| `guard_window` | 3 600 | **1-hour** guard window, 5 samples, at least 3 required |
| `max_staleness` | 600 | **10 minutes**, checked at open only |
| `max_deviation_bps` | 100 | breaker at **1 %** divergence, at open only |
| `oracle_dead_after` | 43 200 | **12 hours** past expiry before a void is allowed |
| `settle_grace` | 7 200 | **2 hours** — the guaranteed minimum width of the void window |
| `unresolved_after` | 75 600 | **21 hours** past expiry, the round closes with no feed call |
| `min_fill` | 1 000 000 000 | **100 XLM** minimum bid |
| `min_deposit` | 100 000 000 | **10 XLM** minimum deposit |
| `settle_bounty_bps` | 25 | **0.25 % of the premium** to whoever closes the round |
| `deposit_cap` | 1 000 000 000 000 | **100 000 XLM** — about $19 600 at XLM's price on 2026-08-22 |
| `rent_threshold` / `rent_extend_to` | 120 960 / 518 400 | TTL policy in **ledgers**, not seconds — roughly 7 and 30 days at a five-second close. A touched entry is bumped to the second; an untouched one may archive after it. Ledger close time is not constant, which is why these are tunable |
| `allowlist_expires_at` | 1 788 772 283 | **2026-09-07T09:11:23Z** — no setter, capped at 30 days from construction |

Genesis constants, which are **not** constructor arguments: `fee_bps = 0`, `paused = false`,
`allowlist_enabled = true`. The fee is a constant rather than an argument so that a non-zero fee
always requires a separate, publicly visible transaction.

Among the contract-enforced rules on the above: `settle_bounty_bps ≤ 100`, `fee_bps ≤ 2 000`,
`auction_duration ≤ epoch_duration ÷ 24`, `min_idle_gap ≥ epoch_duration ÷ 50`,
`min_deposit > 1 000` stroops, `guard_window > twap_window`, `unresolved_after > oracle_dead_after`,
and the feed's own eight conditions ([The price feed](../mechanism/price-feed.md#what-the-feed-has-to-promise-before-a-round-opens)).

## Deployment transactions

Deployer `antares-testnet` ([`GDFPSLES…EKBQQ`](https://stellar.expert/explorer/testnet/account/GDFPSLESDEPR2XSNASBK3464NLB7HYG6IS2SX2TYCJK7KUPIEWFEKBQQ)),
each run from a **clean tree**. A deploy from a dirty tree is refused before anything is submitted,
for exactly the reason that a commit id identifies the code that ran only if the tree was clean.

The adapter was created once, with `aXLM-E`, and the two later vaults were pointed at it rather than
at adapters of their own. Each vault's deploy ends with a smoke deposit and a withdrawal request
against the instance just created, so that no vault is recorded here that has not already taken
money in and let it back out.

| | Deployed | Commit | Transaction |
|---|---|---|---|
| Adapter created | 2026-08-24 | `87e4224a` | [`233c858c…cafb9c`](https://stellar.expert/explorer/testnet/tx/233c858caf45c1b0d2f2df581ce8dbd802f984550a4807e4885d29cdc9cafb9c) |
| Vault `-E` created | 2026-08-24 | `87e4224a` | [`9cd2cb41…5b851e`](https://stellar.expert/explorer/testnet/tx/9cd2cb4127b622d75f818298a763b4e778432a5021c3303c363b5ce34c5b851e) |
| — its smoke deposit | | | [`d2622e59…b5ecb0`](https://stellar.expert/explorer/testnet/tx/d2622e5952c79a5a7f0ce9e77dfe7f40a3fb75e30fb5bb5521cd1c5e15b5ecb0) |
| — its smoke withdrawal request | | | [`d299d00d…3eb731`](https://stellar.expert/explorer/testnet/tx/d299d00d4487eaa89d985224ea01653c1de35a09b83cb277a5f42921633eb731) |
| Vault `-C` created | 2026-08-28 | `1cbed1eb` | [`3a51bfb5…a0d011`](https://stellar.expert/explorer/testnet/tx/3a51bfb598cdb9d36c457d6ee47cf25d12941fb6b51f0c62328b887907a0d011) |
| — its smoke deposit | | | [`70d8c592…2b3c07`](https://stellar.expert/explorer/testnet/tx/70d8c592fc5afac529c17d269bf06ce5e6e40ca942821c1ab6e2a607c82b3c07) |
| — its smoke withdrawal request | | | [`e444da3c…ab774d`](https://stellar.expert/explorer/testnet/tx/e444da3ca8fc7ac5a679129face6bc81acd494374b39b219de6fb2525dab774d) |
| Vault `-A` created | 2026-08-28 | `cac1632c` | [`9e37530c…b93cc5`](https://stellar.expert/explorer/testnet/tx/9e37530c8585dfc435dfac84b2132ca997ad9ffc33af17e9477de60fcfb93cc5) |
| — its smoke deposit | | | [`7ed08716…e1f94c`](https://stellar.expert/explorer/testnet/tx/7ed087162da7a784f2c7e74b1ad11f3cc453a7f39bc774ab1b57663f42e1f94c) |
| — its smoke withdrawal request | | | [`10a2280e…8f5734`](https://stellar.expert/explorer/testnet/tx/10a2280e49bc09c1e28edeb5f71a63e92f7590126c6c9729fb2f5d8eb48f5734) |

## Toolchain

Every version is pinned exactly, never by range or channel.

| | Pinned at |
|---|---|
| Rust | `1.95.0` |
| Build target | `wasm32v1-none` |
| `soroban-sdk` | `=27.0.6` |
| `stellar-cli` | `27.1.0` |
| Node | `v22.18.0` |
| Build host | `darwin-arm64` |

```bash
cargo test --workspace                    # unit + property
stellar contract build --out-dir out      # deployable wasm
```

## Reproducing the hashes

Build the repository at commit `87e4224a` and compare.
`stellar contract fetch --id <address> --network testnet` returns the deployed bytes.

**One caveat, and it is ours rather than yours: the hash reproduces against a host, not against a
toolchain.**

Measured on 2026-08-21: `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu` build the vault to the
same **65 374 bytes** and two different SHA-256s. Section by section they agree everywhere it is
possible to disagree about meaning — `import`, `export`, `data` and all four custom sections
including `contractspecv0` are byte-identical, and `stellar contract info interface` returns the same
**42 functions** — while `type`, `function` and `code` differ at identical sizes, because the type
table is emitted in a different order and every index into it follows. Same program, different
internal numbering.

So reproduce on the host that built the artefact. **Both deployments above were built on
`aarch64-apple-darwin`**, and they predate the field that records it: their toolchain block names
Rust, `stellar-cli`, `soroban-sdk`, the target and Node, but not the machine — the omission this
measurement found. That host is stated here from the machine that ran the deploy and corroborated by
the Node version the record does carry; it is not read back out of the record, and that gap is
exactly what the field closes from 2026-08-21 onward. It is named here rather than backfilled,
because a record of what happened is worth less once it is edited after the fact.

On a different host, expect the exported surface and the contract spec to match byte for byte, and
the SHA-256 not to.

CI's reproducible-build job proves a narrower property than its name suggests: it builds twice on one
runner at deliberately different path lengths, which shows the output does not depend on where the
source sits, and says nothing about which machine compiled it.

## The measured feed profile

From `deployments/adapter-testnet.json`, produced by profiling a contract built from the same wasm
hash on 2026-08-19:

| | |
|---|---|
| `resolution()` | **300 seconds** |
| `decimals()` | 14, normalized to 7 by the adapter |
| Reachable depth | **255 ticks** = 76 500 s |
| Reach limit for a 1-hour guard window | **72 900 s** = 20 h 15 m |
| Boundary, measured | reads at an anchor age of 72 783 s; out of reach at 73 083 s |

255 rather than 256, and the difference is a void: the feed's bitmask holds 256 records, which span
255 intervals, and the reach limit is a *depth*. With 256 the adapter's oldest guard sample would
have landed one tick past the horizon, been dropped, taken the valid count under its threshold, and
made **a healthy feed produce a void** — the bidder refunded in full for nothing.

## What the deployment record marks, and why

`economicallyMeaningless` is `false` on the deployed instance, and that is a claim the record makes
rather than one this page makes. The field is stamped `true` on any fast-test profile — second-scale
durations against a price source this project controls — and it is **permanent**: an instance marked
that way can never afterwards be presented as demand evidence, whatever anyone later says about it.

## Related

- [Contract surface](contract-surface.md) — the ABI
- [The price feed](../mechanism/price-feed.md) — what the adapter does with all of this
- [Who can do what to your funds](../trust/trust-model.md#3b-what-you-are-trusting-the-deployment-to-be)
  — why byte-identical builds are a trust question rather than a build question
