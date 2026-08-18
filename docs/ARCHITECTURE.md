# Antares — Architecture

> Part of the [documentation set](README.md). This document is the system design. The properties it must uphold live in [INVARIANTS.md](INVARIANTS.md); who holds which powers lives in [TRUST_MODEL.md](TRUST_MODEL.md). Each fact has one home — the others link to it rather than restating it.

**Design principle:** every decision in this document is the decision we would make if this contract held real value tomorrow. Testnet is a network parameter. Nothing here is a shortcut to be replaced later; the gap between this design and a mainnet deployment is an audit and a proven counterparty, not a rewrite.
---

## 1. Standards alignment

| Question | Decision | Reasoning |
|---|---|---|
| Share token interface | **SEP-41 (token interface), implemented inside the vault contract** | Wallets, explorers and DEXes can read the share token like any other Soroban token. A separate token contract would add a cross-contract hop on every mint/burn for no benefit. |
| Vault standard (SEP-56 / ERC-4626-style, incl. OpenZeppelin's Soroban vault extension) | **Follow where it does not conflict; do not inherit the accounting** | 4626-style vaults assume deposit and redeem are continuous and instant. A covered-call vault locks collateral for the duration of an epoch — capital arriving mid-epoch cannot be allowed to dilute the premium earned by capital that was actually at risk. This is the same reason Ribbon built custom round-based accounting rather than using 4626 directly. We expose 4626-shaped views (`total_assets`, `convert_to_shares`) for tooling, but issuance is epoch-gated. |

**Consequence:** the epoch ledger in §4 is written by us and is the highest-risk component in the codebase. It gets the deepest test coverage (§11).

---

## 2. Contract surface

Single contract. Module boundaries live in the code — `vault`, `token`, `epoch`, `auction`, `settle`, `oracle`, `claims`, `admin` — not at addresses. (The split is an implementation detail and may change; what does not change is that it costs no cross-contract hop.)

### Lifecycle

```rust
fn __constructor(env: Env, admin: Address, asset: Address, oracle: Address, fee_recipient: Address,
                 params: EpochParams, token_suffix: String, deposit_cap: i128,
                 rent_threshold: u32, rent_extend_to: u32, allowlist_expires_at: u64);
// fee_bps (0), paused (false) and allowlist_enabled (true) are genesis constants, not arguments:
// a non-zero fee then requires a separate, publicly visible transaction rather than our word.
// allowlist_expires_at has no setter and is capped at 30 days from construction: the vault opens
// to everyone on a published timestamp, whether or not anyone remembers to open it.

fn open_epoch(env: Env) -> bool;         // permissionless; false = nothing to open yet (any pending finalization still persists)
fn bid(env: Env, bidder: Address, notional: i128, max_premium_bps: u32) -> i128;  // permissionless
fn close_round(env: Env, bounty_to: Address) -> RoundOutcome;  // permissionless; the single terminal entry point
```

**There is one way to close a round, and the caller does not choose the outcome.** `close_round`
reads the price feed as it stood at expiry, once, and dispatches: the round **settles** if the feed
answered, **voids** if the feed was demonstrably dead at expiry (past a grace period), and
finalizes as **unresolved** if nobody closed it before that history left the feed's reach — or if
the price adapter was unreachable throughout, which past a validated bound resolves the round with
no oracle call at all (§7).
Three separate entry points would let the caller name the result and would leave the exclusion
between them as something a test hopes for; one dispatcher makes it structural.

### Depositor

```rust
fn deposit(env: Env, from: Address, amount: i128) -> i128;    // shares minted; 0 for a pending deposit
fn cancel_pending_deposit(env: Env, from: Address) -> i128;   // only funds never locked
fn redeem_shares(env: Env, from: Address) -> i128;            // pending deposit -> shares; Idle only (§4)
fn request_withdraw(env: Env, from: Address, shares: i128, require_idle: bool) -> i128;  // XLM paid now, or 0 if queued
fn claim_withdraw(env: Env, from: Address) -> i128;
fn restore_position(env: Env, user: Address);                 // archival recovery; callable by anyone
```

### Bidder (pull-based — closing a round never iterates bidders)

```rust
fn claim_payout(env: Env, round: u32, bidder: Address) -> i128;  // after a Settled round, spot > strike
fn claim_refund(env: Env, round: u32, bidder: Address) -> i128;  // after a Voided round
fn claim_fee(env: Env) -> i128;                                  // fee_recipient pulls accrued fee
```

### Admin

```rust
fn set_paused(env: Env, paused: bool);
fn set_deposit_cap(env: Env, cap: i128);
fn set_fee_bps(env: Env, bps: u32);          // genesis value is 0; any change is a visible transaction
// There is no set_oracle and no set_asset. Repointing the price feed is not a setter at all —
// it requires a reviewed upgrade (§8, TRUST_MODEL §2).
fn set_epoch_params(env: Env, params: EpochParams);   // takes effect next epoch only
fn set_allowlist_enabled(env: Env, enabled: bool);   // can open bidding early; cannot extend the gate
// The allowlist also expires at Config.allowlist_expires_at, fixed at construction with no setter:
// past it, bid() ignores the allowlist and re-enabling the flag is a no-op.
fn set_allowed(env: Env, bidder: Address, allowed: bool);
fn set_fee_recipient(env: Env, recipient: Address);
fn set_rent_params(env: Env, threshold: u32, extend_to: u32);  // TTL policy in ledgers — tunable because ledger close time is not constant
fn transfer_admin(env: Env, new_admin: Address);      // two-step handover:
fn accept_admin(env: Env);                            // a typo'd address cannot brick the admin role
fn upgrade(env: Env, new_wasm_hash: BytesN<32>);      // upgradeable v1 — see §8
fn migrate(env: Env, to_version: u32);                // monotonic, idempotent
```

Admin can never: move user funds, mint shares, change a settled epoch, or settle at a chosen price. The only emergency lever is **pause**, and pause blocks new deposits, new bids and new epochs — it never blocks the exit path (see [INVARIANTS.md](INVARIANTS.md) I8 for the exact set). A paused contract must still be able to unwind.

### Views + SEP-41

```rust
fn epoch(env: Env) -> EpochInfo;
fn position(env: Env, user: Address) -> Position;
fn price_per_share(env: Env, round: u32) -> i128;
fn total_assets(env: Env) -> i128;
fn convert_to_shares(env: Env, assets: i128) -> i128;

fn config(env: Env) -> ConfigView;
fn bidder_position(env: Env, round: u32, bidder: Address) -> BidderPosition;

// SEP-41: balance, transfer, transfer_from, approve, allowance, burn, burn_from, decimals, name, symbol
```

---

## 3. Storage model

Amounts are `i128` in stroops (7 decimals). Ratios are basis points (`u32`, 10 000 = 100 %). `PRECISION = 1e7` for price-per-share.

| Type | Key | Value | TTL policy |
|---|---|---|---|
| **instance** | `Config` | admin, pending_admin, asset, oracle, fee_recipient, **token_suffix**, fee_bps, deposit_cap, paused, allowlist_enabled, **allowlist_expires_at**, params, rent params | bumped on every write |
| **instance** | `State` | round, phase, strike, expiry, notional_offered, notional_sold, premium_collected, locked_assets | bumped on every write |
| **instance** | `AppVersion` | `u32` — migration schema version (§8) | bumped on every write |
| **persistent** | `Shares(Address)` | `i128` | bumped on touch |
| **persistent** | `Allowance(Address, Address)` | SEP-41 allowance `(owner, spender)` with `live_until_ledger` | bumped on touch |
| **persistent** | `PendingDeposit(Address)` | `{ round: u32, amount: i128 }` | bumped on touch |
| **persistent** | `PendingWithdraw(Address)` | `{ round: u32, shares: i128 }` | bumped on touch; **also bumps `Round(round)`** |
| **persistent** | `Round(u32)` | `{ outcome, pps, strike, expiry, notional_sold, premium, fee, settled_spot, payout_total }` | bumped while any pending withdrawal or fill references it |
| **persistent** | `Fill(u32, Address)` | `{ notional, premium_paid, claimed }` — per (round, bidder); basis for pull-based `claim_payout`/`claim_refund` | bumped on touch; **also bumps `Round(round)`** |
| **persistent** | `Allowed(Address)` | `bool` | bumped on touch |
| **temporary** | — | **nothing** | no value-bearing state is temporary, ever |

**Archival:** a `Round` record may only be allowed to expire once no `PendingWithdraw` references it. A public `restore_position(user)` path is documented so a returning depositor with an archived entry has a deterministic recovery route rather than a support ticket.

---

## 4. Epoch lifecycle and share accounting

This diagram is canonical — every other description of the lifecycle in this repository defers to it.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Idle

    Idle --> Auction: open_epoch() · permissionless<br/>requires min_idle_gap elapsed
    Auction --> Active: fills present at auction_end<br/>(or sold out early)
    Auction --> Lapsed: auction_end, nothing sold
    Active --> Settled: close_round()<br/>the feed answered for expiry
    Active --> Voided: close_round()<br/>feed was demonstrably dead at expiry<br/>and the grace period has passed
    Active --> Unresolved: close_round()<br/>nobody closed it while<br/>expiry was still readable

    Settled --> Idle
    Lapsed --> Idle
    Voided --> Idle
    Unresolved --> Idle
```

Four terminal outcomes, one shared exit: all of them finalize through the same internal path, so the withdrawal-queue accounting cannot diverge between them.

| Outcome | Reached when | Premium | Payout | `pps` | Collateral |
|---|---|---|---|---|---|
| **Settled** | expiry reached, oracle usable | kept by depositors | to bidders if `spot > strike` | recomputed | reduced by payout + fee |
| **Lapsed** | auction closed with no fills | none earned | none | unchanged | untouched |
| **Voided** | feed demonstrably dead **at expiry**, past `expiry + oracle_dead_after`, and still readable | refunded to bidders | none | unchanged | untouched |
| **Unresolved** | nobody closed the round before expiry left the feed's reachable history | **kept by depositors** | none | recomputed | reduced by fee + bounty |

**Why `Unresolved` keeps the premium rather than refunding it.** A refund is what an unbounded
version of the void path would do, and it pays the buyer to wait: out of the money, letting the
clock run out returns 100 % of his premium, and no bounty funded from that premium can outbid it.
Retaining it makes waiting worth exactly nothing to an out-of-the-money buyer and strictly negative
to an in-the-money one, who forfeits the payout as well. **No party who can cause a delay gains by one** — depositors would passively
benefit if an in-the-money round drifted past the deadline, but drift is nobody's action to take:
closing is permissionless and the buyer it would rob holds the payout-sized incentive to prevent
it ([KNOWN_ISSUES](KNOWN_ISSUES.md) A-10). That is the property that makes the outcome a function
of history rather than of who transacted when. The cost
is stated in [BIDDER.md](BIDDER.md): a buyer facing a genuinely dead feed has a bounded window to
annul the round himself, and the call is permissionless.

`LAPSED`, `VOIDED` and `UNRESOLVED` are **normal terminal states, not errors.** An auction that clears empty is a data point about demand; an annulled round is what a dead oracle costs, which is nothing to depositors and nothing to bidders. Both are recorded, both emit events, and the next epoch may open immediately after either.

### Why deposits are epoch-gated

Capital that arrives while an option is live took none of that option's risk. If it minted shares immediately it would claim a share of a premium it did not earn, and dilute the depositors who did. So:

- **Deposit during round R** → `PendingDeposit { round: R, amount }`. The XLM is held by the contract but is **not** part of `locked_assets`, and the vault may not write calls against it.
- **After round R settles** → the pending deposit converts to shares **at the current price when it converts**, not at a price frozen when it was deposited. Capital that sat pending took none of the intervening rounds' risk, so it enters at today's price; this also makes converting and cancel-then-redeposit worth exactly the same, which is why cancellation stays open for a pending deposit's whole life.
- **Deposit while no round is live (`IDLE`)** → mints instantly at the last settled `pps` (auto-redeeming any older finalized pending first). No option is live, so instant minting dilutes nobody.
- **`cancel_pending_deposit`** returns funds that were never locked. This is the only instant exit and it is safe precisely because that capital never backed an option.

**Share mints happen only while the phase is `IDLE`.** A share minted mid-round at an old `pps` would acquire a claim on the live round's P&L that its capital never backed — if `pps` rises, total claims exceed the pool and solvency (I1) breaks. Burns (`request_withdraw`) are safe in any phase: burned shares stay in the round's `pps` denominator snapshot, so the exiting holder gets exactly this round's price. To guarantee a usable mint/redeem window every cycle, `open_epoch` requires `now ≥ last_finalize_time + min_idle_gap` (an `EpochParams` field).

### Withdrawals

- **`request_withdraw(shares)` during round R** → shares are burned, `PendingWithdraw { round: R, shares }` is recorded.
- **After round R settles** → `claimable = shares × pps[R] / PRECISION`.
- **`request_withdraw` while no round is live** (phase `IDLE`) → converts at the last settled `pps` and is claimable immediately. No option is live, so nothing is at risk and there is nothing to wait for.
- **`claim_withdraw`** transfers. There is no path that pays out a round that has not been finalized.

### Settlement accounting

At close, for a round R that settled:

```
fee_R      = premium_R × fee_bps_snapshot / 10_000     (rate snapshotted at open, not read at close)
bounty_R   = premium_R × params.settle_bounty_bps / 10_000   (paid to whoever closed the round)
assets_R   = locked_at_open + premium_R − payout_R − fee_R − bounty_R
pps[R]     = assets_R × PRECISION / shares_snapshot          (supply at open)
```

`shares_outstanding_R` is the share supply **at the start of round R** — pending deposits from round R are not in it, and shares burned by `request_withdraw` during round R are. Both are deliberate: the first has not earned yet, the second is exiting at this round's price.

---

## 5. Dutch auction

The premium is discovered, not assumed. A descending-price auction is the only mechanism that prices an option on Stellar today without a volatility oracle — and Stellar has no reliable volatility feed.

**On `open_epoch()`:**

```
spot           = oracle_guarded_reading()   // short TWAP; §7 guards: staleness, self-consistency, sanity
strike         = spot × (10_000 + strike_bps_otm) / 10_000
expiry         = now + params.duration
notional_offer = locked_assets
auction_end    = now + params.auction_duration
```

**Price path** — linear decay in basis points of notional:

```
premium_bps(t) = start_bps − (start_bps − floor_bps) × (t − t0) / auction_duration
```

**On `bid(bidder, notional, max_premium_bps)`:**

1. Reject if paused (checked first — one canonical guard order, spec §16), if `phase != AUCTION`, or if past `auction_end`.
2. Reject if the bidder is not allowed **and** `allowlist_enabled` **and** `now < allowlist_expires_at`. *(Launch control only, and one that runs out: the expiry is fixed at construction and has no setter, so the vault opens on a published timestamp whether or not anyone remembers to open it.)*
3. Compute `p = premium_bps(now)`. Reject if `p > max_premium_bps` — this is the bidder's slippage guard and it is not optional.
3b. **ITM guard:** reject if the freshest oracle tick shows `spot ≥ strike`, or if that check is unavailable. The strike is fixed while the curve descends; once the option is at/in the money, any fill sells intrinsic value for at most the curve premium — refusing is strictly better, and an empty auction costs depositors nothing.
4. `filled = min(notional, notional_offer − notional_sold)`. **Partial fills are the expected case**, not an exception: in a thin market, all-or-nothing means no fills at all. Compute `premium = filled × p / 10_000` and reject any fill whose premium rounds to zero — a free option, refused.
5. Record the fill against the bidder (needed for the §7 refund path). Increment `notional_sold`, add `premium` to `premium_collected` — state first, on every path.
6. If `notional_sold == notional_offer`, transition to `ACTIVE` early — still a state write, so still before the transfer.
7. Transfer `premium` in XLM from the bidder to the vault (checks → effects → interactions; the list reads in execution order instead of footnoting that it doesn't).

**At `auction_end`:** `notional_sold > 0` → `ACTIVE`. `notional_sold == 0` → `LAPSED`.

Unsold notional stays in the vault, unencumbered, earning nothing that epoch. It is not re-offered mid-epoch — a second offer at a different strike inside one epoch would make the position path-dependent and the accounting far harder to reason about.

**Premium is recognised at fill, never at offer.** Multiple fills at different points on the decay curve produce different premiums, and the ledger must reflect that. Building the accounting around "the premium is known when the epoch opens" is the single easiest way to make this contract unfixable later.

---

## 6. Settlement math

Cash-settled, paid in XLM out of the vault's own collateral.

```
if spot ≤ strike:   payout = 0
else:               payout = notional_sold × (spot − strike) / spot
```

Two properties make this safe by construction:

- **`payout < notional_sold` for all `spot`.** As `spot → ∞`, `(spot − strike)/spot → 1`, so the payout approaches but never reaches the sold notional. The vault can never owe more than the collateral backing the position — no margin call, no bad debt, no liquidation engine.
- **No second leg.** The bidder paid the premium up front and has no further obligation. There is no atomic swap, no delivery failure, no counterparty credit risk, and a bidder never needs to hold `strike × notional` in capital. That last point is the reason the capital barrier to *being* a counterparty is roughly **136× lower** here than under physical settlement at the option's fair value — and never less than ~18× lower anywhere on any of the five vaults' auction curves — which matters more than anything else in a market this thin.

Payout is distributed to bidders pro-rata to their filled notional — **pull-based**, via `claim_payout(round)` computed from each bidder's own `Fill` record. `close_round()` is O(1) on every branch and never iterates bidders: a per-bidder loop would make the exit path's cost grow with participation, which is a denial-of-service surface. Depositors absorb the payout and receive the premium, both pro-rata to shares, through `pps[R]`.

---

## 7. Oracle safety envelope

Settlement correctness rests entirely on the price feed, so every failure mode gets a defined behaviour and **none of them trap funds.**

```mermaid
flowchart TD
    A["close_round() called<br/>at/after expiry"] --> T{"past expiry +<br/>unresolved_after?"}
    T -- yes --> J["UNRESOLVED<br/>premium kept by depositors · payout 0"]
    T -- no --> B{"read the feed<br/>as it stood AT EXPIRY"}
    B -- "answered" --> F["SETTLED<br/>at the median short TWAP"]
    B -- "records exist but are<br/>unusable or nonsense" --> G{"past expiry +<br/>oracle_dead_after?"}
    B -- "adapter trapped / budget<br/>(a fact about NOW)" --> H["revert · OracleUnreachable<br/>anyone retries · nothing lost"]
    B -- "expiry older than the feed's<br/>reachable history" --> J
    G -- no --> K["revert · OracleNotDeadYet<br/>the grace period · anyone retries"]
    G -- yes --> I["VOIDED<br/>premiums refunded · pps unchanged"]
```

The classification is the point: **a fact about the expiry window** (the feed was dead then) may
annul a round, and **a fact about now** (the adapter trapped this ledger) may not. Conflating them
would let one congested ledger annul a round that was perfectly settleable. Every branch is
permissionless, and the two reverting cases both clear with time.

**The self-consistency breaker runs at `open_epoch` only.** At close the window is frozen history,
so a rejected read can never "clear" on retry — a breaker there could only ever convert a
settleable round into an annulled one, confiscating a payout the buyer earned. Closing instead
takes the **median** of several samples in each window, which absorbs a bad print without needing a
retry.

Retry on a transient failure, annul only on evidence, and never invent a price — **every step is permissionless.** The contract never invents a price: no fallback settles on a fabricated or clamped value, because a wrong settlement is strictly worse than a refunded one.

| Condition | Behaviour |
|---|---|
| Normal | TWAP over `twap_window`, not a spot tick. A single-block price never decides a settlement. |
| Feed older than `max_staleness` **when opening an epoch** | `open_epoch()` reverts and may be retried by anyone. Staleness relative to *now* is meaningless for a frozen window, so it is not checked at close. |
| Short TWAP diverges from a longer guard TWAP of the same moment by more than `max_deviation_bps` | `open_epoch()` reverts. A circuit breaker, not a silent clamp. Comparing two windows of the same moment means it fires on feed artifacts and **never on sustained real market moves**. It does not run at close — see above. |
| Adapter traps, panics or exhausts its budget | `close_round()` reverts and anyone may retry. This is explicitly **not** grounds to annul: it says nothing about the expiry window. |
| …and it never recovers | **The round still ends.** Past `expiry + unresolved_after` (21 h at the shipped parameters) `close_round()` finalizes the epoch as **unresolved without calling the price adapter at all**. The bound is validated on-chain to sit strictly beyond the feed's reachable history, and bounded above so no admin setting can push it out of reach, so this returns the same outcome a working adapter could have produced at that instant — it adds no new result and cannot be used to steer one. It is the only terminal path that survives an adapter which cannot be invoked, and it is what makes "no oracle state can trap funds" a property of the code rather than a claim about it. |
| Feed demonstrably unusable **at expiry**, past `oracle_dead_after` | **Epoch is voided — by anyone.** A dead oracle plus a dead keeper must still never trap funds. Premium is refunded to each bidder exactly — every fill's own `premium_paid` back, with no
pro-rata arithmetic and no rounding loss (unlike the payout above, which *is* pro-rata) — payout is zero, `pps` is unchanged, a loud event is emitted. |
| Nobody closed the round before expiry left the feed's reachable history | **Epoch is unresolved — by anyone.** Premium is kept by depositors, payout is zero, and whoever closed it is paid the bounty. The round is decided by a rule rather than by evidence, precisely because no evidence remains — and the rule is chosen so that nobody who could cause the delay profited by it — see §7's note and [KNOWN_ISSUES](KNOWN_ISSUES.md) A-10 for the passive asymmetry that survives. |

The void-and-refund choice is deliberate: an oracle failure is nobody's fault, and nobody who could cause one should profit from one — the refund does leave an out-of-the-money buyer better off than settling would have, but a feed's death is not an event any participant can bring about. Settling at strike would hand depositors a free premium; paying out on a stale price would hand bidders a lottery ticket. Refunding restores both sides to where they started.

`PriceSource` is an interface with a Reflector implementation and a mock. **Settlement reads the price as it was at expiry**, not at the moment someone calls — so every caller, early or late, computes the same settlement price and **no caller can move that price in their own favour by choosing when to call**. The claim is about the price and it is directional: calling *early* is deliberately rewarded (the closer takes the bounty, and a bidder facing a dead feed must annul inside the void window to recover his premium), while *delay* never pays anyone who could choose it. Letting the anchor age out past `reach_limit` changes the **branch** rather than the price, and the passive asymmetry that creates is disclosed in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) A-10 — nobody can bring it about. (One precondition, stated in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) A-12: the price feed must not change its own update interval while a round is live, because the sampling grid is derived from it.) The adapter takes several point samples across each window (`price(asset, timestamp)`, verified against the live contract — the batch call collapses well before the history it would need) and reduces each window to a **median**, which absorbs a single bad print without needing a retry. **Feed selection is part of the security model:** the pinned feed is Reflector's external CEX & DEX XLM/USD feed — deep aggregated off-chain markets — never any feed sourced from a thin on-chain order book. The February 2026 YieldBlox incident on Stellar was a correctly-functioning oracle reading a manipulable on-chain market; the class is excluded here by construction, and the oracle address is immutable after deployment (changing it requires a reviewed upgrade). Adding median-of-N or a secondary feed later (RedStone now ships SEP-40 feeds on Stellar) is a new implementation, never a refactor — that is the fallback *mechanism*; void-and-refund is the fallback *guarantee*.

---

## 8. Admin, pause, upgradeability

- **Admin** is a single address in this design, expected to be a multisig before any mainnet deployment. Its powers are enumerated in §2 and deliberately exclude anything that touches user funds.
- **Pause** blocks `deposit`, `bid` and `open_epoch`. It never blocks `close_round`, `request_withdraw`, `claim_withdraw`, `claim_payout`, `claim_refund`, `claim_fee`, `cancel_pending_deposit`, `redeem_shares` or `restore_position`. A paused vault therefore unwinds to cash on its own: the epoch in flight closes permissionlessly — settling, voiding or resolving as unresolved, whichever the price feed dictates — and every depositor can then exit at the resulting `pps`. Pause needs no timeout because it never holds funds hostage: the exit path is unpausable, and the live epoch reaches a terminal state within a bounded window past expiry whether or not anyone is paying attention.
- **Deposit cap** ships enforced. A first live vault launches capped; the parameter exists from day one so that turning it on is not a code change.
- **Fee** is 0 at genesis — and it is 0 because no transaction ever set it, not because a deploy argument happened to be zero, so the claim is checkable on-chain. The parameter and its place in the settlement formula exist from day one — retrofitting a fee into share math changes `pps` for every historical round.
- **Upgradeability — resolved: upgradeable v1.** Admin-gated `upgrade(new_wasm_hash)` (SEP-49 style: `contractmeta` binary version, `AppVersion` in storage, monotonic idempotent `migrate()`). This is the protocol's one real trust concentration and it is disclosed as such: testnet runs a single documented admin address; **before mainnet the admin becomes a timelocked multisig whose delay exceeds `epoch_duration + unresolved_after`** (docs/TRUST_MODEL §3 derives both
terms), so users can always exit at the old code before new code takes effect. Operational policy: never upgrade while a round is live (scripts enforce Idle).

---

## 9. Invariants

**[INVARIANTS.md](INVARIANTS.md) is the canonical definition** — it states each invariant
precisely, explains what breaks without it, and names how it is verified. Summarized here only
so this document reads end to end:

| | In one line |
|---|---|
| **I1** | Solvency: the contract holds at least everything it has promised — collateral, pending deposits, claimable withdrawals, claimable bidder balances, accrued fee |
| **I2** | Nothing is sold that isn't backed: `notional_sold ≤ notional_offered ≤ locked_at_open` |
| **I3** | `payout < notional_sold` for every possible price — no margin calls, no bad debt |
| **I4** | Locked collateral cannot leave during a live round; pending deposits remain cancellable |
| **I5** | Share supply is exact: `Σ balances == shares_outstanding` |
| **I6** | Share price is never negative, and is zero only when the pool genuinely is worth less than one stroop per `PRECISION` share-units — where I6 and I1 cannot both hold, solvency wins and minting is refused |
| **I7** | Round records are immutable once written |
| **I8** | The exit path cannot be paused |
| **I9** | Instant withdrawals between rounds are always fully covered |
| **I10** | Closing a round is a function of history: at most one terminal outcome is ever reachable, and which one does not depend on who calls or when |

---

## 10. Events

Every state transition emits. The off-chain metric collector and the public dashboard read only events; no indexer needs to reconstruct state from storage.

```
deposited{user, round, amount, shares_minted, instant}
pending_redeemed{user, round, shares, pps}
withdraw_requested{user, round, shares}
withdraw_claimed{user, round, shares, amount}
payout_claimed{round, bidder, amount} · refund_claimed{round, bidder, amount}
fee_accrued{round, amount} · fee_claimed{recipient, amount} · settle_bounty{round, to, amount} · position_restored{user}
upgraded{wasm_hash, app_version} · migrated{version}

epoch_opened{round, strike, expiry, opened_at, auction_end, notional_offered, open_twap, premium_start_bps, premium_floor_bps}
bid_filled{round, bidder, notional, premium_bps, premium, notional_sold_after}
epoch_lapsed{round, notional_offered, pps, wclaims}
settled{round, spot, strike, notional_sold, payout_total, premium, fee, pps, wclaims}
epoch_voided{round, reason, premium_refunded, pps, wclaims}
epoch_unresolved{round, premium_retained, pps, wclaims}

paused{by} · unpaused{by} · params_changed{...} · admin_changed{old, new}
```

**All four finalization events carry `wclaims`** — every outcome credits the withdrawal queue, so
an indexer that only read it on `settled` would drift permanently the first time a round lapsed
with a queued exit. `upgraded` carries the wasm hash and the *schema* version, which `upgrade` does
not change: code and schema are versioned separately and only `migrate` moves the second.

`epoch_lapsed`, `epoch_voided` and `epoch_unresolved` are deliberately first-class. An auction that clears empty is a data point about demand, not a failure to hide.

**Rejected settlements emit nothing**, because in Soroban a reverting invocation discards its events along with its state — an event on a failing path is not implementable. A stale or deviating feed is observed through the error code that simulation returns, which is what the keeper alerts on. The full event ABI, including which fields are topics, is specified in the contract spec.

---

## 11. Test strategy

| Layer | Covers |
|---|---|
| **Unit** | Every state transition, including every rejected one. Each guard has a test that proves it rejects. |
| **Integration** | Full epochs against testnet: open → bid → settle, plus the lapse path and the void path. |
| **Property-based** | Settlement math and epoch accounting. For arbitrary `(spot, strike, notional, deposits, withdrawals)`: I1–I10 hold, `payout ∈ [0, notional_sold)`, and `pps ≥ 0` with every withdrawal claim from a `pps == 0` round still summing to no more than the pool. This is the highest-value suite in the repo because §4 is the highest-risk component. |
| **Fuzz** | Call-sequence fuzzing — deposit/withdraw/bid/settle in adversarial orderings, over-sell attempts, double-settle, settle-before-expiry, bid-after-close. Every ordering is repeated under `paused == true` to prove I8. |
| **Differential** | Settlement output compared against an independent reference implementation written in Python from the spec, not from the Rust. |

Every guard in §7 has a test that forces the condition — stale feeds and deviating prices are simulated through the mock `PriceSource`, not waited for.

---

## 12. Concurrent instances

The counterparty phase deploys **five instances of this same binary** side by side, identical in
every respect except their terms — how long the option runs and how far out of the money the strike
sits — each with its own share token (`aXLM-A` … `aXLM-E`, from a constructor argument) and its own
auction. One vault answering one set of terms cannot distinguish *"nobody wants to sell options on
XLM"* from *"nobody wants **these** terms"*; five run at once can, and testnet capital is free.
Everything in this document describes a single instance, because that is what each of them is.

Instance A is the mainnet-target configuration and is run at full size; the other four are probes
across duration and moneyness. Each must independently pass the deploy-time coherence check that
its own auction band actually contains the option's fair value at measured volatility — an
instance that cannot be filled tests nothing.

## 13. Open decisions — all resolved (the last, item 3's revised grounds, on 2026-08-18)

Every decision below was closed **before contract work started**.

1. **Upgradeability — resolved: upgradeable v1.** Admin-gated upgrade with versioned migrate; timelocked multisig before mainnet; trust statement in README and §8.
2. **Dead-oracle policy — resolved: void-and-refund** (§7), confirmed by external review. A feed that never recovers is handled by the unresolved path instead, which needs no oracle call at all.
3. **Auction decay curve — resolved: linear, on revised grounds.** The original reason ("exponential's marginal benefit does not justify harder verification") was falsified by measurement — a rational bidder only acts below fair value, and geometric decay roughly triples that live tail. Linear ships anyway because it is integer-exact for the byte-for-byte differential suite, and because the curve is an internal function replaceable without touching storage — which is also why geometric stands on record as the designated successor, promoted by bidder evidence before any mainnet parameter freeze (plan D-03).
4. **Strike selection — resolved: fixed % OTM parameter.** Volatility-adjusted selection requires a volatility source Stellar does not have; the parameter leaves the policy adjustable per epoch.
5. **Multisig threshold and signers — resolved as a mainnet gate.** Testnet runs a single documented admin; threshold and signer set are chosen at the mainnet gate, blocking nothing before it.
