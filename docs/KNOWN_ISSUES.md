# Antares — Known Issues and Accepted Risks

Things we know about and have decided to live with, plus things that are genuinely open. Kept
public and current, because the alternative — discovering them one at a time in an audit report —
is worse for everyone.

Format: what it is, why we accept it (or what would change our mind), and its status.

Last reviewed: 2026-08-16 (design stage — no code exists yet).

---

## Accepted by design

### A-1 · Adverse selection inside the auction

A bidder who prices the option better than our descending curve can wait for the moment the curve
crosses fair value and fill then. In a market with one sophisticated buyer, that buyer wins on
average.

**Why accepted.** Eliminating it needs a volatility model, and Stellar has no volatility feed. We
bound it instead: the reserve price (auction floor) caps how cheaply time value can be sold, and
the in-the-money guard prevents selling intrinsic value at all — the vault refuses to fill once
spot reaches the strike.

**What would change our mind.** Evidence from real rounds that clearing prices sit consistently
at the floor. That is also the signal that price discovery is not happening, and it is an
explicit falsification condition for the auction design.

### A-2 · Rounding dust is never swept

Every division floors in the vault's favour, so a few stroops accumulate per round that nobody
can claim.

**Why accepted.** It can only make the contract more solvent, and it is bounded and measured by
the conservation test. Code that sweeps dust is code that moves funds, and that is a larger
attack surface than the dust is worth.

### A-3 · Capital deposited mid-round earns nothing that round

Deposits during a live round wait as pending and convert afterwards.

**Why accepted.** The alternative is late capital sharing a premium that earlier capital earned
by taking the risk. Pending deposits can be cancelled at any time, in any phase, so nothing is
trapped — it just doesn't earn.

### A-4 · Shares can only be minted between rounds

Both instant deposits and pending-deposit conversion happen in the idle window.

**Why accepted.** Minting mid-round at a stale price hands the new shares a claim on the live
round's profit and loss that their capital never backed; if the share price rises, total claims
exceed the pool and solvency breaks. Every round outcome — settled, lapsed or voided — opens the window, and it
scales with the epoch length (D-43), so this is a scheduled inconvenience, never a lock.

### A-5 · Bidders must claim; nothing is pushed to them

Payouts and refunds sit as contract state until the bidder claims them.

**Why accepted.** Pushing means settlement iterates over bidders, which makes the cost of
settling grow with participation — a denial-of-service surface aimed at the exit path itself.
Unclaimed balances are persistent and never expire.

### A-7 · Whoever opens an epoch chooses the strike's basis

`open_epoch` is permissionless, and the strike is derived from the price at that instant. So the
caller picks the moment, and a bidder who opens on a dip buys a cheaper option than one who opens
on a rally.

**Why accepted, and how it is bounded.** The alternative — permissioned opening — reintroduces
the operator as an authority over user funds, which this design refuses. Instead the *range* is
capped: the deviation guard rejects any open where the short TWAP diverges from the hourly TWAP
by more than a third of the out-of-the-money buffer (D-45), so no accepted open can put the strike
below the prevailing market. What remains is choosing among moments inside that band — a real but
small advantage, and one the keeper removes in practice by opening promptly.

### A-8 · A sole counterparty has leverage over the parameters

If exactly one bidder exists, they can withhold fills to push the team toward a lower floor, a
further-out strike, or a longer epoch — and the team, which needs fills to pass its own Phase-2
gate, has every incentive to concede. Each concession looks like progress and is actually a
transfer.

**Why accepted.** No contract mechanism can fix a negotiation. The guard is procedural and lives
in the roadmap: the Phase-2 gate requires **three independent addresses over four consecutive
epochs**, clearing prices are published **beside Black-Scholes fair value** rather than only as
raw bps, and the floor cannot be lowered past half of fair value without failing the deploy gate.
If the only way to attract a bidder is to price below the reserve, that is the finding — not a
parameter change.

### A-9 · Pending deposits can squat the deposit cap for free

A pending deposit counts against the cap, earns nothing, is never at risk, and is cancellable at
any moment (D-37). So someone can occupy the whole cap and withdraw instantly whenever they like,
denying entry to real depositors at close to zero cost — and on testnet, where XLM is free from
the faucet, at literally zero cost.

**Why accepted for now.** The cap is a launch control, not a permanent feature, and the remedy
(raising it) is one admin call away. Charging for the privilege of waiting, or making cancellation
conditional again, both cost more than the problem: the first taxes honest depositors, the second
re-opens the free-option hole D-37 just closed. Revisit if it actually happens.

### A-6 · One epoch at a time, one asset, one strategy

No concurrent epochs, XLM only, covered calls only.

**Why accepted.** Every one of these is a product decision that can be revisited later without
changing the accounting model. Solving them now would be building for a market that has not
appeared yet.

---

## Open questions we cannot close ourselves

### O-0 · A live competitor already answers this question differently

[Lusty Finance](https://lusty.finance) is live on Stellar testnet with XLM covered calls and
cash-secured puts, a Soroban vault, Reflector settlement pinned to expiry, permissionless
`settle()`, and an SCF panel review behind it. Its design makes the *protocol* the counterparty
and prices each option with an off-chain quote engine (Black-76, realized-vol driven) whose key
co-signs the premium.

**Status.** This is not a defect in our design but it is the most important fact about our
position, and it cuts both ways. Their approach removes the dependency on independent bidders —
the thing we cannot yet prove exists — at the cost of a trusted pricing key and a pool that
absorbs the risk. Ours removes the trusted pricing key at the cost of needing bidders to show up.
If the Phase-2 gate fails, their trade-off was the right one and we should say so publicly rather
than quietly pivot.

### O-1 · The counterparty side is unproven

Stellar has no professional options market makers, and XLM options do not trade on a major venue,
so a bidder cannot hedge volatility risk (XLM futures and perpetuals exist, so delta can be
hedged). Comparable vaults on other chains shut down, and the interesting failure there looks
economic rather than technical.

**Status.** This is the project's largest open risk and it cannot be answered by writing more
code. It has an explicit success condition (independent buyers, over several rounds, clearing
above the reserve price) and an explicit stop condition — see the README roadmap.

### O-2 · The code is unaudited

**Status.** External audit is a precondition for any mainnet deployment. Path of record: the
Soroban Audit Bank. Until then, every correctness claim in this repository rests on our own
tests.

### O-3 · Upgradeability is a live trust concentration

The admin can replace the contract code, which in the limit overrides every guarantee the current
code makes.

**Status.** Disclosed rather than removed; see [`TRUST_MODEL.md`](TRUST_MODEL.md) §3. Mitigation
before mainnet is a timelocked multisig whose delay exceeds a full epoch plus the dead-oracle
bound, so users can always exit under the old code first. Immutability is something this codebase
can earn after an audit; declaring it now would be worse than useless.

### O-4 · Oracle dependency

Settlement correctness rests entirely on the price feed. Guards bound every failure mode we can
name, and worst-case damage is capped at one epoch's sold notional because nothing here is
leveraged.

**Status.** Bounded, not eliminated. A second independent feed (median-of-N) is a future adapter
change that would not touch the vault, and there is now a concrete second source available on
Stellar.

### O-5 · No behaviour under real volatility has been observed

Every claim about how this performs comes from tests and reasoning, not from a live market.

**Status.** Inherent to the stage. Testnet activity does not resolve it and will not be presented
as if it does.

---

## Fixed during design review

Kept for the record — these were real and are closed. All were found before any code existed,
which is the entire argument for the review process that found them.

| Issue | Found | Resolution |
|---|---|---|
| Lapsed rounds skipped withdrawal-queue accounting → reachable solvency violation | 2026-08-16 | All three outcomes now finalize through one shared code path |
| Testnet parameters priced the option 6–90× below the auction floor — no rational buyer could ever have filled | 2026-08-16 | Parameters corrected; fair-value coherence is now a deployment gate |
| Circuit breaker compared across epochs, so a genuine sustained price move would have annulled valid rounds and confiscated earned payouts | 2026-08-16 | Breaker now compares two windows of the same moment: fires on feed malfunction, never on real moves |
| Bidder payouts were pushed at settlement → unbounded iteration on the exit path | 2026-08-16 | Pull-based claims; settlement is constant-cost |
| A mistyped address in a one-step admin handover would have permanently bricked the role | 2026-08-16 | Two-step transfer (propose, then accept) |
| Division-by-zero at settlement was prevented only by an unrelated guard, one refactor from a panic | 2026-08-16 | Explicit share-supply check when opening an epoch |
| The idle exit window was a fixed hour regardless of epoch length | 2026-08-16 | Now scales with the epoch |
| Claimed there was no prior options work on Stellar; there was, and it died | 2026-08-16 | README corrected — the category has failed here before, which is useful information |
| Share-price inflation: a holder could burn supply to ~zero, then every small deposit minted zero shares while its XLM joined the pool | 2026-08-16 | Permanent dead shares floor the supply; every mint must produce at least one share |
| Pending deposits converted at a frozen old price — broke solvency and gave a free lookback option across rounds | 2026-08-16 | They convert at the current price; cancellation is open for the deposit's whole life |
| Anchoring settlement to expiry (a fix for timing extraction) let an out-of-the-money bidder wait out the clock and reclaim his entire premium | 2026-08-16 | Void reads the same anchored history as settle, so the outcome is fixed at expiry and cannot be elected afterwards; feed-retention constraint now actually validated |
| The same anchoring turned the circuit breaker into a confiscation device: an artifact in a frozen window could never clear, voiding valid rounds | 2026-08-16 | Median instead of mean — the estimator carries the artifact resistance the retry loop used to |
| Only settlements opened the mint/exit window, so a vault with no bidders had none at all — and a never-settled vault could not accept a second depositor | 2026-08-16 | Every outcome opens the window; the deadlock this was avoiding is solved by having `open_epoch` return rather than revert |
| Nobody was paid to settle: in the common case the only motivated caller preferred that nobody did | 2026-08-16 | Settlement and voiding pay the caller a small bounty from the round's premium |
| The auction floor sat 5–17× below fair value, so the expected case — an uncontested auction — was a systematic transfer to a lone bidder | 2026-08-16 | The floor is now a validated reserve price (at least half of fair value) |
| The project's own stop condition could fire in eight hours, because an empty round ends in one | 2026-08-16 | It now requires calendar time as well as epochs, and coherent parameters |
