# Antares — Invariants

The properties that must hold in **every** reachable state, under **every** ordering of calls.
This file is the single canonical definition: `ARCHITECTURE.md` links here rather than restating
them, and the test suite asserts exactly this list.

Each invariant carries three things: what it says, why it exists (what breaks without it), and
how it is verified. An invariant nobody can test is a wish, not an invariant.

Notation: amounts are `i128` stroops (7 decimals). `PRECISION = 10_000_000`. `pps` is
price-per-share scaled by `PRECISION`.

---

## I1 — Solvency

```
contract_xlm_balance ≥ locked_assets
                     + pending_deposits_total
                     + withdraw_claimable_total
                     + bidder_claimable_total
                     + fee_claimable
```

**Why.** Every stroop the contract has promised to somebody must be covered by a stroop it
actually holds. The five terms are the five kinds of promise: collateral backing shares, deposits
not yet converted, withdrawals awaiting claim, bidder payouts/refunds awaiting claim, and accrued
protocol fee awaiting claim.

Every outbound amount in this protocol is **pulled, never pushed** — depositors, bidders and the
fee recipient all claim their own. Settlement therefore moves numbers between these buckets and
makes exactly one transfer: a small bounty to whoever called it, paid to an address the caller
names. That exception is deliberate — settlement must not depend on altruism — and it is safe
because an address that cannot receive is the caller's own problem, not a wedge for everyone else.
Voiding a round pays no bounty at all — the bidder is already motivated to call it, since voiding
is how he recovers his premium.

The inequality is deliberately `≥`, not `=`. Two sources of slack are expected and harmless:
rounding dust that accrues to the pool (every division floors in the vault's favour — see
[Rounding](#rounding-discipline)), and XLM sent directly to the contract address by anyone, which
belongs to nobody and is never counted.

**Verified by.** Property tests after every single state transition; the call-sequence fuzzer;
and a conservation test that drains every claim and asserts the residue is non-negative and
within the computed dust bound.

**If it breaks.** Someone cannot be paid. This is the invariant the entire design exists to
protect — a violation is a critical bug, not a rounding curiosity.

---

## I2 — Nothing is sold that isn't backed

```
notional_sold ≤ notional_offered ≤ locked_at_open
```

**Why.** The vault may only write calls against collateral it actually holds and has locked for
the round. `notional_offered` is snapshotted when the epoch opens; capital arriving afterwards
(pending deposits) is explicitly excluded, because it took none of the round's risk.

**Verified by.** Property tests over arbitrary bid sequences; the auction fuzzer specifically
attempts to oversell through partial fills, re-bids, and boundary timing.

**If it breaks.** The vault owes more than it holds — I1 fails as a consequence, and the "payout
is bounded by collateral" guarantee is void.

---

## I3 — Payout is strictly bounded by the sold notional

```
payout_total < notional_sold        for every possible settlement price
```

**Why.** This is the property that removes an entire class of DeFi failure. With
`payout = ⌊notional_sold × (spot − strike) / spot⌋`, as `spot → ∞` the ratio
`(spot − strike)/spot` approaches 1 from below but never reaches it. The vault therefore can
never owe more than the collateral behind the position: **no margin calls, no liquidation
engine, no bad debt, no cascading insolvency.** The bound is structural, not a risk parameter.

**Verified by.** Property tests over arbitrary `(spot, strike, notional)`; a dedicated settlement
fuzz target; and an independent Python reference implementation replaying shared test vectors.
Additionally checked over 200 000 randomized triples during design review (2026-08-16) with zero
violations.

**If it breaks.** The vault is insolvent by construction on a large enough price move.

---

## I4 — Locked collateral cannot leave during a live round

While `phase == Active`, no call path transfers any part of the locked collateral out of the
contract. `request_withdraw` only *records* intent — the transfer waits for finalization. Pending
deposits remain fully cancellable throughout, because they were never locked.

**Why.** The option is live; its collateral must be there when settlement arrives. Equally
important is the second half: capital that never backed the option must never be trapped by it.

**Verified by.** Call-sequence fuzzing under a live round, attempting every withdrawal path in
every order.

**If it breaks.** Settlement could fail to pay a bidder who is owed, or depositors could exit
ahead of a loss that they were exposed to.

---

## I5 — Share supply is exact

```
Σ balance(user) == shares_outstanding      after every mint, burn and transfer
```

**Why.** `shares_outstanding` is the denominator of price-per-share. If it drifts from reality,
every depositor's claim on the pool is silently wrong.

**Verified by.** Asserted after every token operation in unit tests and after every step in the
property suite.

---

## I6 — Every finalized round has a positive share price

```
Round(r).pps > 0        for every finalized round r
```

**Why.** A zero or negative `pps` would wipe out or invert every holder's claim. Combined with
I3 (payout strictly less than notional) and the fact that premium only ever adds to the pool,
the pool can be reduced but never emptied by settlement.

**Verified by.** Property tests across the full parameter space, including extreme settlement
prices.

---

## I7 — Round records are immutable

Once written, a `Round` record is never rewritten — not by settlement, not by an upgrade, not by
any admin action. There is no code path that writes the same round twice.

**Why.** Every unclaimed withdrawal and every unclaimed bidder payout is computed from its
round's record, potentially long after the fact. If history could be rewritten, every pending
claim would be at the mercy of whoever could rewrite it. This is what makes archival safe: an
archived record can only ever be *restored*, never re-derived differently.

**Verified by.** Structural check in the fuzz harness (hashing finalized records and asserting
they never change), plus explicit double-settle and double-finalize tests.

---

## I8 — The exit path cannot be paused

These all succeed while `paused == true`, in every state where they would succeed unpaused:

`settle` · `void_epoch` · `request_withdraw` · `claim_withdraw` · `claim_payout` ·
`claim_refund` · `claim_fee` · `cancel_pending_deposit` · `redeem_shares` · `restore_position`

`restore_position` belongs here because it is permissionless storage maintenance — and because a
paused vault whose entries are archiving must still be reachable.

Pause blocks exactly three things: `deposit`, `bid`, `open_epoch`.

**Why.** This is the property that makes "pause" safe to hold. A paused vault still settles its
live round (permissionlessly), still lets every depositor exit at the settled price, and still
lets every bidder claim. Pause can stop new risk from entering; it can never trap what is already
inside. That is also why no pause timeout is needed — a timeout would imply pause *can* hold
funds hostage.

**Verified by.** The call-sequence fuzzer repeats every generated sequence with `paused = true`
injected at a random point and asserts the above set still succeeds.

---

## I9 — Instant withdrawals are always covered

```
locked_assets × PRECISION ≥ shares_outstanding × last_pps        while phase == Idle
```

**Why.** Between rounds, holders can burn shares and be paid immediately at `last_pps`. This
invariant says the pool can always honour *all* of them at once — the vault is never in a state
where the first few exits are paid and the rest bounce.

**Proof sketch** (encoded as a property test rather than asserted): at settlement,
`pps = ⌊assets_R · P / S⌋ ⇒ S · pps ≤ assets_R · P`, and the withdrawal claims deducted satisfy
`wclaims · P ≤ burned · pps`, so `locked_new · P ≥ (S − burned) · pps`. Inductively, each Idle
mint adds `amount` to assets against shares worth `⌊amount·P/pps⌋ · pps ≤ amount · P`, and each
Idle burn removes `⌊shares·pps/P⌋ ≤ shares·pps/P`. Floor division always errs in the pool's
favour, so the inequality is preserved by every operation.

---

## Rounding discipline

Not an invariant but the rule that makes I1 and I9 hold: **every division floors, always in the
vault's favour.**

| Computation | Direction of error | Beneficiary |
|---|---|---|
| Share mint | fewer shares issued | pool (remaining holders) |
| Withdrawal claim | less XLM paid out | pool |
| `pps` | lower price | pool |
| Payout (total and per-bidder) | less XLM paid out | pool |
| Fee | less fee paid out | pool |
| Premium | less XLM collected | bidder (inbound only; solvency unaffected) |

Consequence: rounding can only ever make the contract *more* solvent. A few stroops of
unclaimable dust accumulate per round; this is measured and bounded by the conservation test,
and deliberately not swept — code to move dust is code that can move funds.

---

## What is *not* an invariant

Stated explicitly, because their absence is a design choice rather than an oversight:

- **There is no guarantee that an epoch earns a premium.** An auction with no bidder LAPSES:
  premium zero, collateral untouched, `pps` unchanged. Costing depositors nothing is the
  guarantee; earning them something is not.
- **There is no guarantee that settlement happens on time.** If the oracle is stale, settlement
  reverts and may be retried by anyone, indefinitely. Late is a defined state; wrong is not.
- **There is no guarantee that a round settles at all.** If the feed stays unusable past the
  dead-oracle bound, the round is annulled and premiums are refunded. Nobody profits from an
  oracle failure — and nobody is trapped by one.
- **There is no guarantee about returns.** See the README's stance on yield numbers.
