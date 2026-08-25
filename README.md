# Antares

**Covered call vaults on Stellar.** Deposit XLM, the vault writes a call against it each epoch, and the premium is credited back to depositors.

> **Status: pre-alpha, testnet only. Not audited.**
> Antares is built to mainnet semantics from the first line — the same accounting, the same trust model, the same failure handling. Testnet is a network parameter, not a different design. What separates this codebase from a mainnet deployment is an audit and a proven counterparty, not a rewrite.
>
> That claim is a checkable constraint, not a slogan: **the binary deployed to mainnet must hash identical to the one that ran on testnet and was audited.** Everything that differs between the two networks — the asset, the oracle, the admin, every parameter — is a constructor argument or an admin call. There are no build flags, no conditional compilation, and no network branches in the contract. An audit certifies a binary; if mainnet ran a different one, the audit would cover code that is not the code holding funds.

---

## Why this exists

Stellar's DeFi stack has filled in from the bottom up:

| Layer | On Stellar today |
|---|---|
| Spot swap | Soroswap, Aquarius, Phoenix |
| Lending / borrowing | Blend, Kinetic |
| Yield vaults / aggregators | Upshift, Sentora, DeFindex |
| Perpetual futures | Stellars Finance, Rails |
| **Options / derivatives** | **one testnet protocol; no on-chain price discovery** |

The next layer up — options — is barely populated: one live testnet protocol (see below), no options protocol in Stellar's DeFi TVL rankings, and **no on-chain price discovery for an option anywhere on the network.** Every attempt so far has priced the option off-chain. This is not a niche gap: on Ethereum and Solana, covered-call vaults became a standard way for holders to earn income on assets they were already holding.

Antares builds that primitive: one asset, one strategy — designed as a system that can hold real value. (The counterparty phase runs five instances of the same contract side by side on different terms, so that a run of empty auctions can tell "wrong terms" apart from "no buyer"; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12.)

### Ecosystem gap scan

| Category | Status on Stellar |
|---|---|
| Perpetual DEX | Exists (Stellars Finance, Rails) |
| Memecoin launchpad | Exists |
| NFT marketplace | Exists (Litemint) |
| DEX aggregator | Exists (Soroswap) |
| Lending / borrowing | Exists (Blend, Kinetic) |
| Yield vault / aggregator | Exists (Upshift, Sentora, DeFindex) |
| **Options / covered call protocol** | **One live on testnet, several dead attempts** |

> **Re-verified against the SCF archive and GitHub (2026-08).** This layer is neither empty nor untouched.
>
> **One protocol in this category is live on testnet and actively developed**: XLM covered calls and cash-secured puts, a Soroban vault holding collateral, oracle settlement pinned to the expiry timestamp, and a permissionless `settle()`. It went through an SCF panel review. It is not a graveyard entry — it works.
>
> Behind it there *is* a graveyard: an SCF-funded Soroban options contract, roughly $61.5k across two rounds, whose last commit is October 2023, plus several inactive single-developer attempts.
>
> **So what is left for Antares?** Not the idea — the market structure. In that design the protocol itself is the counterparty: a pool buys the option from you, and the price comes from an off-chain quote engine whose key co-signs each premium. That is a legitimate design and it sidesteps the hardest problem in this category by answering it internally. Antares takes the opposite bet: **the counterparty is an independent bidder, and the price is discovered on-chain by a descending auction with no privileged quoter.** Nobody has to trust a pricing server, and nobody's pool absorbs the risk — but it only works if independent bidders actually show up, which is precisely the question this project exists to answer and has not answered yet. If they don't, the incumbent's design is the better one and we should say so.

## How a covered call vault works

For readers who don't trade options:

1. You deposit XLM into the vault and receive share tokens representing your portion.
2. Each epoch, the vault sells a **call option** on that XLM — the right (not the obligation) for a buyer to purchase it at a fixed price (the *strike*) on a set date.
3. The buyer pays a **premium** up front. That premium goes into the vault, for the depositors.
4. At expiry:
   - **Price below strike** → the option expires worthless. The vault keeps both the XLM and the premium.
   - **Price above strike** → the vault pays the difference out of its own collateral, and depositors keep the premium.

The trade-off is symmetric and honest: you earn premium every epoch, and in exchange you cap how much you gain if XLM rallies past the strike.

## Architecture

```
                          ┌──────────────────┐
   Depositor ──deposit───▶│                  │──TWAP + guards──▶  Reflector
   (XLM)     ◀──withdraw──│   Antares Vault  │                    (oracle)
                          │  (Soroban/Rust)  │
   Bidder    ────bid─────▶│                  │
   (premium)              │  • share token   │
                          │  • epoch ledger  │
                          │  • Dutch auction │
                          │  • settlement    │
                          └──────────────────┘
                                   ▲
                                   │  open_epoch() / close_round()
                                   │  permissionless — anyone may call
                          ┌────────┴─────────┐
                          │  Keeper (script) │  convenience only,
                          │  cron trigger    │  never an authority
                          └──────────────────┘
```

### Epoch state machine

```
IDLE ──open_epoch()──▶ AUCTION ──bid() fills──▶ ACTIVE ──close_round()──▶ SETTLED ──▶ IDLE
                          │                        │
                          │                        ├── feed dead at expiry ─▶ VOIDED ──▶ IDLE
                          │                        └── closed too late ─────▶ UNRESOLVED ▶ IDLE
                          └── auction ended, no bid ────────────────────────▶ LAPSED ──▶ IDLE
```

One call closes a round and the caller does not choose which arrow it takes: `close_round()` reads
the feed as it stood at expiry and dispatches on what it finds.

`LAPSED` is a normal path, not an error. If no bidder appears, the premium for that epoch is zero, collateral stays exactly where it was, share price is unchanged, and the next epoch opens. **An epoch with no buyer costs depositors nothing.**

`VOIDED` is the third terminal state and equally normal: if the price feed is unusable past a defined bound, the epoch is annulled — premiums are refunded to bidders, no payout is made, share price is unchanged. Nobody who could cause an oracle failure profits from one — a feed's death is not an event any participant can bring about — and nothing is trapped by one.

### Locked design decisions

Settled before the first line of contract code, because each one is expensive to change later. Every entry below is the *mainnet* choice, not a testnet shortcut.

| Decision | Choice | Why |
|---|---|---|
| Settlement | **Cash-settled in XLM** | No USDC leg, no atomic swap, no buyer credit risk. The payout comes out of collateral and is mathematically bounded by it. |
| Buyer capital | **Premium only** | A bidder never posts strike × notional — only the premium. At the option's fair value that is a capital barrier **23× to 49× lower** than physical settlement on instance A, across the volatility range measured on 2026-08-24 — and never less than **15×** lower anywhere on any of the five vaults' curves. (Read **136×** here until 2026-08-25; that was computed against the assumed σ of 33.7 % the bands were originally sized around.) Which matters most in a thin market. |
| Price discovery | **Dutch auction on-chain, with an in-the-money guard** | A fixed premium is not viable with real capital — it hands the bidder free optionality whenever volatility rises. A descending-price auction discovers the premium without requiring a volatility oracle, which Stellar does not have. Bids are refused the moment spot reaches the strike: a descending curve cannot price intrinsic value, and an empty auction costs depositors nothing. |
| Premium accounting | **Recognised at fill, never at offer** | In an auction the clearing price is only known when a bid lands. Accounting that assumes a known premium at offer time breaks the day the auction is introduced. |
| Buyer access | **Permissionless `bid()`**, with an allowlist that **expires on a timestamp fixed at deployment** | Mainnet cannot choose its counterparties. The allowlist is a launch control, not a design assumption. It has no extension setter, so "this opens to everyone on date X" is a number you can read out of the deployment record rather than a promise we make — and the one gate that can end this project cannot be frozen by leaving a launch control on. |
| Share accounting | **Epoch-based: pending deposits, withdrawal queue, price-per-share per epoch** | Capital arriving mid-epoch must not dilute the premium earned by capital that was actually at risk. Retrofitting this is a rewrite, not a patch. |
| Contract count | **One contract** | Vault, auction and settlement share the same state. Splitting them buys cross-contract auth and state-sync problems and nothing else. Module boundaries live in the code, not at addresses. |
| Epoch length | **Parameter, not a constant** | Weekly is a product choice, not a protocol constraint. Short epochs also make end-to-end tests fast. |
| `open_epoch()` / `close_round()` | **Permissionless, and the caller never names the outcome** | A dead keeper must never be able to lock user funds. One entry point closes a round and dispatches on the price feed as it stood at expiry — settled, annulled, or unresolved — so which way it ends is a function of history rather than of who transacted first. |
| Fills | **Partial fills supported** | In a thin market, all-or-nothing means no fills at all. |
| Oracle | `PriceSource` interface · Reflector's deep CEX & DEX XLM/USD feed (never a thin on-chain market) · TWAP · staleness bound · self-consistency circuit breaker · defined dead-oracle policy | Settlement correctness rests entirely on the price feed. Every failure mode gets a defined behaviour, and none of them lock funds. Feed *selection* is part of the security model, not plumbing. |
| Admin surface | **Admin role, pause, deposit cap, fee parameter (0 at genesis) — present from day one** | All four touch storage layout and auth. Adding them later means a migration. Shipping them unused costs nothing. The fee is 0 because no transaction ever set it — not because a deploy argument happened to be zero — so any non-zero fee leaves a public transaction behind. There is no setter for the oracle or the asset at all. |
| Pause semantics | **Pause can never trap funds** | Pause stops deposits, bids and new epochs — nothing else. Closing a round and the entire withdrawal path are unpausable, so a paused vault always unwinds to cash with bounded delay. No pause timeout is needed; the exit path simply cannot be closed. |
| Upgradeability | **Upgradeable v1** — admin-gated `upgrade()`, versioned `migrate()` | Pre-audit, the ability to fix a bug outweighs the stronger trust statement of immutability. Testnet admin is a single documented address; **before mainnet it becomes a timelocked multisig** whose delay exceeds a full epoch plus the bound past which a round closes regardless of the price
feed (`TRUST_MODEL` §3 — 7 d 21 h at shipped values), so users can always exit at the old code. This is the protocol's one real trust concentration and it is disclosed, not disguised. |
| Storage | Typed for mainnet rent: user balances persistent, config instance, **nothing holding value in temporary** | An archived entry on mainnet is a user who cannot reach their funds. Restore paths are part of the design, not an afterthought. |

## Scope

### In scope — everything achievable before an audit

- Vault contract with epoch-based share accounting (pending deposits, withdrawal queue, per-epoch price-per-share)
- Dutch auction price discovery with permissionless bidding and partial fills
- Cash settlement in XLM, provably bounded by collateral
- Reflector oracle integration: TWAP window, staleness bound, deviation circuit breaker, dead-oracle policy
- Permissionless epoch open and settlement; keeper as convenience only
- Admin role, emergency pause, deposit cap, fee parameter
- Storage typing, TTL/rent budgeting, archival restore paths
- Events on every state transition
- Full test suite: unit, integration, property-based settlement math, fuzz
- Open-source reference bidder, integrator documentation, deployment scripts parameterised by network
- Web interface for deposit, withdraw and epoch status
- Internal security review against known Soroban vulnerability classes, and an audit-ready codebase

### Out of scope — and why

| Not included | Reason |
|---|---|
| **Mainnet deployment** | Requires a completed audit. Not a code gap. |
| **Security audit** | External process. None performed, none claimed. |
| **Any APY, yield or return figure** | See below. |
| Assets other than XLM | Single-asset by design at this stage. |
| Physical settlement / USDC leg | Cash settlement is the chosen design, not a simplification. |
| Order book, RFQ, market-maker integrations | Problems that appear when the market is deep. Solving them in a thin market is wasted work. |
| Multiple concurrent epochs | One active epoch at a time. |
| Governance, DAO, token | Not part of the protocol. |
| Cross-margin, put vaults, multi-strategy | Later products, not this one. |

## Honest limitations

**No proven counterparty.** Stellar has no professional options market makers, and while XLM futures and perpetuals exist (so delta can be hedged), XLM options do not trade on a major venue — a bidder cannot lay off volatility risk. The buyer side of this market is genuinely unproven, and this project does not claim otherwise. During testnet, the counterparty is a reference bidder operated by the project team and labeled as such everywhere it appears. If you are a potential counterparty, [`docs/BIDDER.md`](docs/BIDDER.md) is written for you, and a refusal with a reason is more useful to us than a fill.

**No yield numbers.** Antares publishes **no APY, yield, or return figure** of any kind at this stage. Premiums cleared against a self-operated reference bidder are a test of the auction and settlement mechanism, not a market price. A number would be screenshotted; its disclaimer would not. Raw premium amounts are visible in the on-chain transactions, and that is where they stay.

The policy has an exit condition, so that it cannot quietly become an excuse: once an address outside our control clears an auction, realized premium per round is published as **raw basis points of notional**, always shown beside the lapse rate — how many recent epochs cleared with no buyer at all — and the payout that followed. Facts with their misses attached. Annualized figures, projections and expected-yield numbers stay off the table permanently, in the interface and everywhere else.

**Oracle dependency.** Settlement correctness rests entirely on the price feed. The design bounds this — a deep CEX & DEX aggregated feed rather than any manipulable on-chain market (the February 2026 YieldBlox incident on Stellar was exactly that failure), TWAP, staleness limits, a self-consistency breaker, and a dead-oracle policy that never traps funds. Even a fully compromised feed cannot extract more than one epoch's sold notional — there is no leverage anywhere in the system. But bounding a risk is not eliminating it, and no amount of testnet activity proves behaviour under real volatility.

**Unaudited.** The contract is written and running on testnet, and every invariant in [`docs/INVARIANTS.md`](docs/INVARIANTS.md) is asserted by our own tests — a property suite, three fuzz targets (call-sequence, auction, settlement math), and a differential reference in a second language whose replay matches the Rust byte for byte across all four sections on the hand-written vectors. Two qualifications belong beside that rather than under it. **CI here has no push trigger** — it runs only when dispatched by hand — so these are checks that *can* be run rather than checks that run continuously; and **the mutation run is a gate for a later phase, not one already passed**: it is scoped to the single module nothing else grades, at a bar of zero survivors, with twenty-two unjudged timeouts in two further modules recorded as an open item. **An internal security review was carried out** against known Soroban vulnerability classes, and there is no published artifact behind that sentence — it is a statement by the people who wrote the code, not something you can check. **None of that is an audit.** Every correctness claim here is still our own, checked by people who wanted it to be true.

**We are not first, and the incumbent is closer than the usual kind.** A protocol in this category is already live on Stellar testnet doing XLM covered calls, with a working web app, an SCF panel review behind it, and a shipped Soroban vault. Being early is not our advantage — it is not available. What is left is a different answer to the same question: they price the option with an off-chain quote engine and make the protocol the counterparty; we discover the price on-chain and require a real counterparty to show up. Which is better is an empirical question, and their design is the safer bet if independent bidders never appear.

Beyond that: Soroban vault primitives ship as libraries, and established yield protocols could extend into structured products with distribution we do not have. Open source and public progress are the only mitigation on offer.

**Prior art is not encouraging and we are not ignoring it.** Friktion and Katana ran this structure on Solana and shut down. Their contracts worked; their counterparty base was a handful of desks, and when those desks left, premium went to zero. The failure mode of this product category is counterparty concentration, not contract risk — which is why counterparty discovery is treated here as a first-class deliverable rather than an afterthought.

## Live on testnet

Everything below is verifiable without asking us. Each address links to an explorer; each wasm hash
can be reproduced by building this repository at the commit named and comparing.

**What is deployed today runs on the shipped parameters against a feed we do not control.** Until
2026-08-24 it did not: the vault ran a fast-test profile — second-scale durations against a mock
price source — which the deployment record stamps `economicallyMeaningless: true` and which is
barred from ever being presented as demand evidence. That instance is gone. The one below is a
three-day epoch, struck 3 % out of the money, reading Reflector's aggregated CEX & DEX XLM/USD
feed, and its record says `economicallyMeaningless: false`.

**It is still not the Phase-1 gate.** That gate asks for a *closed* epoch at these parameters —
opened, sold, settled — and no round has closed on this instance yet. What is proven today is the
deployment, not the cycle.

### Contracts

| | Address | Wasm SHA-256 |
|---|---|---|
| **Vault** (`aXLM-E`, 3-day, 3 % OTM) | [`CCYAHS4D…LBVEA`](https://stellar.expert/explorer/testnet/contract/CCYAHS4DJLGNDU7GTSDUJL4ZZ2X6VZI7IPHJM2W2SNVA6RDALEALBVEA) | `7b5f098bddd47b4b9cf8ff22b75a0ead4c41ccd741c61c8ac3dabb579a4a80f2` |
| **Reflector adapter** (what the vault reads) | [`CBR3GSAZ…BCEN5Z`](https://stellar.expert/explorer/testnet/contract/CBR3GSAZUOFGWP5IUSIJP5ESUZPDIO42WAZ5VIFSNYZURH2VVSBCEN5Z) | `d88120b0da3250edea169996ce1840c9138a8c72c2866e846173d0d92f33242d` |
| Reflector CEX & DEX feed (theirs, not ours) | [`CCYOZJCO…MJRN63`](https://stellar.expert/explorer/testnet/contract/CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63) | — |
| XLM (native SAC) | [`CDLZFC3S…HHGCYSC`](https://stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC) | — |

The adapter is pinned at the vault's construction and **immutable** — there is no setter, so
changing the price source requires a reviewed upgrade. `contracts/mock-price-source` still exists
in this repository and is deployed nowhere: it is the test double that lets dead-feed, rescale and
trap cases be forced, which a live feed cannot be made to do on demand.

### Deployment transactions

Deployer `antares-testnet` (`GDFPSLES…EKBQQ`), 2026-08-24T09:11:48Z, from a clean tree at commit
`87e4224a`. The deploy script records these as it submits them, in `deployments/testnet.json`,
because a testnet reset erases the transactions themselves and a hash not written down at
submission cannot be recovered afterwards at all.

| | Transaction |
|---|---|
| Adapter created | [`233c858c…cafb9c`](https://stellar.expert/explorer/testnet/tx/233c858caf45c1b0d2f2df581ce8dbd802f984550a4807e4885d29cdc9cafb9c) |
| Vault `-E` created | [`9cd2cb41…5b851e`](https://stellar.expert/explorer/testnet/tx/9cd2cb4127b622d75f818298a763b4e778432a5021c3303c363b5ce34c5b851e) |
| Smoke deposit (`deposit`) | [`d2622e59…b5ecb0`](https://stellar.expert/explorer/testnet/tx/d2622e5952c79a5a7f0ce9e77dfe7f40a3fb75e30fb5bb5521cd1c5e15b5ecb0) |
| Smoke withdrawal (`request_withdraw`) | [`d299d00d…3eb731`](https://stellar.expert/explorer/testnet/tx/d299d00d4487eaa89d985224ea01653c1de35a09b83cb277a5f42921633eb731) |

### Reproducing the hashes

Both wasms were built at commit `87e4224a` and deployed in the same run, from a tree the deploy
script verified clean before it would submit anything. They used Rust 1.95.0, `soroban-sdk
=27.0.6`, `stellar-cli 27.1.0` and target `wasm32v1-none`, all pinned in the repository rather than
restated here — and `deployments/testnet.json` records every one of those alongside the host that
did the building. `stellar contract fetch --id <address> --network testnet` returns the deployed bytes.

**The hash reproduces against a host, not against a toolchain.** Measured on
2026-08-21: `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu` build the vault to the same
65,374 bytes and two different SHA-256s. Section by section they agree everywhere it is possible to
disagree about meaning — `import`, `export`, `data` and all four custom sections including
`contractspecv0` are byte-identical, and `stellar contract info interface` returns the same 42
functions — while `type`, `function` and `code` differ at identical sizes, because the type table is
emitted in a different order and every index into it follows. Same program, different internal
numbering.

So reproduce on the host that built the artefact. **Both deployments above were built on
`aarch64-apple-darwin`**, and they predate the field that records it: their `toolchain` block names
Rust, `stellar-cli`, `soroban-sdk`, the target and Node, but not the machine — the omission this
measurement found. That host is stated from the machine that ran the deploy and corroborated by the
Node version the record does carry; it is not read back out of the record, and that gap is exactly
what the field closes. `deployments/*.json` carries `toolchain.buildHost` from 2026-08-21 onward;
for these two the host is named here instead of backfilled, because a record of what happened is
worth less once it is edited after the fact. On a different host, expect the exported surface and the contract spec to
match byte for byte and the SHA-256 not to.

CI's reproducible-build job proves a narrower property than its name suggests: it builds twice on
one runner at deliberately different path lengths, which shows the output does not depend on where
the source sits, and says nothing about which machine compiled it.

The full record, including the constructor arguments, the parameters and the toolchain, is in
[`deployments/testnet.json`](deployments/testnet.json) and
[`deployments/adapter-testnet.json`](deployments/adapter-testnet.json). Those files are written by
the deploy script rather than by hand.

## Roadmap

| Phase | Goal | Gate to the next phase |
|---|---|---|
| **1 — Mechanism** (current) | The full system runs end to end on testnet with mainnet semantics, verifiable from public transaction hashes | A closed epoch: deposit → auction → fill → settle → premium distributed, with every invariant tested — **at parameters where the option's fair value actually falls inside the auction's price band**, so the fill means something |
| **2 — Counterparty** | Find out whether an independent bidder will pay a premium, and at what price | **All three:** ≥3 addresses outside our control fill; ≥4 consecutive epochs with a fill; notional-weighted average clearing at least `max(0.75 × Black-Scholes fair value at the volatility the epoch actually realized, 1.30 × the auction's reserve price)`. Both averaging and "consecutive" are counted **within a single vault**, never pooled across the concurrent ones |
| **3 — Mainnet** | Audit, findings resolved, capped launch | Audit complete; deposit cap and pause verified live |

Phase 2 is a market question, not an engineering one. It cannot be answered by writing more code, and progress on it is reported as findings — including refusals — rather than as metrics.

The third condition is the one that can fail us. An uncontested Dutch auction always walks toward its floor; if clearing prices cluster at the bottom of the curve, price discovery never happened and the mechanism has quietly degenerated into a fixed premium that hands the buyer a free timing option. That would falsify a load-bearing design assumption, and we would report it as falsification rather than as a fill count.

Getting this condition right took **five** attempts, and the first four were each satisfiable by the failure they were meant to detect. "At least one fill above the floor" is true of every possible fill. "A quarter of the way up the curve" is an absolute number while fair value moves with volatility, so a perfectly competitive market could have failed it. "Half of fair value" is cleared by the auction floor itself, since the floor is defined as at least half of fair value. And the single ratio `≥ 0.75 of fair value` broke the same way one level down: its numerator moves with volatility while the reserve price is an integer fixed at deployment, so below the volatility at which the reserve *is* three-quarters of fair value — **49 %** on instance A at the re-derived bands, and 49–51 % across all five — an auction filled entirely at the reserve passes it again. XLM's measured windows sit above that today (65.1 % over 30 days, 60.2 % over 60, 103.0 % over 90, on 2026-08-24), but a quiet quarter is not a hypothetical. **This read "roughly 29 %" until 2026-08-25**, which was true of the premium bands as they stood before the 2026-08-24 re-derivation.

Hence two conditions rather than one. The 0.75 sits below the clearing ratios of the only comparable vault auctions anyone has measured, which cleared at 0.83–0.98 of fair value. The `1.30 × reserve` is volatility-independent by construction and bounded on both sides: an uncontested auction walks only to its last admissible tick — 113 bps against instance A's 112 bps reserve, under **1 %** above it, since a bid at `auction_end` itself is refused — so 1.30 excludes reserve-walking outright, and it must not bind where the fair-value test already works, which caps it at 1.354. (This read "within 0.4 %" until 2026-08-25.) A lone bidder walks the curve to the reserve and fails; a second bidder forces the clear earlier and passes. The gate measures whether anyone was competing — and the fourth rewrite is why we now publish the volatility estimator's exact definition alongside the result, so a third party can recompute the gate rather than trust it.

### The stop gate

Every gate above is a *go* gate. Here is the one that ends the project:

> **If 8 consecutive epochs *and* at least 30 calendar days pass with the bidder allowlist disabled and no independent fill, development stops.** Both conditions are required because an empty round ends in 45 minutes, not a week — and once the mandatory gap between rounds is
counted, a full empty cycle takes as little as 2 h 45 m on the fastest vaults, so eight of them —
counted within a single vault — could otherwise elapse in about **22 hours**, against evidence
gathered while no counterparty was awake. The allowlist expires on a timestamp fixed when the vault is deployed — capped at 30 days, with no setter to extend it — so the one gate that can end the project cannot be frozen by leaving a launch control on. Disabling it earlier is still the intended path; the expiry is what makes it not depend on us. We publish what happened — how many epochs, at what parameters, what premiums were on offer, how many counterparties we approached and what they told us — and then choose, explicitly and publicly: pivot, park the code, or close.

At a weekly epoch that is about two months. A project without a stop condition cannot tell you it was wrong, and this product category has been wrong before.

## Repository layout

```
contracts/          Soroban contracts (Rust): vault, Reflector adapter, mock price source
deployments/        Committed record per network: contract ids, wasm hashes, constructor args
packages/           Shared TypeScript (network config, generated bindings)
reference/          Python differential reference for settlement math (written from spec)
keeper/             Off-chain epoch trigger (TypeScript) — convenience, never authority
bidder/             Open-source reference bidder (TypeScript)
web/                Deposit / withdraw / epoch status interface (Next.js)
scripts/            Network-parameterised deployment, upgrade, recovery tooling
docs/               Architecture, invariants, trust model, guides
```

## Building

Every version is pinned exactly, never by range or channel:

| | Pinned at |
|---|---|
| Rust | `1.95.0` — in `rust-toolchain.toml`, by exact version rather than `stable` |
| Build target | `wasm32v1-none` |
| `soroban-sdk` | `=27.0.6` |
| `stellar-cli` | `27.1.0` |
| Node / pnpm | 22 / 11 |

```bash
cargo test --workspace                    # unit + property
stellar contract build --out-dir out      # deployable wasm, all three contracts
```

The pins are not tidiness. The goal is that the binary deployed to mainnet is
**byte-identical** to the one that ran on testnet and was audited — an audit
certifies a binary, not an intention, and a build that cannot be reproduced
turns every invariant back into something asserted only by our own tests. So CI
builds the wasm twice, in clean environments at deliberately different paths,
and fails if the two hashes differ. Upgrading anything in the table above is a
recorded decision, because it invalidates every wasm hash on record until the
artefacts are rebuilt.

The contracts contain no network flags — no feature gates, no conditional
compilation, no network names in the source. Everything that differs between
testnet and mainnet is a constructor argument. CI greps for the alternative.

## Documentation

Full index: [`docs/`](docs/README.md) — start with the document written for what you're trying to do.

| Document | For |
|---|---|
| [`docs/DEPOSITOR.md`](docs/DEPOSITOR.md) | Depositors — the trade you're making, when you can exit, what can go wrong |
| [`docs/BIDDER.md`](docs/BIDDER.md) | **Counterparties** — what you're buying, how to bid, how you get paid, every stated risk |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Contract surface, storage model, epoch accounting, settlement math, failure modes |
| [`docs/INVARIANTS.md`](docs/INVARIANTS.md) | The properties that must hold in every state, and how each is verified |
| [`docs/TRUST_MODEL.md`](docs/TRUST_MODEL.md) | Who can do what to your funds — including the powers we'd rather not have |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability |

## License

Apache-2.0 — see [`LICENSE`](LICENSE).

---

*Antares is the red supergiant in Scorpius — the brightest star in its constellation. The name follows Stellar's convention; it is not a claim about the project's size.*
