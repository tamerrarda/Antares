# Antares — Trust Model

Who can do what to your money, and what you are trusting when you use this protocol.

Written to be uncomfortable rather than reassuring. If a power exists, it is listed here even
when we would rather it didn't exist — a trust model that only mentions the flattering parts is
marketing.

> **Status: pre-alpha, testnet only, unaudited.** Nothing below should be read as a claim that
> the code correctly implements it. It describes what the design intends; an audit is what turns
> intent into evidence.

---

## 1. The short version

| Actor | Can they take your funds? | Can they trap your funds? |
|---|---|---|
| **Admin** (single key on testnet) | No — except by upgrading the code (§3) | No — the exit path is unpausable (§2) |
| **Keeper** (operator's bot) | No | No — everything it does, anyone can do |
| **Bidder** (counterparty) | No — they can only win the option's payout, capped below the sold notional | No |
| **Oracle** (Reflector) | Indirectly and boundedly — a compromised feed can shift value between depositors and bidders, capped at one epoch's sold notional (§4) | No — a dead feed annuls the round and refunds, and even a feed nobody reads in time resolves to a defined outcome (§4) |
| **Another depositor** | No | No |
| **The protocol authors** | Only via the admin key — see §3, the honest answer | No |

The one real trust concentration is **`upgrade()`**. Everything else in this document is a
structural guarantee; that one is a promise backed by key management.

---

## 2. What the admin can and cannot do

**Can:**

- Pause new deposits, new bids and new epochs.
- Set the deposit cap, the fee parameter, the fee recipient, and the epoch parameters (effective
  from the *next* epoch only — never the live one). The fee is `0` at genesis and cannot be set by
  a deploy argument, so **a non-zero fee always leaves a public transaction behind**; you do not
  have to take our word for the zero.
- Enable/disable the bidder allowlist and its entries — **but only until it expires.** This is a
  launch control, and the code path underneath is permissionless. The allowlist ships **enabled**
  and carries an expiry timestamp fixed at construction, with **no setter**: the admin can open the
  vault early, and cannot keep it closed. Past that timestamp `bid` ignores the allowlist entirely,
  and re-enabling the flag does nothing.

  The number is readable before you deposit anything — it is in `config()`, in the `initialized`
  event, and committed to `deployments/<network>.json`. This is deliberate: "we will open bidding
  soon" is a promise, and a promise is exactly the kind of thing this document exists to eliminate.
  Extending it is not a parameter change; it requires a code upgrade, with the disclosure and delay
  that implies (§3).
- Hand the admin role to another address, via a **two-step transfer** (the new address must
  accept). A one-step handover to a mistyped address would permanently brick the role.
- Adjust storage rent parameters (TTL thresholds) — pure housekeeping, cannot touch accounting.
- Replace the contract code (§3).

**Cannot** — there is no code path, not a policy:

- Move, borrow, or redirect user funds.
- Mint shares, or change anyone's balance.
- Alter a finalized round record (I7) — so no past settlement, price, or claim can be rewritten.
- Choose or influence the settlement price, or which way a round ends. `close_round()` reads the
  oracle as it stood at expiry and dispatches on what it finds; it is callable by anyone and the
  admin has no privileged variant. **Nobody names the outcome — not the admin, not the keeper, not
  the bidder, not you.**
- Block the exit path. The full unpausable set is defined in [INVARIANTS.md](INVARIANTS.md) I8 —
  settlement, voiding, every withdrawal and claim path, pending cancellation and redemption, the
  fee claim, and archival maintenance all work while paused.
- Change the oracle address, or the asset. Both are fixed at construction and **neither has a
  setter in the contract at all** — repointing the price feed is the single most dangerous
  parameter change in a protocol like this, so changing it requires a full code upgrade, with
  everything that implies (§3).

### Why pause has no timeout

A common request is "pause should expire automatically". It doesn't need to, because pause cannot
hold anything hostage: a paused vault closes its live round permissionlessly, and every
depositor can then exit at the resulting price. The worst case delay is bounded by the live epoch's
`expiry + unresolved_after` — after which anyone can close the round and every depositor can exit,
whatever the price feed or the adapter is doing. A timeout would be a weaker guarantee that
implied a stronger fear.

---

## 3. Upgradeability — the honest part

**The contract is upgradeable.** The admin can replace its code with different code, which means
that in the limit the admin can do anything: the guarantees in §2 are enforced by the code that
is deployed *today*, and new code could enforce something else.

We chose this deliberately over immutability, and the reasoning is not flattering to us: this
code is unaudited. Immutability before an audit is not a virtue, it is an unfixable bug waiting
to happen. Immutability is something a protocol earns with evidence, not something it declares to
sound trustworthy.

What that means concretely:

| Stage | Admin | What you are trusting |
|---|---|---|
| **Testnet (now)** | Single key held by the project | The operator, completely. Do not put value here you would mind losing — it is testnet, and that is the point. |
| **Before mainnet** | Timelocked multisig | A signer set, plus a delay long enough that you can leave first |
| **Long term** | Open question | Immutability becomes reasonable once the code has an audit and a track record |

The mainnet requirement is specific and has **two** terms:

> **delay > `epoch_duration + unresolved_after`** — 7 d 21 h at the shipped values (7 d + 21 h),
> matching the bound §2 already gives.

`epoch_duration` is the wait for the live round to reach expiry. `unresolved_after` is the bound
past which that round **closes regardless of the feed** — not the 12 h `oracle_dead_after`, which
is only when annulment becomes *possible*, and a possibility is not an exit.

**`min_idle_gap` is deliberately not a third term, and this is worth stating because it looks like
one.** Closing a round is not the same act as withdrawing, so the natural worry is that the
withdrawal needs the idle window that closing opens. It does not: `claim_withdraw` and
`request_withdraw` run in **any phase** and are **unpausable** (§2's list, I8), and a queued
withdrawal becomes claimable the instant its round finalizes. So the second transaction is
available in the same ledger as the close, and adding `min_idle_gap` would describe a wait nobody
does. A timelock shorter than the whole exit path is theatre — but so is padding the bound with a
step the contract does not impose.

Operational rule: never upgrade while a round is live. The contract permits it; the deployment
tooling refuses it.

One more thing upgradeability does **not** cover, stated because a careful reader will ask: the
price adapter — the separate contract where every settlement number is computed — **has no admin
and no upgrade path of its own**. Its exported surface is the price interface and nothing else,
asserted at deploy. If it could be upgraded, whoever held that key could move the settlement
price silently, which would make it a second concentration as powerful as this one; it cannot,
so the upgrade key described in this section is the only one there is.

---

## 3b. What you are trusting the deployment to be

The contract that holds funds on mainnet is intended to be the **same binary, byte for byte**,
that ran on testnet and went through the audit. Everything network-specific — the XLM asset
contract, the oracle address, the admin, every epoch parameter, the deposit cap, the fee — is
passed in at deployment or set by an admin call afterwards. The contracts contain no build flags,
no conditional compilation and no network branches, and CI fails on any that appear.

Why this belongs in a trust model rather than a build document: an audit certifies a *binary*.
If mainnet ran a recompiled variant, the audit would describe code that is not the code holding
your money, and so would every testnet round anyone pointed to as evidence. The check is
mechanical — rebuild from the audited commit, compare hashes, refuse the deploy on a mismatch —
and its result is publishable, so you do not have to take our word for it.

The known threat to this is protocol drift: Stellar testnet usually upgrades before mainnet, so a
window exists where testnet offers features mainnet has not voted in. The policy is to build
against what **mainnet** supports and to treat any testnet-only dependency as a finding to
publish rather than a difference to ship.

## 4. What you are trusting the oracle for

Settlement price comes from Reflector's **external CEX & DEX XLM/USD feed** — prices aggregated
from deep off-chain markets, deliberately *not* an on-chain order book.

That choice is the lesson of a real incident. In February 2026 a lending pool on Stellar lost
roughly $10M when a correctly-functioning oracle read a thin on-chain market: one trade moved an
asset from ~$1 to ~$106, and the pool treated the print as collateral value. No contract broke.
The failure was in choosing a manipulable price source, so here that choice is part of the trust
model rather than a configuration detail.

Three guards sit in front of settlement, and all of them are permissionless to retry:

1. **Time-weighted price**, never a single tick.
2. **Self-consistency** — a short window compared against a longer one from the same moment. This runs when an epoch **opens**, never at settlement: an anchored window is frozen history that cannot recover from a rejection, so a breaker there could only convert a settleable round into an annulled one. A
   feed artifact skews the short window and not the long one; a genuine market move carries both.
   The breaker therefore fires on malfunction and *not* on real volatility. This matters for
   fairness: a breaker that tripped on real moves would annul valid rounds and confiscate
   bidders' earned payouts.
3. **A coarse sanity bound** against the previous settlement price.

**If the feed dies**, the round is annulled past a defined bound: premiums are refunded to
bidders, depositors gain nothing, share price is unchanged. An oracle failure is nobody's fault, and
nobody who could cause one profits from one — a buyer whose option ended worthless does keep the
refund a settlement would have taken, but a feed's death is not an event any participant can
bring about, and the guards read only its frozen history. Critically, nobody is trapped by it
either, because annulment is permissionless.

**And if nobody looks in time**, the round still ends. The feed keeps a bounded history, so the
expiry window eventually stops being readable; past that point the round finalizes *unresolved* —
the premium stays with depositors, the payout is zero. **The same is true if our own price adapter
is the thing that fails**: past a bound validated on-chain to sit strictly beyond that history, and bounded above so no admin setting can push it out of reach,
`close_round()` finalizes the round as unresolved *without calling the adapter at all*. That path
exists so the guarantee below does not depend on any external contract being callable, and it is
constrained to return the outcome a working adapter could only have returned at that moment, so it
cannot be used to steer a result. That rule is not chosen to be kind to
either side but to make delay worthless to both: an out-of-the-money buyer ends up exactly where
settling would have put him, and an in-the-money one is strictly worse off, so neither of them has a reason
to let the clock run (depositors passively keep more if an in-the-money round drifts — disclosed
in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) A-10 — but drift is not an action anyone can take). What you are trusting here is arithmetic, not attentiveness.

**Worst case, assume the feed is fully compromised** and every guard defeated:

- Price faked **high**: the vault pays out at most `notional_sold − 1` stroop (I3), and only to
  bidders who paid real premium for those fills. The attacker must also be the bidder to collect,
  and cannot reach pending deposits or unclaimed balances.
- Price faked **low**: payout is zero; only bidders lose, and only their premium.

There is no leverage anywhere in the system, so oracle compromise caps at one epoch's sold
notional. That is the structural difference from a lending protocol, where the same failure
scales with borrowing power.

---

## 5. What you are trusting the keeper for: nothing that holds your money

The keeper is a bot that calls `open_epoch()` and `close_round()` on a timer. Both are
permissionless, and `close_round` does not let its caller choose how the round ends. If it dies, stops, or turns hostile:

- Epochs open late, or not at all — depositors keep their funds and can withdraw between rounds.
- Rounds close whenever anyone calls, including you — and the outcome does not depend on who did
  or when, with one bounded exception stated in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) A-10: a round
  nobody closes for about 20 hours can no longer be decided on evidence and finalizes with the
  premium retained. That rule is chosen so nobody who could cause the delay gains
  by it — the passive asymmetry that survives is stated in A-10, not hidden.
- Nothing is ever locked by its absence.

The keeper is a convenience, never an authority.

**One honest qualification, added when the interface was specified.** The keeper also writes the
per-round archive the app uses to *find* an old, unclaimed bidder payout, and the volatility series
published beside each clearing price. Neither holds funds and neither can move any: a claim is a
single transaction against on-chain state that anyone can construct without us. What a dead keeper
costs is **discoverability** — the money stays yours and stays claimable, but you may have to know
your own round number to reach it. That is a real dependency and it is not the same as a custodial
one. This is a design rule, not an operational
promise: a dead operator must never be able to freeze user funds.

---

## 6. What you are trusting Stellar for

Assumptions inherited from the platform, listed because they are real even though they are
outside our control:

- **Ledger timestamps** are approximately honest. All epoch timing is wall-clock seconds.
- **XLM as an asset** — the vault holds and pays XLM through the Stellar Asset Contract.
- **Transaction ordering** is not manipulable in ways that break the auction. Bids carry a
  mandatory slippage guard precisely so that ordering cannot fill you at a worse price.
- **State archival** — persistent storage may be evicted and later restored. Every claimable
  amount is a pure function of immutable data, so archival can delay a claim but never change or
  strand it.
- **Protocol upgrades** happen on Stellar's schedule and can change costs and behaviour under us.

---

## 7. Residual risks we cannot design away

- **The code is unaudited and, at the time of writing, unbuilt.** The design is frozen; the
  implementation follows it. Every invariant will be asserted by our own tests, which is necessary
  and not sufficient.
- **The counterparty side is unproven.** No professional options market makers operate on
  Stellar, and XLM options do not trade on a major venue, so a bidder cannot hedge volatility
  risk. This is the project's largest open question and it is a market question, not a code one.
- **Adverse selection.** A bidder who times the auction curve against fair value gains at
  depositors' expense. The auction floor bounds this to under-fair *time value* — the in-the-money
  guard prevents selling intrinsic value outright — but a volatility-blind mechanism cannot
  eliminate it.
- **Prior art in this category is discouraging.** Comparable vaults on other chains shut down.
  We think the interesting failure was economic rather than technical, and we may be wrong about
  that in either direction.

---

## 8. Reporting a problem

See [`SECURITY.md`](../SECURITY.md). If you find something that contradicts this document, that
contradiction *is* the vulnerability — please report it as one.
