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
| **Options / derivatives** | **one testnet protocol (Lusty); no on-chain price discovery** |

The next layer up — options — is barely populated: one live testnet protocol (Lusty, see below), no options protocol in Stellar's DeFi TVL rankings, and **no on-chain price discovery for an option anywhere on the network.** Every attempt so far has priced the option off-chain. This is not a niche gap: on Ethereum and Solana, covered-call vaults (Ribbon/Opyn, Friktion/Katana) became a standard way for holders to earn income on assets they were already holding.

Antares builds that primitive: one asset, one strategy, one vault — designed as a system that can hold real value.

### Ecosystem gap scan

| Category | Status on Stellar |
|---|---|
| Perpetual DEX | Exists (Stellars Finance, Rails) |
| Memecoin launchpad | Exists |
| NFT marketplace | Exists (Litemint) |
| DEX aggregator | Exists (Soroswap) |
| Lending / borrowing | Exists (Blend, Kinetic) |
| Yield vault / aggregator | Exists (Upshift, Sentora, DeFindex) |
| **Options / covered call protocol** | **One live on testnet (Lusty), several dead attempts** |

> **Re-verified against the SCF archive and GitHub (2026-08).** This layer is neither empty nor untouched.
>
> **[Lusty Finance](https://lusty.finance)** is live on testnet and actively developed: XLM covered calls and cash-secured puts, a Soroban vault holding collateral, Reflector settlement pinned to the expiry timestamp, and a permissionless `settle()`. It went through an SCF panel review. It is not a graveyard entry — it works, and anyone comparing the two should start there.
>
> Behind it there *is* a graveyard: Block Time Financial took SCF funding (~$61.5k, rounds #14/#15) for a Soroban options contract whose last commit is October 2023, plus several inactive single-developer attempts.
>
> **So what is left for Antares?** Not the idea — the market structure. In Lusty the protocol itself is the counterparty: a pool buys the option from you, and the price comes from an off-chain quote engine whose key co-signs each premium. That is a legitimate design and it sidesteps the hardest problem in this category by answering it internally. Antares takes the opposite bet: **the counterparty is an independent bidder, and the price is discovered on-chain by a descending auction with no privileged quoter.** Nobody has to trust a pricing server, and nobody's pool absorbs the risk — but it only works if independent bidders actually show up, which is precisely the question this project exists to answer and has not answered yet. If they don't, Lusty's design is the better one and we should say so.

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
                                   │  open_epoch() / settle()
                                   │  permissionless — anyone may call
                          ┌────────┴─────────┐
                          │  Keeper (script) │  convenience only,
                          │  cron trigger    │  never an authority
                          └──────────────────┘
```

### Epoch state machine

```
IDLE ──open_epoch()──▶ AUCTION ──bid() fills──▶ ACTIVE ──settle()──────▶ SETTLED ──▶ IDLE
                          │                        │
                          │                        └── oracle dead ────▶ VOIDED ──▶ IDLE
                          └── floor reached, no bid ──────────────────▶ LAPSED ──▶ IDLE
```

`LAPSED` is a normal path, not an error. If no bidder appears, the premium for that epoch is zero, collateral stays exactly where it was, share price is unchanged, and the next epoch opens. **An epoch with no buyer costs depositors nothing.**

`VOIDED` is the third terminal state and equally normal: if the price feed is unusable past a defined bound, the epoch is annulled — premiums are refunded to bidders, no payout is made, share price is unchanged. Nobody profits from an oracle failure, and nothing is trapped by one.

### Locked design decisions

Settled before the first line of contract code, because each one is expensive to change later. Every entry below is the *mainnet* choice, not a testnet shortcut.

| Decision | Choice | Why |
|---|---|---|
| Settlement | **Cash-settled in XLM** | No USDC leg, no atomic swap, no buyer credit risk. The payout comes out of collateral and is mathematically bounded by it. |
| Buyer capital | **Premium only** | A bidder never posts strike × notional — only the premium. This lowers the capital barrier to being a counterparty by roughly 20×, which matters most in a thin market. |
| Price discovery | **Dutch auction on-chain, with an in-the-money guard** | A fixed premium is not viable with real capital — it hands the bidder free optionality whenever volatility rises. A descending-price auction discovers the premium without requiring a volatility oracle, which Stellar does not have. Bids are refused the moment spot reaches the strike: a descending curve cannot price intrinsic value, and an empty auction costs depositors nothing. |
| Premium accounting | **Recognised at fill, never at offer** | In an auction the clearing price is only known when a bid lands. Accounting that assumes a known premium at offer time breaks the day the auction is introduced. |
| Buyer access | **Permissionless `bid()`**, with a disableable allowlist | Mainnet cannot choose its counterparties. The allowlist is a launch control, not a design assumption — the code path is permissionless. |
| Share accounting | **Epoch-based: pending deposits, withdrawal queue, price-per-share per epoch** | Capital arriving mid-epoch must not dilute the premium earned by capital that was actually at risk. Retrofitting this is a rewrite, not a patch. |
| Contract count | **One contract** | Vault, auction and settlement share the same state. Splitting them buys cross-contract auth and state-sync problems and nothing else. Module boundaries live in the code, not at addresses. |
| Epoch length | **Parameter, not a constant** | Weekly is a product choice, not a protocol constraint. Short epochs also make end-to-end tests fast. |
| `open_epoch()` / `settle()` | **Permissionless** | A dead keeper must never be able to lock user funds. The keeper is a convenience, not an authority. |
| Fills | **Partial fills supported** | In a thin market, all-or-nothing means no fills at all. |
| Oracle | `PriceSource` interface · Reflector's deep CEX & DEX XLM/USD feed (never a thin on-chain market) · TWAP · staleness bound · self-consistency circuit breaker · defined dead-oracle policy | Settlement correctness rests entirely on the price feed. Every failure mode gets a defined behaviour, and none of them lock funds. Feed *selection* is part of the security model, not plumbing. |
| Admin surface | **Admin role, pause, deposit cap, fee parameter (set to 0) — present from day one** | All four touch storage layout and auth. Adding them later means a migration. Shipping them unused costs nothing. |
| Pause semantics | **Pause can never trap funds** | Pause stops deposits, bids and new epochs — nothing else. Settlement, epoch void and the entire withdrawal path are unpausable, so a paused vault always unwinds to cash with bounded delay. No pause timeout is needed; the exit path simply cannot be closed. |
| Upgradeability | **Upgradeable v1** — admin-gated `upgrade()`, versioned `migrate()` | Pre-audit, the ability to fix a bug outweighs the stronger trust statement of immutability. Testnet admin is a single documented address; **before mainnet it becomes a timelocked multisig** whose delay exceeds a full epoch, so users can always exit at the old code. This is the protocol's one real trust concentration and it is disclosed, not disguised. |
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

**Unaudited, and currently unbuilt.** The design is complete and frozen; the contract is not written yet. When it is, every invariant in [`docs/INVARIANTS.md`](docs/INVARIANTS.md) will be asserted by our own tests — which is necessary and not sufficient. Until an external audit says otherwise, every correctness claim here is our own.

**We are not first, and the incumbent is closer than the usual kind.** [Lusty Finance](https://lusty.finance) is already live on Stellar testnet doing XLM covered calls, with a working web app, an SCF panel review behind it, and a shipped Soroban vault. Being early is not our advantage — it is not available. What is left is a different answer to the same question: they price the option with an off-chain quote engine and make the protocol the counterparty; we discover the price on-chain and require a real counterparty to show up. Which is better is an empirical question, and their design is the safer bet if independent bidders never appear.

Beyond that: OpenZeppelin ships Soroban vault primitives, and established yield protocols (Upshift, DeFindex) could extend into structured products with distribution we do not have. Open source and public progress are the only mitigation on offer.

**Prior art is not encouraging and we are not ignoring it.** Friktion and Katana ran this structure on Solana and shut down. Their contracts worked; their counterparty base was a handful of desks, and when those desks left, premium went to zero. The failure mode of this product category is counterparty concentration, not contract risk — which is why counterparty discovery is treated here as a first-class deliverable rather than an afterthought.

## Roadmap

| Phase | Goal | Gate to the next phase |
|---|---|---|
| **1 — Mechanism** (current) | The full system runs end to end on testnet with mainnet semantics, verifiable from public transaction hashes | A closed epoch: deposit → auction → fill → settle → premium distributed, with every invariant tested — **at parameters where the option's fair value actually falls inside the auction's price band**, so the fill means something |
| **2 — Counterparty** | Find out whether an independent bidder will pay a premium, and at what price | **All three:** ≥3 addresses outside our control fill; ≥4 consecutive epochs with a fill; notional-weighted average clearing at least a quarter of the way up the auction curve |
| **3 — Mainnet** | Audit, findings resolved, capped launch | Audit complete; deposit cap and pause verified live |

Phase 2 is a market question, not an engineering one. It cannot be answered by writing more code, and progress on it is reported as findings — including refusals — rather than as metrics.

The third condition is the one that can fail us. An uncontested Dutch auction always walks toward its floor; if clearing prices cluster at the bottom of the curve, price discovery never happened and the mechanism has quietly degenerated into a fixed premium that hands the buyer a free timing option. That would falsify a load-bearing design assumption, and we would report it as falsification rather than as a fill count. (The condition is weighted by notional and requires a material margin, because the obvious phrasings — "at least one fill above the floor" — turn out to be satisfiable by every possible fill, and therefore falsify nothing.)

### The stop gate

Every gate above is a *go* gate. Here is the one that ends the project:

> **If 8 consecutive epochs *and* at least 30 calendar days pass with the bidder allowlist disabled and no independent fill, development stops.** Both conditions are required because an empty round ends in an hour, not a week — eight of them could otherwise elapse overnight, against evidence gathered while no counterparty was awake. The allowlist must be disabled within 14 days of the first testnet epoch, so the one gate that can end the project cannot be frozen by leaving a launch control on. We publish what happened — how many epochs, at what parameters, what premiums were on offer, how many counterparties we approached and what they told us — and then choose, explicitly and publicly: pivot, park the code, or close.

At a weekly epoch that is about two months. A project without a stop condition cannot tell you it was wrong, and this product category has been wrong before.

## Repository layout

```
contracts/          Soroban contracts (Rust): vault, Reflector adapter, mock price source
reference/          Python differential reference for settlement math (written from spec)
keeper/             Off-chain epoch trigger (TypeScript) — convenience, never authority
bidder/             Open-source reference bidder (TypeScript)
web/                Deposit / withdraw / epoch status interface (Next.js)
scripts/            Network-parameterised deployment, upgrade, recovery tooling
docs/               Architecture, invariants, known issues
```

## Documentation

Full index: [`docs/`](docs/README.md) — start with the document written for what you're trying to do.

| Document | For |
|---|---|
| [`docs/DEPOSITOR.md`](docs/DEPOSITOR.md) | Depositors — the trade you're making, when you can exit, what can go wrong |
| [`docs/BIDDER.md`](docs/BIDDER.md) | **Counterparties** — what you're buying, how to bid, how you get paid, every stated risk |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Contract surface, storage model, epoch accounting, settlement math, failure modes |
| [`docs/INVARIANTS.md`](docs/INVARIANTS.md) | The properties that must hold in every state, and how each is verified |
| [`docs/TRUST_MODEL.md`](docs/TRUST_MODEL.md) | Who can do what to your funds — including the powers we'd rather not have |
| [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) | Accepted risks, open questions, and what design review already caught |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability |

## License

Apache-2.0 — see [`LICENSE`](LICENSE).

---

*Antares is the red supergiant in Scorpius — the brightest star in its constellation. The name follows Stellar's convention; it is not a claim about the project's size.*
