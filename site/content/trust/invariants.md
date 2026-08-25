---
title: The properties that must always hold
deck: Ten invariants, each with what it says, why it exists, and how it is checked. An invariant nobody can test is a wish.
---

# The properties that must always hold

These must hold in **every** reachable state, under **every** ordering of calls. This is the
canonical list; every other page on this site links here rather than restating them, and the test
suite asserts exactly this list.

> **Status —** These are asserted by this project's own tests. That is necessary and not sufficient.
> No external party has audited any of it. [Where this actually stands](../start/status.md).

Notation: amounts are `i128` stroops (7 decimals). `PRECISION = 10 000 000`. `pps` is price per
share scaled by `PRECISION`.

## In one line each

| | |
|---|---|
| **I1** | The contract holds at least everything it has promised |
| **I2** | Nothing is sold that is not backed |
| **I3** | The payout is strictly less than the sold notional, for every possible price |
| **I4** | Locked collateral cannot leave during a live round |
| **I5** | Share supply is exact |
| **I6** | Share price is never negative, and is zero only when the pool genuinely is |
| **I7** | Round records are immutable once written |
| **I8** | The exit path cannot be paused |
| **I9** | Instant withdrawals between rounds are always fully covered |
| **I10** | Closing a round is a function of history, not of the caller |

---

## I1: Solvency

```
contract_xlm_balance ≥ locked_assets
                     + pending_deposits_total
                     + withdraw_claimable_total
                     + bidder_claimable_total
                     + fee_claimable
```

**What it says.** Every stroop the contract has promised to somebody is covered by a stroop it
actually holds. The five terms are the five kinds of promise: collateral backing shares, deposits
not yet converted, withdrawals awaiting claim, bidder payouts and refunds awaiting claim, and
accrued protocol fee awaiting claim. **Every one of the five is a field in contract storage**, so the
invariant is checkable against state rather than recomputable only by replaying events.

**Why the inequality is `≥` and not `=`.** Two sources of slack are expected and harmless: rounding
dust that accrues to the pool, because every division floors in the vault's favour; and XLM sent
directly to the contract address by anyone, which belongs to nobody and is never counted.

**One exception, deliberately.** Every outbound amount in this protocol is **pulled, never pushed** —
depositors, bidders and the fee recipient all claim their own. Closing a round moves numbers between
these buckets and makes exactly one transfer: the bounty, to an address the caller names. That is
safe because an address that cannot receive is the caller's own problem, not a wedge for everyone
else, and settlement must not depend on altruism. Voiding pays none — a void refunds the premium in
full, so the money could only come out of the refund or out of collateral.

**Verified by.** Property tests after every single state transition; the call-sequence fuzzer; and a
conservation test that drains every claim and asserts the residue is non-negative and within the
computed dust bound.

**If it breaks.** Someone cannot be paid. This is the invariant the entire design exists to protect.

## I2: Nothing is sold that is not backed

```
notional_sold ≤ notional_offered ≤ locked_at_open
```

**What it says.** The vault may only write calls against collateral it actually holds and has locked
for the round. `notional_offered` is snapshotted when the round opens; capital arriving afterwards
is explicitly excluded, because it took none of the round's risk.

**Verified by.** Property tests over arbitrary bid sequences; the auction fuzzer specifically
attempts to oversell through partial fills, re-bids and boundary timing.

## I3: Payout is strictly bounded by the sold notional

```
payout_total < notional_sold        for every possible settlement price
```

**What it says.** With `payout = ⌊notional_sold × (spot − strike) ÷ spot⌋`, as `spot → ∞` the ratio
approaches 1 from below and never reaches it, and the floor can only make it smaller.

This removes an entire class of DeFi failure: **no margin calls, no liquidation engine, no bad debt,
no cascading insolvency.** The bound is structural rather than a risk parameter. It is also the
reason a compromised price feed caps at one round's sold notional.

**Verified by.** Property tests over arbitrary `(spot, strike, notional)`; a dedicated settlement
fuzz target driving raw tuples straight into the settlement arithmetic — which is why that
arithmetic is factored out as a pure function that needs no ledger to call; and an independent
Python reference implementation replaying shared test vectors.

## I4: Locked collateral cannot leave during a live round

**What it says.** While a round is live — auction and active phases both, because collateral is
locked from the moment the round opens — no call path transfers any part of it out of the contract.
`request_withdraw` only *records* intent; the transfer waits for finalization.

**And the second half, which matters as much:** pending deposits remain fully cancellable
throughout, because they were never locked. Capital that never backed the option must never be
trapped by it.

**Verified by.** Call-sequence fuzzing under a live round, attempting every withdrawal path in every
order.

## I5: Share supply is exact

```
Σ balance(user) == shares_outstanding      after every mint, burn and transfer
```

**What it says.** `shares_outstanding` is the denominator of price per share. If it drifts from
reality, every depositor's claim on the pool is silently wrong.

**The vault's own address is one of the holders, and a reader summing balances has to count it.**
The first deposit mints 1 000 stroops of dead shares to the contract itself, which floors the supply
against an inflation attack and is never redeemable. It is in the sum on both sides, so the equality
is exact rather than approximate — but a check that skipped the vault's balance would report a
permanent 1 000-stroop shortfall and be wrong.

**Verified by.** Asserted after every token operation in unit tests and after every step in the
property suite.

## I6: Share price is never negative, and is zero only when the pool truly is

```
Round(r).pps ≥ 0        for every finalized round r
Round(r).pps == 0  ⟺  assets_R × PRECISION < shares_snapshot
```

**Why not simply `pps > 0`.** That was this invariant's original wording, and it is **not achievable
together with I1**. If the pool is ever worth less than one stroop per `PRECISION` share-units, no
positive integer price is both truthful and solvent: forcing `pps ≥ 1` would make each withdrawal
claim — recomputed independently from the round record — sum to more than the pool holds, and the
last claimant would find nothing there.

**Where the two conflict, solvency wins.** The round records the zero, every holder can still exit
for the zero their shares are honestly worth, and minting is refused (`VaultWorthless`) so nothing
ever divides by it. The state needs two consecutive near-total-loss rounds to reach, and it is not
necessarily permanent — premium is additive, so a later round can lift the pool back above the
threshold.

**Verified by.** Property tests across the full parameter space, including extreme settlement prices;
and a dedicated test that drives the pool into the degenerate state and asserts that every holder's
claim succeeds, that their sum does not exceed the pool, and that a deposit reverts rather than
dividing by zero.

## I7: Round records are immutable

**What it says.** Once written, a `Round` record is never rewritten — not by settlement, not by an
upgrade, not by any admin action. There is no code path that writes the same round twice.

**Why.** Every unclaimed withdrawal and every unclaimed bidder payout is computed from its round's
record, potentially long after the fact. If history could be rewritten, every pending claim would be
at the mercy of whoever could rewrite it. This is also what makes archival safe: an archived record
can only ever be *restored*, never re-derived differently.

**Verified by.** A structural check in the fuzz harness that hashes finalized records and asserts
they never change, plus explicit double-settle and double-finalize tests.

## I8: The exit path cannot be paused

These all succeed while `paused == true`, in every state where they would succeed unpaused:

`close_round` · `request_withdraw` · `claim_withdraw` · `claim_payout` · `claim_refund` ·
`claim_fee` · `cancel_pending_deposit` · `redeem_shares` · `restore_position`

**Pause blocks exactly three things:** `deposit`, `bid`, `open_epoch`.

`restore_position` belongs in the list because it is permissionless storage maintenance, and because
a paused vault whose entries are archiving must still be reachable.

**Why.** This is the property that makes a pause key safe to hold. A paused vault still closes its
live round permissionlessly, still lets every depositor exit at the settled price, and still lets
every bidder claim. Pause can stop new risk from entering; it can never trap what is already inside.
That is also why **no pause timeout is needed** — a timeout would imply pause *can* hold funds
hostage.

**Verified by.** The call-sequence fuzzer repeats every generated sequence with `paused = true`
injected at a random point and asserts the above set still succeeds. Additionally rehearsed live
against testnet on 2026-08-21 with real transactions.

## I9: Instant withdrawals are always covered

```
locked_assets × PRECISION ≥ shares_outstanding × last_pps        while phase == Idle
```

**What it says.** Between rounds, holders can burn shares and be paid immediately at `last_pps`. This
invariant says the pool can always honour *all* of them at once — the vault is never in a state
where the first few exits are paid and the rest bounce.

**Proof sketch**, encoded as a property test rather than asserted: at settlement,
`pps = ⌊assets_R · P ÷ S⌋ ⇒ S · pps ≤ assets_R · P`, and the withdrawal claims deducted satisfy
`wclaims · P ≤ burned · pps`, so `locked_new · P ≥ (S − burned) · pps`. Inductively, each idle mint
adds `amount` to assets against shares worth `⌊amount·P÷pps⌋ · pps ≤ amount · P`, and each idle burn
removes `⌊shares·pps÷P⌋ ≤ shares·pps÷P`. Floor division always errs in the pool's favour, so the
inequality is preserved by every operation.

**Verified by.** An assertion run after every state transition the property suite makes — **and
guarded against being vacuous**, which is the part worth stating. An assertion that only fires while
the vault is idle proves nothing in the cases where the guard never opens, so the harness counts the
checks made *with a real shareholder present* and asserts that count is not zero. Measured at 418 of
1 029 idle checks across the suite.

That line was missing until 2026-08-23, and I9 was the only invariant here without one. The runner
existed the whole time, which is exactly why a reader could not tell.

## I10: Closing a round is a function of history

**What it says.** Once a round is past expiry, **at most one** terminal outcome is ever reachable,
and which one it is does not depend on who calls `close_round()` or when.

**Why.** This is the property that makes the protocol worth using without trusting anyone. The price
is read as it stood *at expiry*, so calling early or late cannot change it; the outcome is selected
by what that read returns, so no caller can name it. The three answers partition cleanly — the feed
answered (settle), the feed was demonstrably dead at expiry and we can still see that it was (void),
or expiry has left the feed's reachable history (unresolved) — and the rule for the third is chosen
so that **no party who can cause a delay gains by one.**

Without that last clause the invariant would still hold formally while paying an out-of-the-money
buyer their whole premium back for doing nothing.

**Two states are deliberately non-terminating, and both are bounded in time rather than merely
expected to clear:** a transient failure (the adapter trapped this ledger, which says nothing about
expiry) and the grace period before a dead feed may annul a round. Both revert and may be retried by
anyone. The grace period ends at `expiry + oracle_dead_after`. A transient failure that never clears
ends at `expiry + unresolved_after`, where the round finalizes unresolved **without calling the price
adapter at all** — a bound validated on-chain to sit strictly beyond the feed's reachable history, so
it returns the outcome a working adapter could only have returned anyway and adds no fourth reachable
result.

That last clause is load-bearing and was missing until it was audited in. If a permanently
unreachable adapter could block every branch, `close_round()` would revert forever and the round's
collateral would stay `Active` — the exact state this protocol claims is unreachable. **A terminal
path that touches no external contract is what makes the claim structural.**

**One stated precondition.** `unresolved_after` is fixed when the round opens; the feed's reachable
depth is read live when it closes. If the feed lengthens its tick mid-round — past
`(unresolved_after + guard_window) ÷ 255`, which is about 311 seconds against the 300 the feed runs
today — the fallback can fire while the anchored read would still have answered, which costs an
in-the-money buyer their payout. Opening a round re-checks the live feed, so the
exposure is one round rather than open-ended, and the residual is stated rather than argued away.

**Verified by.** A property test sweeping every read outcome against every elapsed time, asserting
one reachable outcome per cell and the declared gaps as the only gaps; plus an economic property test
asserting a bidder's total recovery under the unresolved path is never greater than under a normal
settlement.

**If it breaks.** The outcome becomes negotiable by whoever transacts first, which is the thing this
protocol exists to avoid.

---

## Rounding discipline

Not an invariant, but the rule that makes I1 and I9 hold: **every division floors, always in the
vault's favour.** The table is on
[How a round is settled](../mechanism/settlement.md#rounding). Consequence: rounding can only ever
make the contract *more* solvent. A few stroops of unclaimable dust accumulate per round; this is
measured and bounded by the conservation test, and deliberately not swept, because code to move dust
is code that can move funds.

## What is *not* an invariant

Stated explicitly, because their absence is a design choice rather than an oversight.

- **There is no guarantee that a round earns a premium.** An auction with no bidder lapses: premium
  zero, collateral untouched, share price unchanged. Costing depositors nothing is the guarantee;
  earning them something is not.
- **There is no guarantee that settlement happens on time.** If the feed cannot be read, closing
  reverts and may be retried by anyone — but not indefinitely: the wait is bounded by I10's deadline.
  **Late is a defined state; wrong is not.**
- **There is no guarantee that a round settles at all.** A round can be annulled, or finalize
  unresolved. Nobody who can cause an oracle failure or a delay profits from one, and nobody is
  trapped by one. The passive depositor-side asymmetry — more stays in the pool if an in-the-money
  round is never closed in time — is real and reachable by nobody's decision.
- **There is no guarantee that every round has a positive share price.** See I6: where a positive
  price and solvency cannot both hold, solvency wins.
- **There is no guarantee about returns.** There is no yield figure anywhere on this site.
