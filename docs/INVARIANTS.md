# Antares — Invariants

The properties that must hold in **every** reachable state, under **every** ordering of calls.
This file is the single canonical definition: `ARCHITECTURE.md` links here rather than restating
them, and the test suite asserts exactly this list.

Each of the ten invariants carries three things: what it says, why it exists (what breaks without it), and
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
fee recipient all claim their own. Closing a round therefore moves numbers between these buckets and
makes exactly one transfer: a small bounty to whoever called it, paid to an address the caller
names. That exception is deliberate — settlement must not depend on altruism — and it is safe
because an address that cannot receive is the caller's own problem, not a wedge for everyone else.
The bounty is paid when a round settles and when it finalizes unresolved — in both cases the
premium stays in the pool and is the source. **Voiding pays none**, because a void refunds the
premium in full and leaves `pps` untouched, so the money could only come out of the refund
(breaking the exact-refund promise made to bidders) or out of collateral (breaking "a void costs
depositors nothing"). The bidder is in any case the party motivated to void, since voiding is how
he recovers his premium.

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

While a round is live — auction and active phases both, because the collateral is locked from
the moment the round opens — no call path transfers any part of it out of the contract.
`request_withdraw` only *records* intent in either phase; the transfer waits for finalization.
Pending deposits remain fully cancellable throughout, because they were never locked.

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

## I6 — Share price is never negative, and is zero only when the pool truly is

```
Round(r).pps ≥ 0        for every finalized round r
Round(r).pps == 0  ⟺  assets_R × PRECISION < shares_snapshot
```

**Why.** A negative `pps` would invert every holder's claim, and it is unreachable: `pps` is a
floor division of two non-negative quantities. Combined with I3 (payout strictly less than
notional) and the fact that premium only ever adds to the pool, the pool can be reduced but never
emptied by settlement.

**Why not simply `pps > 0`.** That was this invariant's original wording, and it is not
achievable together with [I1](#i1--solvency). If the pool is ever worth less than one stroop per
`PRECISION` share-units, no *positive integer* price is both truthful and solvent: forcing
`pps ≥ 1` would make each withdrawal claim — recomputed independently from the round record as
`⌊shares × pps / PRECISION⌋` — sum to more than the pool holds, and the last claimant would find
nothing there. Where the two invariants conflict, **solvency wins**: the round records the zero,
every holder can still exit for the zero their shares are honestly worth, and minting is refused
(`VaultWorthless`) so nothing ever divides by it. The state needs two consecutive near-total-loss
rounds to reach, and it is not necessarily permanent — premium is additive, so a later round can
lift the pool back above the threshold.

**Verified by.** Property tests across the full parameter space, including extreme settlement
prices; and a dedicated test that drives the pool into the degenerate state and asserts that
every holder's claim succeeds, that their sum does not exceed the pool, and that a deposit
reverts rather than dividing by zero.

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

`close_round` · `request_withdraw` · `claim_withdraw` · `claim_payout` ·
`claim_refund` · `claim_fee` · `cancel_pending_deposit` · `redeem_shares` · `restore_position`

`restore_position` belongs here because it is permissionless storage maintenance — and because a
paused vault whose entries are archiving must still be reachable.

Pause blocks exactly three things: `deposit`, `bid`, `open_epoch`.

**Why.** This is the property that makes "pause" safe to hold. A paused vault still closes its
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

## I10 — Closing a round is a function of history, not of the caller

Once a round is past expiry, **at most one** terminal outcome is ever reachable, and which one it
is does not depend on who calls `close_round()` or when.

**Why.** This is the property that makes the protocol worth using without trusting anyone. The
price is read as it stood *at expiry*, so calling early or late cannot change it; the outcome is
selected by what that read returns, so no caller can name it. The three answers partition
cleanly — the feed answered (settle), the feed was demonstrably dead at expiry and we can still
see that it was (void), or expiry has left the feed's reachable history (unresolved) — and the
rule for the third is chosen so that **no party who can cause a delay gains by one** (the passive
depositor-side asymmetry that survives the rule is disclosed in
[KNOWN_ISSUES](KNOWN_ISSUES.md) A-10 — it is not an action anyone can take). Without that last part the
invariant would still hold formally while paying an out-of-the-money buyer his whole premium back
for doing nothing.

Two states are deliberately non-terminating, and **both are bounded in time rather than merely
expected to clear**: a *transient* failure (the adapter trapped this ledger, which says nothing
about expiry) and the grace period before a dead feed may annul a round. Both revert and may be
retried by anyone. The grace period ends at `expiry + oracle_dead_after`. A transient failure that
never clears ends at `expiry + unresolved_after`, where the round is finalized **unresolved without
calling the price adapter at all** — a bound validated on-chain to sit strictly beyond the feed's
reachable history, so it returns the outcome a working adapter could only have returned anyway and
therefore adds no fourth reachable result.

**One stated precondition (D-68).** `unresolved_after` is fixed when the round opens; the feed's
reachable depth is read live when it closes. If the price feed lengthens its tick mid-round — a
3.4 % change is enough at today's values — the fallback can fire while the anchored read would
still have answered, which costs an in-the-money buyer his payout. Opening a round re-checks the
live feed, so the exposure is one round rather than open-ended, and the residual is listed in
[`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) rather than argued away.

That last clause is load-bearing and was missing until it was audited in. If a permanently
unreachable adapter could block every branch, `close_round()` would revert forever and the round's
collateral would stay in `ACTIVE` — the exact state this protocol claims is unreachable. A
terminal path that touches no external contract is what makes the claim structural.

**Verified by.** A property test sweeping every read outcome against every elapsed time, asserting
one reachable outcome per cell and the declared gaps as the only gaps; plus an economic property
test asserting a bidder's total recovery under the unresolved path is never greater than under a
normal settlement.

**If it breaks.** The outcome becomes negotiable by whoever transacts first, which is the thing
this protocol exists to avoid.

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
- **There is no guarantee that settlement happens on time.** If the oracle cannot be read, closing
  reverts and may be retried by anyone — but not indefinitely: the wait is bounded by the deadline in I10. Late is a defined state; wrong is not.
- **There is no guarantee that a round settles at all.** If the feed was unusable at expiry past
  the dead-oracle bound, the round is annulled and premiums are refunded. If nobody closes the
  round before expiry leaves the feed's reachable history — or if the price adapter cannot be
  called at all up to a validated bound past that — it finalizes *unresolved*: the premium stays
  with depositors and the payout is zero. Nobody who can cause an oracle failure or a delay
  profits from one, nobody is trapped by one, and — the reason the third outcome exists at all —
  **waiting is not an action that pays anyone who can choose it**; the passive depositor-side
  asymmetry (more stays in the pool if an in-the-money round is never closed in time) is real,
  disclosed in [KNOWN_ISSUES](KNOWN_ISSUES.md) A-10, and reachable by nobody's decision.
- **There is no guarantee that every round has a positive share price.** See I6: where a positive
  price and solvency cannot both hold, solvency wins.
- **There is no guarantee about returns.** See the README's stance on yield numbers.
