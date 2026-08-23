# Antares — Known Issues and Accepted Risks

Things we know about and have decided to live with, plus things that are genuinely open. Kept
public and current, because the alternative — discovering them one at a time in an audit report —
is worse for everyone.

Format: what it is, why we accept it (or what would change our mind), and its status.

Last reviewed: 2026-08-18 (first code landed — workspace, toolchain pins and CI).

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
by more than **half** the out-of-the-money buffer (`max_deviation_bps < strike_bps_otm / 2`, D-45),
so no accepted open can put the strike below the prevailing market. Half is the limit, not the
setting: the five vaults sit at a third of the buffer on A and E, a fifth on B and D, and **0.45 on
C** — the near-the-money instance has the least room, which is the opposite of what a reader would
assume. What remains is choosing among moments inside that band — a real but
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

### A-6 · One epoch at a time per vault, one asset, one strategy

Within a vault, one epoch at a time. XLM only, covered calls only. (Several *vaults* run
concurrently on different terms — that is five instances of the same contract, not concurrent
epochs inside one.)

**Why accepted.** Every one of these is a product decision that can be revisited later without
changing the accounting model. Solving them now would be building for a market that has not
appeared yet.

### A-10 · A round nobody closes in time costs an in-the-money buyer his payout

The price feed keeps roughly **20 hours 20 minutes** of history at the current parameters, derived
from the feed's own live tick resolution rather than assumed. Past that, the expiry window cannot
be read by anyone, so the round finalizes *unresolved*: the premium stays with depositors and the payout is
zero. A buyer who was in the money and did not close the round loses the payout as well as the
premium; a buyer who was out of the money ends exactly where a settlement would have left him.

**Why accepted.** The alternative is to refund the premium, and that pays the buyer to wait — out
of the money, letting the clock run out returns 100 % of it, and the bounty is a capped fraction of
that same premium, so no incentive we can fund outbids it. Retaining the premium is the only rule under
which no party who could *cause* delay profits by it. One honest asymmetry survives the rule:
depositors collectively keep the payout if an in-the-money round drifts past the deadline — but
delay is not an action anyone can take, only an absence of one, closing is permissionless, and
the one party the drift would rob is the one with a payout-sized incentive and ~20 hours to act.
That is what makes the outcome a function of history instead of a race. Closing is permissionless, pays a bounty, and the buyer is the party who knows whether
he is in the money. The residual is the narrow case where the feed was genuinely dead at expiry
*and* nobody annulled the round during the roughly **eight hours** when annulment was available
(from 12 h to 20 h 15 m past expiry).

**What would change our mind.** A feed with materially deeper history, or a second source, would
widen the window enough that this stops being reachable in practice. It is stated in
[`BIDDER.md`](BIDDER.md) rather than left for a counterparty to discover.

---

### A-11 · A close can be delayed by resource limits, but not diverted

Closing a round reads the price feed through an adapter, and one failure mode is not catchable in
contract code: if the call exhausts the transaction's resource budget, the whole invocation dies
before any error can be returned. No wrapper prevents that.

**Why accepted, and why it is bounded rather than open-ended.** The adapter's work is *constant* —
a fixed number of point queries on a grid plus two configuration reads, independent of how late the
close happens. A read that fits the budget once fits always, so this is a "never worked at all"
failure that resource profiling and every prior round's close would surface, not a latent condition
that appears with age. What could still change it is the network's own limits or the feed's
per-call cost moving under us.

**And it cannot strand funds.** Past a bound fixed when the round opens and validated on-chain, a round
finalizes as *unresolved* **without calling the adapter at all** — the one terminal path that does
not depend on any external contract being reachable. So the worst case is that a close is late,
not that it never happens or that its outcome changes. This was not true until it was audited in:
the design previously claimed the same guarantee in three places with three incompatible
justifications, one of which was circular.

---

### A-12 · A mid-round change in the price feed's tick can cost a buyer his payout

Closing a round has a deadline fixed when the round opened, and a reachable-history limit read from
the feed at the moment of closing. Those two numbers are validated against each other when the
round opens. If the feed **lengthens its update interval while the round is live** — at today's
values a 3.4 % change is enough — the limit moves past the deadline, and the round can finalize as
*unresolved* at the deadline even though the price at expiry was still readable. A buyer who was in
the money loses the payout as well as the premium.

**Why accepted.** Closing this would require the deadline path to consult the price adapter, and
that path exists precisely so that a round still ends when the adapter cannot be called at all
(A-11). Trading a guaranteed exit for a rarer mispricing is the wrong trade. Opening a round
re-validates against the live feed, so the exposure is bounded to a single round rather than to
however long ago the parameters were set, and the case is driven by a test rather than assumed.

**The same precondition covers more than the deadline.** The sampling grid, and therefore the
settlement price itself, is derived from the feed's update interval as it stands when the round is
closed. So "every caller computes the same settlement price" is a statement about *callers* — which
is what it was written to guarantee — and not about a feed that re-times itself underneath a live
round. A large enough change in either direction makes the anchored window unreadable for the rest
of the round, at which point the round closes as *unresolved* at its deadline: depositors keep the
premium, and a buyer who was in the money loses the payout.

**A related case, guarded structurally.** The price feed is sponsored, and an unsponsored feed
deletes its history. That would erase records that existed at expiry and make a healthy feed look
dead — annulling the round and refunding the buyer. A round is therefore never opened unless the
feed's own funding outlasts it, which removes the reachable case; what remains is a sponsorship
window shortened after the round has already begun.

**What would change our mind.** A feed that publishes its tick interval as part of each reading,
letting the deadline be derived per round instead of per parameter change.

---

### A-13 · Anything sent straight to the contract address is gone

The vault never reads its own token balance. Measured 2026-08-23 against the whole contract: zero
call sites. Every price it computes comes from its own books — `total_assets()` returns
`state.locked_assets`, and a mint divides by `state.last_pps`, the price written at the last
settlement.

**That is a defence, and a well-known one.** A vault that priced shares from the tokens actually
sitting in it can be attacked by sending it some: the balance moves, the price moves with it, and an
early depositor is inflated or diluted by a transfer nobody accounted for. It is one of the oldest
attacks on this shape of contract. This design cannot be attacked that way, because a transfer it
did not record does not exist to it.

**The cost is the same fact read from the other side.** XLM sent directly to the contract address is
credited to nobody and can be withdrawn by nobody. There is no sweep, no admin path, and no
accounting route that releases it — the absence of all three is what makes the defence hold. It is
not stolen and it is not at risk; it stops existing as far as the protocol is concerned.

Deposit with `deposit()`. Anything else is a gift to nobody, and it is permanent.

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
before mainnet is a timelocked multisig whose delay exceeds a full epoch plus the bound past
which a round closes regardless of the feed (TRUST_MODEL §3 gives the number: 7 d 21 h), so users can always exit under the old code first. Immutability is something this codebase
can earn after an audit; declaring it now would be worse than useless.

### O-4 · Oracle dependency

Settlement correctness rests entirely on the price feed. Guards bound every failure mode we can
name, and worst-case damage is capped at one epoch's sold notional because nothing here is
leveraged.

**Status.** Bounded, not eliminated. A second independent feed (median-of-N) is a future **new
adapter contract** — the adapter itself is immutable, no admin and no upgrade path
([TRUST_MODEL](TRUST_MODEL.md) §3), so shipping it means a reviewed vault upgrade pointing at the
new deployment, never an in-place change — and there is now a concrete second source available on
Stellar.

### O-5 · No behaviour under real volatility has been observed

Every claim about how this performs comes from tests and reasoning, not from a live market.

**Status.** Inherent to the stage. Testnet activity does not resolve it and will not be presented
as if it does.

### O-6 · One of our two static analysers cannot run against the toolchain we pin

Scout, the Soroban static analyser named in our security tooling, builds the crate it is analysing
for the `wasm32-unknown-unknown` target. The Soroban SDK we build against refuses that target on
any recent Rust compiler and requires `wasm32v1-none` — which is the target this project pins. So
Scout's analysis build fails on all three of our contracts.

The part worth publishing is what it does next: it **exits successfully and prints a table
reporting each contract as analysed, with zero findings.** Measured 2026-08-18 against the current
release; overriding the target on the command line does not change it.

**Status.** Scout is out of the blocking part of CI, because a check that cannot run should not be
able to pass, and the job is gated on its log rather than its exit code, so it reports *"did not
analyse anything"* instead of *"found nothing"*. Without that, the difference would have been
invisible for as long as the tooling stayed broken, which is the more dangerous half of this issue
and the reason it is written down rather than absorbed.

Since **2026-08-19** it is also **opt-in per run** rather than running on every build. Measured:
cancelled at 9 minutes 57 seconds still compiling itself, having analysed nothing, while the whole
blocking chain finished in 4 minutes 23 seconds — roughly 60 % of a routine run's cost, spent on a
control that cannot execute against the compilation target this project pins. It is run
deliberately, and **it is required before the security review**, which is where the choice between
waiting for upstream and adopting the substitute below actually gets made.

What it costs is real and is not softened here: one of the two static analysers we named is
contributing nothing. Its detectors — overflow checks, unprotected code replacement,
divide-before-multiply, unbounded iteration, unsafe unwrap, storage misuse — are meanwhile covered
by the compiler's overflow checks, a lint that refuses unchecked arithmetic outright, the property
and fuzz suites, the independent Python reference for the settlement math, and the per-pull-request
review checklist. `unsafe-unwrap` is the one with no equivalent instrument and rests on review
alone. OpenZeppelin's Soroban scanner is the designated substitute if the upstream fix has not
arrived by the security review, at which point it stops being optional.

---

### O-7 · The deployed wasm can only be reproduced on the operating system it was built on

The verification story this project tells is the simple one: build the source yourself, hash the
result, compare it against the contract on chain. Measured 2026-08-23 against commit `f1b551f`,
that comparison depends on which machine you run it from.

| built on | sha256 | bytes |
|---|---|---|
| macOS (the machine that deployed) | `7b5f098b…a4a80f2` | 65 374 |
| `ubuntu-latest` (GitHub Actions) | `c581795e…1d7428e` | 65 374 |

Same commit, same pinned Rust (1.95.0), same pinned `stellar-cli` (27.1.0). The macOS hash is the
one recorded in `deployments/testnet.json` and in `packages/bindings/GENERATED.json`.

**What differs, measured against CI's own artefact.** The Linux binary was downloaded from the
workflow run that produced it and compared byte for byte with the local one. Every section has the
same length. `import`, `memory`, `global`, `export`, `data` and all four custom sections — including
the 19 023-byte `contractspecv0`, which is the entire typed interface — are **byte-identical**. The
601 strings in each are the same 601 strings. Three sections differ: `type`, `function`, `code`.

The cause is one step behind the first reading of it. The two builds emit **the same 140 functions
in a different order**: their body sizes match as a multiset and not in sequence, and the
function-to-type map is a permutation reaching type indices that the type table's own five displaced
entries never touch. Reordering functions renumbers every call target, which is why 125 of the 140
bodies differ; it also permutes the type table, because types are interned in first-use order.

This is a linker ordering difference, not a codegen difference, and no compiler flag reaches it —
which is why the remedy below is a container rather than a build setting.

**The interface is identical, and that is what makes this narrow.** On the Linux runner
`bindings.no_drift` and `bindings.surface` both pass: the bindings generated from the Linux build
are byte-identical to the committed ones, and every entry point is present. Only the wasm bytes
differ. Two explanations were tested and one was eliminated — `stellar contract build` was run both
with and without `--out-dir`, and on macOS both write the same optimized 65 374-byte artefact, so
this is not the raw-versus-optimized artefact split that `--out-dir` creates.

**What the reproducibility gate does and does not claim.** D-50's CI job builds one commit twice on
one runner at deliberately different path lengths and asserts the hashes match — because rustc
embeds source paths in panic locations and `stellar contract build` remaps the cargo registry but
not the workspace. That is *path* independence, it is a real property, and it passes. Reproducibility
across operating systems was never asserted. It is worth saying plainly because the job's name does
not distinguish the two, and a reader will take the wider claim from it.

**Two consequences, and the second is the one that matters.**

The smaller one, now closed: `bindings.wasm_recorded` could not pass in CI while the recorded hash
came from a developer's Mac and the runner was Linux. A permanently red check is not a neutral cost
— this repository's own CI file records three separate times that a check which fails on correct
code is switched off within the week, and then nothing enforces the row at all. It ran red for one
run and was fixed rather than switched off: both records that carry a build hash now carry the host
that produced it, and the check compares hashes when the host matches and asserts the record names
its host when it does not. It does not go quiet on a foreign host — it prints both hashes and says
which of the two forms ran — and `bindings.no_drift`, which compares the committed bindings against
a fresh generation from the wasm built on that host, is untouched and is what still catches real
drift there.

The larger one: **an auditor is more likely to be on Linux than on macOS.** Anyone who builds this
source in a container, on a runner, or on their own Linux box will get a hash that does not match
the deployed contract, and the honest reading of that — absent this note — is that the deployed
contract is not the published source. It is, and the difference is the host operating system.

**Status: open on the remedy, applied on the interim.** The real fix is to build releases inside a
pinned container so the host stops being an input to the hash; then the recorded value is
host-independent and CI can assert it outright. That has not been done. The interim has: `buildHost`
is recorded beside `rust` and `stellarCli` in the deployment record and in `GENERATED.json`, from
one definition in `scripts/lib/toolchain.ts` so the two records cannot drift apart on the name. A
mismatch is now diagnosable rather than mysterious.

`deployments/testnet.json` was written before the field existed, and its value was **backfilled
rather than inferred**: rebuilding the deployed commit on that same machine on 2026-08-23 produced
`7b5f098b…a4a80f2` again, byte for byte, which is what identifies the host that deployed it. That
rebuild is also incidental evidence for the narrower property the CI job does assert — that a build
is reproducible against a host.

Until the container lands, this note is the thing that stops a correct build from looking like a
compromised one.

## Fixed during design review

Kept for the record — these were real and are closed. All were found before any code existed,
which is the entire argument for the review process that found them.

| Issue | Found | Resolution |
|---|---|---|
| Lapsed rounds skipped withdrawal-queue accounting → reachable solvency violation | 2026-08-16 | Every outcome now finalizes through one shared code path |
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
| A price adapter that could never be called blocked every way of closing a round, leaving collateral in a live epoch permanently — while three separate passages claimed it could not happen, for three incompatible reasons, one of them circular | 2026-08-17 | A round now finalizes past a validated bound with no oracle call at all; the bound is constrained to return the outcome a working feed would have produced |
| The settlement price was undefined for an accepted input: the median could be taken over an even number of samples, with no tie-break specified in either implementation | 2026-08-17 | Sample sets are always odd — the short window requires all of its samples — so no even case exists to round |
| Forcing a positive share price in the degenerate case where the pool is worth less than one unit per share broke solvency: each withdrawal is recomputed independently from the round record, so the claims summed to more than the pool | 2026-08-17 | The price is never clamped; where a positive price and solvency conflict, solvency wins and minting is refused instead |
| The counterparty gate could be passed by an auction filled entirely at its reserve whenever realized volatility fell below ~29 % — the fourth time the same gate was satisfiable by the failure it was written to detect | 2026-08-17 | A second, volatility-independent condition against the reserve price, plus a published definition of the volatility estimator so the gate can be recomputed by anyone |
| Only settlements opened the mint/exit window, so a vault with no bidders had none at all — and a never-settled vault could not accept a second depositor | 2026-08-16 | Every outcome opens the window; the deadlock this was avoiding is solved by having `open_epoch` return rather than revert |
| Nobody was paid to settle: in the common case the only motivated caller preferred that nobody did | 2026-08-16 | Closing a round pays the caller a small bounty from the round's premium — on settlement and on the unresolved path, where the premium stays in the pool and is the source. Voiding pays none: a void refunds the premium in full, so a bounty could only come out of the refund or out of collateral |
| The auction floor sat 5–17× below fair value, so the expected case — an uncontested auction — was a systematic transfer to a lone bidder | 2026-08-16 | The floor is now a validated reserve price (at least half of fair value) |
| The project's own stop condition could fire in eight hours, because an empty round ends in one | 2026-08-16 | It now requires calendar time as well as epochs, and coherent parameters |
| The strike and premium band were chosen against an assumed volatility rather than a measured one; at XLM's real 30-day volatility every planned vault priced below its own reserve | 2026-08-16 | Volatility is measured at deploy time and the strike moved to 3 % out of the money, where fair value is robust across the observed range |
| Two of the five parameter sets could not have been deployed: one failed the deviation-vs-strike check, the other failed its own band, its floor rule *and* the minimum-idle-window validation | 2026-08-17 | Every instance now carries its own band and bounds, each verified against all five gates; the deploy script refuses the whole set if any one instance fails |
| Settlement anchored at expiry became unreadable after ~18 hours, at which point a healthy feed produced an annulment — refunding an out-of-the-money buyer his entire premium for waiting | 2026-08-17 | A third terminal outcome: past that horizon the round finalizes with the premium retained. No bounty could have fixed this, since the buyer's alternative was 100 % of the premium the bounty is paid from |
| The oracle adapter ignored the window parameters it was given: one setting silently measured a third of the intended window, another returned nothing at all and would have annulled every round | 2026-08-17 | The sampling grid is derived from the windows, and the adapter answers whether a window is usable at all — the vault asks, and never learns the feed's tick length |
| A garbage price at expiry would have been treated as "nobody looked in time", handing depositors a windfall from an oracle failure; and a transient adapter failure could have annulled a settleable round | 2026-08-17 | The read distinguishes a fact about the expiry window from a fact about the present ledger; only the first can annul a round |
| The Phase-2 clearing gate was satisfied by an auction that filled entirely at the floor — the exact failure it was written to detect — because the floor is defined as at least half of fair value and the gate asked for half | 2026-08-17 | Threshold raised to three quarters of fair value, and its dependence on the floor rule recorded so the two cannot drift apart again |
| The constructor could not populate seven of the thirteen configuration fields, and the share token's identity had nowhere to live | 2026-08-17 | Ten explicit arguments; fee, pause and allowlist are genesis constants, which also makes "the fee ships at zero" checkable on-chain rather than a claim |
| The auction window was two hours, and the project's own stop condition was written against a one-hour round that no longer existed | 2026-08-17 | Window shortened to 45 minutes on published evidence that long windows widen the gap between clearing price and fair value; the stop condition's arithmetic corrected |
