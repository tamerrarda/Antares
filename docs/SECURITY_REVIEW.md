# Internal security review

`plan/07-SECURITY.md` §5 asks for three things at this stage: one full pass of the codebase against
its §3 vulnerability table by someone who did not write the module, the Veridise Soroban checklist,
and a STRIDE walk of the §1 threat table. This file is the record of that pass — **what was checked,
how, and what the check was worth**.

Findings are not duplicated here. Every one of them is in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) with
an id and a status, which is where §5 says they go. What this file adds is the other half, the half
a findings list cannot carry: **the things that were examined and were fine**, and the method that
makes "fine" mean something. A review that publishes only its findings is indistinguishable from a
review that stopped early.

## What this is not

It is not an external audit. The README puts that at the pre-mainnet gate and names the path of
record (Soroban Audit Bank). It is not a proof of anything: where a control rests on human reading
rather than on a runner, this file says so, because that distinction is the only thing that makes
the rest of it worth reading.

## Method

The pass was made against the tree at the time of writing, reading the contract's own source rather
than the documents that describe it — the documents were then checked against what the source does,
which is how two of the findings below were raised against `plan/` rather than against the code.

Three habits, stated because they change what the results mean:

- **Claims were re-derived, not inherited.** Counts in this file were taken from the compiled wasm's
  export section or from a script over the source, not from an earlier note. One of them changed as
  a result: the permissionless surface is 15 entry points, not the 16 an earlier count recorded —
  a script matched a private `storage::set_allowed` helper instead of the `admin::set_allowed` entry
  point, which does require the admin's authorization.
- **Every new test was watched failing.** For each assertion added during the review, the
  implementation was broken deliberately and the test re-run to confirm it went red for the intended
  reason. An assertion never seen failing is an assertion whose subject is unknown.
- **Measurements, where a measurement was available.** O-7's cause was settled by downloading CI's
  own build artefact and comparing it section by section against the local one, not by reasoning
  about what compilers do.

## 1. The entry-point surface

Counted from the wasm's export section: **42 entry points**, of which one is `__constructor`.

| | count | |
|---|---|---|
| Require authorization | 27 | admin setters, `upgrade`/`migrate`, every user-funds path, SEP-41 transfers |
| Permissionless | 15 | 12 read-only views, plus `open_epoch`, `close_round`, `restore_position` |

The three permissionless state-changing entry points are deliberate and each is documented where it
matters rather than only here:

- **`open_epoch`** — so a round does not depend on a keeper being alive. Guarded by `min_idle_gap`,
  by the live oracle ladder, and by `min_fill`.
- **`close_round`** — `TRUST_MODEL.md` §2 states plainly that it is callable by anyone; a settlement
  that only the operator can trigger is an operator who can withhold one.
- **`restore_position`** — D-09. A helper must be able to maintain a dormant user's position without
  holding anything of theirs; `integration/scenario6.ts` proves it by having a stranger refresh
  another account's entry.

There is **no `initialize` function at all**, so the reinitialization class has no surface rather
than a guarded one.

## 2. `plan/07-SECURITY.md` §3 — the vulnerability classes

| Class | What was checked | Verdict |
|---|---|---|
| Missing auth | All 42 entry points classified from source; the one ambiguous name resolved to the authorized definition | Pass |
| Reinitialization | No `initialize`; one `__constructor`, which validates before writing and writes `Config` and `State` unconditionally and adjacently | Pass |
| Arbitrary contract calls | 7 outbound client constructions — 5 to `config.oracle`, 2 to `config.asset` — every one carrying an `// outbound:` marker naming which of the two immutable addresses it targets; a CI rule fails on a site without one | Pass, enforced |
| Integer overflow | `overflow-checks` set in all four cargo profiles; `arithmetic_side_effects` denied; the settlement math is checked at every step even where a bound is proven | Pass |
| Storage key collision | One typed `DataKey` enum, no raw symbols | Pass |
| Check-then-act races | Soroban is synchronous with no callbacks; checks and effects are in one invocation | Pass by platform |
| TTL / archival | Nothing value-bearing is `temporary()` — the storage module states the rule and no call site uses it; `bump_if_present` on the restore path so an exited user cannot end a sweep | Pass |
| Cross-contract return trust | Every oracle read passes the guard ladder; all 5 call sites use the recoverable `try_` form and none uses the trapping one, now enforced by a CI rule that did not exist | Pass, gap closed |
| Unbounded iteration | **One** loop in the whole production tree, over a nine-element array literal in `validate_params`; no `Vec` or `Map` anywhere in the vault's non-test code; settle and void are O(1) with pull-based claims | Pass |
| Self-reentrancy | 10 of 10 token transfers occur after the state commit. Nine write state on the line before; the tenth is inside a `pay_bounty` helper, and both of its call sites commit and bump before calling it | Pass |

## 3. STRIDE walk of the §1 threat table

**Admin.** The real money path is `set_fee_bps` + `set_fee_recipient` + `claim_fee`, and it is
bounded rather than absent: capped at 2 000 bps *of premium*, snapshotted into
`state.fee_bps_snapshot` at `open_epoch` so a raise cannot reach premium already collected, shipped
at zero, and every change emits an event. `TRUST_MODEL.md` already described this correctly; the
overstated row was in `plan/`, and was corrected there.

**Depositor.** No dilution path. `total_assets` returns `state.locked_assets` and the vault **never
reads its own token balance** — zero call sites — so the ERC-4626 inflation attack has no input to
manipulate. `DEAD_SHARES` (1 000, charged to the first deposit) additionally floors supply, and
`min_deposit > DEAD_SHARES` is asserted at construction rather than assumed from the default. The
same property has a cost, recorded as **A-13**: tokens sent straight to the contract are
unrecoverable.

**Griefer.** `min_fill` with a sliver exception that cannot be weaponized — creating a sub-`min_fill`
remainder requires first placing a real fill and paying real premium, and the sliver left behind is
fillable by anyone. `ZeroPremium` refuses a fill that costs nothing, which is reachable rather than
theoretical: a one-stroop sliver at the floor rounds to zero. Per-user state is O(1) and claims are
pull-based, so no participant can make another's exit expensive.

**MEV / transaction ordering.** The auction curve is a pure function of `(state, now)` — two bids in
the same ledger pay the same rate, so ordering decides who gets notional and never at what price. A
bid placed once the spot has passed the strike is refused by a live `spot_check` read at the round's
own decimal scale; an unreachable feed classifies as `OracleUnreachable` and **never** as
`InTheMoney`, because the keeper's stop gate counts only genuine no-bid epochs. The remaining
surface is opening a round at a manipulated spot to obtain a cheap strike: bounded by the 900 s
TWAP, by the deviation check against the 3 600 s guard window, and by `min_idle_gap` limiting
retries.

**Oracle failure and compromise.** Both halves of the guard ladder were read line by line. The
anchored branch distinguishes a feed that had nothing usable (a void) from one we simply looked at
too late, and refuses a decimals change as transient — because a *small* scale change floors nothing
and produces a price wrong by exactly 10×, which the coarse bound would admit. Step 5's base,
`last_settled_spot`, has exactly one writer in production, in the settled branch only, so the bound
is never re-based on a price nobody read.

Compromise is bounded structurally rather than by a clamp. Settlement pays
`notional_sold × (spot − strike) / spot`, floored; the fraction is below 1 for every positive
strike, so the payout is strictly below `notional_sold` even as `spot → ∞`. That is invariant I3,
and it is exactly the bound `TRUST_MODEL.md` §4 discloses.

## 4. The Veridise Soroban checklist

| Item | Antares |
|---|---|
| Define the trust assumptions clearly | `TRUST_MODEL.md` names each trusted actor with its bound and its recovery path |
| Allocate time to fix findings before deployment | §5's gate: unresolved criticals block the audit-ready tag |
| Address surface-level bugs internally first | This review, plus the per-run CI gates |
| Caution accepting `Vec<T>` / `Map<K,V>` as inputs | **Zero occurrences** of either in the vault's production code — the round-trip hazard has no surface, not a guarded one |
| Prefer `panic_with_error!` to bare `panic!` for fuzzability | No bare `panic!` and no `.unwrap()` in production. Eleven `.expect()` calls remain, all loading `Config`/`State` with the same message; their precondition was verified rather than assumed — the constructor writes both unconditionally, and every `remove` in the codebase targets persistent per-user keys, never the instance entries |
| `contractimport!` can deploy against a stale dependency | **Not used.** The oracle interface is a `#[contractclient]` trait in a shared crate, so a mismatch is a compile error rather than a runtime surprise |
| Unbounded data in instance storage | Instance storage holds `Config`, `State` and `AppVersion` only, all fixed-size; everything per-user is persistent and individually keyed |

## 5. What this review changed

- **A CI rule that did not exist.** All five oracle call sites already used the recoverable `try_`
  form; nothing was checking that the sixth would. `scripts/ci/static_rules.py` now refuses any
  price-source call in the vault's non-test code that is not spelled `try_`.
- **O-7 measured and its interim applied.** The host that builds a wasm is now recorded beside the
  version pins, in both records that carry a build hash, from one definition — and
  `bindings.wasm_recorded` compares hashes on a matching host and states the mismatch on a foreign
  one instead of failing on every CI run.
- **Two corrections to `plan/`**, where the document and the code disagreed and the code was right.
- **A-13 disclosed.**

## 6. What is still open at the close of this review

- **Scout analyses nothing** (O-6), and `plan/07-SECURITY.md` §4 makes OpenZeppelin's Soroban
  scanner non-optional *at this review* if the upstream fix has not landed. It has not. This is a
  decision that belongs to the roadmap, not to this file, and it is recorded here so it is not
  carried silently.
- **O-7's real remedy** — a pinned container so the host stops being an input to the build hash —
  has not been done. The interim makes a mismatch diagnosable; it does not make the build
  host-independent.
- **The long fuzz run** (Phase 4's remaining gate item) and the `vault.rs` mutation run are separate
  gates and are not evidence supplied by this review.
