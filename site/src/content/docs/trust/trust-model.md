---
title: Who can do what to your funds
deck: Every power that exists in this system and who holds it — including the one we would rather did not exist.
---

Written to be uncomfortable rather than reassuring. If a power exists, it is listed here even where
we would rather it did not — a trust model that only mentions the flattering parts is marketing.

> **Status —** Pre-alpha, testnet, **unaudited**. Nothing below is a claim that the code correctly
> implements it. It describes what the design intends; an audit is what turns intent into evidence.
> [Where this stands](../start/status.md).

## The short version

| Actor | Can they take your funds? | Can they trap your funds? |
|---|---|---|
| **Admin** (a single key on testnet) | No — except by upgrading the code (§3) | No — the exit path is unpausable |
| **Keeper** (the operator's bot) | No | No — everything it does, anyone can do |
| **Bidder** (counterparty) | No — they can only win the option's payout, capped below the sold notional | No |
| **The price feed** (third-party) | Indirectly and boundedly — a compromised feed can shift value between depositors and bidders, capped at one round's sold notional | No — a dead feed annuls the round and refunds, and a feed nobody reads in time still resolves to a defined outcome |
| **Another depositor** | No | No |
| **The protocol authors** | Only via the admin key — see §3, the honest answer | No |

**The one real trust concentration is `upgrade()`.** Everything else on this page is a structural
guarantee; that one is a promise backed by key management.

## 1. What the admin can do

- Pause new deposits, new bids and new rounds.
- Set the deposit cap, the fee parameter, the fee recipient, and the round parameters — effective
  from the *next* round only, never the live one.
- Enable or disable the bidder allowlist and its entries — **but only until it expires.**
- Hand the admin role to another address, via a **two-step transfer** the new address must accept. A
  one-step handover to a mistyped address would permanently brick the role.
- Adjust storage rent parameters (TTL thresholds) — pure housekeeping, cannot touch accounting.
- Replace the contract code (§3).

Two of those deserve their own paragraph.

**The fee is `0` at genesis and cannot be set by a deploy argument.** It is a constant in the
constructor, not a parameter, so a non-zero fee always leaves a **public transaction** behind. You do
not have to take our word for the zero. It is capped at 20 % *of the premium* — never of your
capital — and it is snapshotted when a round opens, so a change can never apply to a round anyone
was already in.

**The allowlist ships enabled and carries an expiry fixed at construction, with no setter.** The
admin can open the vault early and cannot keep it closed. Past that timestamp `bid` ignores the
allowlist entirely and re-enabling the flag does nothing. The number is readable before you deposit
anything — in `config()`, in the `initialized` event, and in the committed deployment record.

This is deliberate. *"We will open bidding soon"* is a promise, and a promise is exactly the kind of
thing this document exists to eliminate. Extending it is not a parameter change; it requires a code
upgrade, with the disclosure and delay that implies.

## 2. What the admin cannot do

There is no code path for any of these. It is not a policy.

- **Move, borrow, or redirect user funds.**
- **Mint shares, or change anyone's balance.**
- **Alter a finalized round record**, so no past settlement, price, or claim can be rewritten.
- **Choose or influence the settlement price, or which way a round ends.** `close_round()` reads the
  feed as it stood at expiry and dispatches on what it finds; it is callable by anyone and the admin
  has no privileged variant. **Nobody names the outcome — not the admin, not the keeper, not the
  bidder, not you.**
- **Block the exit path.** These nine succeed while paused, in every state where they would succeed
  unpaused: `close_round`, `request_withdraw`, `claim_withdraw`, `claim_payout`, `claim_refund`,
  `claim_fee`, `cancel_pending_deposit`, `redeem_shares`, `restore_position`. Pause blocks exactly
  three things: `deposit`, `bid`, `open_epoch`.
- **Change the oracle address, or the asset.** Both are fixed at construction and **neither has a
  setter in the contract at all.** Repointing a price feed is the single most dangerous parameter
  change in a protocol like this, so changing it requires a full code upgrade.

### Why pause has no timeout

A common request is that pause should expire automatically. It does not need to, because **pause
cannot hold anything hostage.** A paused vault closes its live round permissionlessly — settling,
voiding or resolving as unresolved, whichever the feed dictates — and every depositor can then exit
at the resulting price.

The worst-case delay is bounded by `expiry + unresolved_after`, after which anyone can close the
round whatever the feed or the adapter is doing. A timeout would be a weaker guarantee that implied
a stronger fear.

## 3. Upgradeability, the honest part

**The contract is upgradeable.** The admin can replace its code with different code, which means
that in the limit the admin can do anything: the guarantees in §2 are enforced by the code deployed
*today*, and new code could enforce something else.

This was chosen deliberately over immutability, and the reasoning is not flattering to us: **this
code is unaudited.** Immutability before an audit is not a virtue, it is an unfixable bug waiting to
happen. Immutability is something a protocol earns with evidence, not something it declares to sound
trustworthy.

| Stage | Admin | What you are trusting |
|---|---|---|
| **Testnet (now)** | A single key held by the project | The operator, completely. Do not put value here you would mind losing — it is testnet, and that is the point |
| **Before mainnet** | A timelocked multisig | A signer set, plus a delay long enough that you can leave first |
| **Long term** | Open question | Immutability becomes reasonable once the code has an audit and a track record |

The mainnet requirement is specific and has **two terms**:

> **delay > `epoch_duration + unresolved_after`**

`epoch_duration` is the wait for the live round to reach expiry. `unresolved_after` is the bound past
which that round **closes regardless of the feed** — not the 12-hour `oracle_dead_after`, which is
only when annulment becomes *possible*, and a possibility is not an exit.

At the mainnet-target configuration (a 7-day round) that is **7 days 21 hours**. On the deployed
3-day vault the same formula gives 3 days 21 hours.

**`min_idle_gap` is deliberately not a third term**, and this is worth stating because it looks like
one. Closing a round is not the same act as withdrawing, so the natural worry is that the withdrawal
needs the idle window that closing opens. It does not: `claim_withdraw` and `request_withdraw` run in
any phase and are unpausable, and a queued withdrawal becomes claimable the instant its round
finalizes. The second transaction is available in the same ledger as the close. A timelock shorter
than the whole exit path is theatre — but so is padding the bound with a step the contract does not
impose.

Operational rule: **never upgrade while a round is live.** The contract permits it; the deployment
tooling refuses it.

### One thing upgradeability does not cover

The price adapter — the separate contract where every settlement number is computed — **has no admin
and no upgrade path of its own.** Its exported surface is the price interface and nothing else,
asserted at deploy. If it could be upgraded, whoever held that key could move the settlement price
silently, which would make it a second concentration as powerful as this one. It cannot, so the
upgrade key described above is the only one there is.

## 3b. What you are trusting the deployment to be

The contract that holds funds on mainnet is intended to be the **same binary, byte for byte**, that
ran on testnet and went through the audit. Everything network-specific — the XLM asset contract, the
oracle address, the admin, every parameter, the deposit cap, the fee — is passed in at deployment or
set by an admin call afterwards. The contracts contain no build flags, no conditional compilation and
no network branches, and a static source check in CI refuses any that appear.

Why that belongs in a trust model rather than a build document: **an audit certifies a binary.** If
mainnet ran a recompiled variant, the audit would describe code that is not the code holding your
money — and so would every testnet round anyone pointed at as evidence. The check is mechanical, and
its result is publishable, so you do not have to take our word for it. See
[What is deployed](../reference/deployment.md#reproducing-the-hashes) for the one honest caveat about
build hosts.

The known threat to this is protocol drift: Stellar testnet usually upgrades before mainnet, so a
window exists where testnet offers features mainnet has not voted in. The policy is to build against
what **mainnet** supports and to treat any testnet-only dependency as a finding to publish rather
than a difference to ship.

## 4. What you are trusting the oracle for

The full envelope — which feed, which guards, what a dead one costs, and what a fully compromised one
caps at — is on [The price feed](../mechanism/price-feed.md). The trust statement in one paragraph:

Settlement price comes from an external CEX & DEX XLM/USD feed — a third-party contract,
aggregating deep off-chain markets, and deliberately *not* an on-chain order book. Three guards sit
in front of it, all permissionless to retry. If the feed dies, the round is annulled past a defined bound and premiums
are refunded. If nobody looks in time, the round still ends. If **our own adapter** is the thing
that fails, the round closes without calling it at all, past a bound validated on-chain. Even a
fully compromised feed caps at one round's sold notional, because there is no leverage anywhere in
the system.

**What you are trusting here is arithmetic, not attentiveness.**

## 5. What you are trusting the keeper for: nothing that holds your money

The keeper is a bot that calls `open_epoch()` and `close_round()` on a timer. Both are
permissionless, and `close_round` does not let its caller choose how a round ends. If it dies, stops,
or turns hostile:

- Rounds open late, or not at all — depositors keep their funds and can withdraw between rounds.
- Rounds close whenever anyone calls, including you — and the outcome does not depend on who did or
  when, with one bounded exception: a round nobody closes for about twenty hours can no longer be
  decided on evidence and finalizes with the premium retained.
- Nothing is ever locked by its absence.

**One honest qualification.** The keeper also writes the per-round archive the interface uses to
*find* an old unclaimed payout, and the volatility series published beside each clearing price.
Neither holds funds and neither can move any: a claim is a single transaction against on-chain state
that anyone can construct without us. What a dead keeper costs is **discoverability** — the money
stays yours and stays claimable, but you may have to know your own round number to reach it. That is
a real dependency and it is not the same as a custodial one.

## 6. What you are trusting Stellar for

Assumptions inherited from the platform, listed because they are real even though they are outside
this project's control:

- **Ledger timestamps** are approximately honest. All round timing is wall-clock seconds.
- **XLM as an asset** — the vault holds and pays XLM through the Stellar Asset Contract.
- **Transaction ordering** is not manipulable in ways that break the auction. Bids carry a mandatory
  slippage guard precisely so that ordering cannot fill you at a worse price.
- **State archival** — persistent storage may be evicted and later restored. Every claimable amount
  is a pure function of immutable data, so archival can delay a claim but never change or strand it.
- **Protocol upgrades** happen on Stellar's schedule and can change costs and behaviour underneath
  this design.

## If you find a contradiction

If you find something that contradicts this page, **that contradiction is the vulnerability.**
Please report it as one — [Reporting a vulnerability](../reference/security.md).
