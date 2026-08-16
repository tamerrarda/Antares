# Antares

**Covered call vaults on Stellar.** Deposit XLM, the vault writes a call against it each epoch, and the premium is credited back to depositors.

> **Status: pre-alpha, testnet only. Not audited.**
> Antares is built to mainnet semantics from the first line — the same accounting, the same trust model, the same failure handling. Testnet is a network parameter, not a different design. What separates this codebase from a mainnet deployment is an audit and a proven counterparty, not a rewrite.

---

## Why this exists

Stellar's DeFi stack has filled in from the bottom up:

| Layer | On Stellar today |
|---|---|
| Spot swap | Soroswap, Aquarius, Phoenix |
| Lending / borrowing | Blend, Kinetic |
| Yield vaults / aggregators | Upshift, Sentora, DeFindex |
| Perpetual futures | Stellars Finance, Rails |
| **Options / derivatives** | **nothing** |

The next layer up — options — does not exist on Stellar in any form. There is no on-chain mechanism for writing, auctioning, or settling an option. This is not a niche gap: on Ethereum and Solana, covered-call vaults (Ribbon/Opyn, Friktion/Katana) became a standard way for holders to earn income on assets they were already holding.

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
| **Options / covered call protocol** | **None found — open** |

> This scan is search-based and is **not** a guarantee. Before any public claim of novelty, it must be re-verified against the SCF project archive, the Stellar Developer Discord, and GitHub's `soroban` topic. If a prior attempt exists, that is useful — knowing why it stalled is worth more than believing nothing was tried.

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
IDLE ──open_epoch()──▶ AUCTION ──bid() fills──▶ ACTIVE ──settle()──▶ SETTLED ──▶ IDLE
                          │
                          └── floor reached, no bid ──▶ LAPSED ──▶ IDLE
```

`LAPSED` is a normal path, not an error. If no bidder appears, the premium for that epoch is zero, collateral stays exactly where it was, share price is unchanged, and the next epoch opens. **An epoch with no buyer costs depositors nothing.**

### Locked design decisions

Settled before the first line of contract code, because each one is expensive to change later. Every entry below is the *mainnet* choice, not a testnet shortcut.

| Decision | Choice | Why |
|---|---|---|
| Settlement | **Cash-settled in XLM** | No USDC leg, no atomic swap, no buyer credit risk. The payout comes out of collateral and is mathematically bounded by it. |
| Buyer capital | **Premium only** | A bidder never posts strike × notional — only the premium. This lowers the capital barrier to being a counterparty by roughly 20×, which matters most in a thin market. |
| Price discovery | **Dutch auction** | A fixed premium is not viable with real capital — it hands the bidder free optionality whenever volatility rises. A descending-price auction discovers the premium without requiring a volatility oracle, which Stellar does not have. |
| Premium accounting | **Recognised at fill, never at offer** | In an auction the clearing price is only known when a bid lands. Accounting that assumes a known premium at offer time breaks the day the auction is introduced. |
| Buyer access | **Permissionless `bid()`**, with a disableable allowlist | Mainnet cannot choose its counterparties. The allowlist is a launch control, not a design assumption — the code path is permissionless. |
| Share accounting | **Epoch-based: pending deposits, withdrawal queue, price-per-share per epoch** | Capital arriving mid-epoch must not dilute the premium earned by capital that was actually at risk. Retrofitting this is a rewrite, not a patch. |
| Contract count | **One contract** | Vault, auction and settlement share the same state. Splitting them buys cross-contract auth and state-sync problems and nothing else. Module boundaries live in the code, not at addresses. |
| Epoch length | **Parameter, not a constant** | Weekly is a product choice, not a protocol constraint. Short epochs also make end-to-end tests fast. |
| `open_epoch()` / `settle()` | **Permissionless** | A dead keeper must never be able to lock user funds. The keeper is a convenience, not an authority. |
| Fills | **Partial fills supported** | In a thin market, all-or-nothing means no fills at all. |
| Oracle | `PriceSource` interface · Reflector TWAP · staleness bound · deviation circuit breaker · defined dead-oracle policy | Settlement correctness rests entirely on the price feed. Every failure mode gets a defined behaviour, and none of them lock funds. |
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

**No proven counterparty.** Stellar has no professional options market makers and no liquid venue on which a bidder could hedge a written XLM call. The buyer side of this market is genuinely unproven, and this project does not claim otherwise. During testnet, the counterparty is a reference bidder operated by the project team and labeled as such everywhere it appears.

**No yield numbers.** Antares publishes **no APY, yield, or return figure** of any kind at this stage. Premiums cleared against a self-operated reference bidder are a test of the auction and settlement mechanism, not a market price. A number would be screenshotted; its disclaimer would not. Raw premium amounts are visible in the on-chain transactions, and that is where they stay.

**Oracle dependency.** Settlement correctness rests entirely on the price feed. The design bounds this — TWAP, staleness limits, a deviation breaker, and a dead-oracle policy that never traps funds — but bounding a risk is not eliminating it, and no amount of testnet activity proves behaviour under real volatility.

**Unaudited.** Every invariant in this repository is asserted by our own tests. That is necessary and not sufficient.

**Incumbent risk.** OpenZeppelin now ships a Soroban contract suite including vault primitives, and established yield protocols (Upshift, DeFindex) could extend into structured products. Being early is the entire advantage here, and it is a perishable one. Open source and public progress are the mitigation.

**Prior art is not encouraging and we are not ignoring it.** Friktion and Katana ran this structure on Solana and shut down. Their contracts worked; their counterparty base was a handful of desks, and when those desks left, premium went to zero. The failure mode of this product category is counterparty concentration, not contract risk — which is why counterparty discovery is treated here as a first-class deliverable rather than an afterthought.

## Roadmap

| Phase | Goal | Gate to the next phase |
|---|---|---|
| **1 — Mechanism** (current) | The full system runs end to end on testnet with mainnet semantics, verifiable from public transaction hashes | A closed epoch: deposit → auction → fill → settle → premium distributed, with every invariant tested |
| **2 — Counterparty** | Find out whether an independent bidder will pay a premium, and at what price | At least one independent address clears an auction |
| **3 — Mainnet** | Audit, findings resolved, capped launch | Audit complete; deposit cap and pause verified live |

Phase 2 is a market question, not an engineering one. It cannot be answered by writing more code, and progress on it is reported as findings — including refusals — rather than as metrics.

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

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — contract surface, storage model, epoch accounting, settlement math, failure modes

## License

Apache-2.0 — see [`LICENSE`](LICENSE).

---

*Antares is the red supergiant in Scorpius — the brightest star in its constellation. The name follows Stellar's convention; it is not a claim about the project's size.*
