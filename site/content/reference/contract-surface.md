---
title: Contract surface
deck: Forty-two exported functions, thirty-six events, and every error code — for integrators and reviewers.
---

# Contract surface

One contract. Module boundaries live in the code — `vault`, `token`, `epoch`, `auction`, `settle`,
`oracle`, `claims`, `admin` — not at addresses, so no path costs a cross-contract hop. The split is
an implementation detail and may change; what does not change is the cost.

`stellar contract info interface` on the deployed vault returns **42 functions**.

## Standards

| Question | Decision |
|---|---|
| Share token interface | **SEP-41**, implemented inside the vault contract. Wallets, explorers and DEXes read it like any other Soroban token, and a separate token contract would add a cross-contract hop on every mint and burn for no benefit |
| ERC-4626-style vault standards | **Followed where they do not conflict; the accounting is not inherited.** 4626-style vaults assume deposit and redeem are continuous and instant. A covered-call vault locks collateral for the duration of a round. 4626-shaped views (`total_assets`, `convert_to_shares`) are exposed for tooling; issuance is round-gated |

## Lifecycle

```rust
fn __constructor(env: Env, admin: Address, asset: Address, oracle: Address, fee_recipient: Address,
                 params: EpochParams, token_suffix: String, deposit_cap: i128,
                 rent_threshold: u32, rent_extend_to: u32, allowlist_expires_at: u64);

fn open_epoch(env: Env) -> bool;
fn bid(env: Env, bidder: Address, notional: i128, max_premium_bps: u32) -> i128;
fn close_round(env: Env, bounty_to: Address) -> RoundOutcome;
```

`fee_bps` (0), `paused` (false) and `allowlist_enabled` (true) are **genesis constants, not
arguments**: a non-zero fee then requires a separate, publicly visible transaction rather than our
word. `allowlist_expires_at` has no setter and is capped at 30 days from construction.

**Two senses of "permissionless", and they are not the same.** `open_epoch` and `close_round` take
**no authorization at all** — no signature from any particular party — which is what lets a depositor
close their own round when nobody else does. `bid` is open to anyone in the sense that no gatekeeper
decides who may be a bidder, but it is **signed by the bidder**, and until the allowlist expires it
can be narrowed further.

`open_epoch` returns `false` rather than reverting when it first finalized a lapsed round and then
hit a failed precondition — the finalization is kept.

## Depositor

```rust
fn deposit(env: Env, from: Address, amount: i128) -> i128;    // shares minted; 0 for a pending deposit
fn cancel_pending_deposit(env: Env, from: Address) -> i128;   // only funds never locked
fn redeem_shares(env: Env, from: Address) -> i128;            // pending deposit -> shares; Idle only
fn request_withdraw(env: Env, from: Address, shares: i128, require_idle: bool) -> i128;
fn claim_withdraw(env: Env, from: Address) -> i128;
fn restore_position(env: Env, user: Address);                 // archival recovery; callable by anyone
```

## Bidder: pull-based; closing a round never iterates bidders

```rust
fn claim_payout(env: Env, round: u32, bidder: Address) -> i128;  // after a Settled round, spot > strike
fn claim_refund(env: Env, round: u32, bidder: Address) -> i128;  // after a Voided round
fn claim_fee(env: Env) -> i128;                                  // fee_recipient pulls accrued fee
```

## Admin

```rust
fn set_paused(env: Env, paused: bool);
fn set_deposit_cap(env: Env, cap: i128);
fn set_fee_bps(env: Env, bps: u32);                   // genesis value 0; capped at 2 000
fn set_epoch_params(env: Env, params: EpochParams);   // takes effect next round only
fn set_allowlist_enabled(env: Env, enabled: bool);    // can open bidding early; cannot extend the gate
fn set_allowed(env: Env, bidder: Address, allowed: bool);
fn set_fee_recipient(env: Env, recipient: Address);
fn set_rent_params(env: Env, threshold: u32, extend_to: u32);
fn transfer_admin(env: Env, new_admin: Address);      // two-step handover:
fn accept_admin(env: Env);                            //   a typo'd address cannot brick the role
fn upgrade(env: Env, new_wasm_hash: BytesN<32>);
fn migrate(env: Env, to_version: u32);                // monotonic, idempotent
```

**There is no `set_oracle` and no `set_asset`.** Repointing the price feed is not a setter at all; it
requires a reviewed upgrade.

## Views and SEP-41

```rust
fn epoch(env: Env) -> EpochInfo;
fn position(env: Env, user: Address) -> Position;
fn config(env: Env) -> ConfigView;
fn bidder_position(env: Env, round: u32, bidder: Address) -> BidderPosition;
fn price_per_share(env: Env, round: u32) -> i128;
fn total_assets(env: Env) -> i128;
fn convert_to_shares(env: Env, assets: i128) -> i128;

// SEP-41
fn balance · transfer · transfer_from · approve · allowance · burn · burn_from · decimals · name · symbol
```

`EpochInfo` carries the derived fields an interface needs without a second round trip:
`current_premium_bps` (0 outside the auction window), `outcome_pending`, `next_open_at`,
`void_available_at`.

## Storage model

Amounts are `i128` in stroops (7 decimals). Ratios are basis points (`u32`, 10 000 = 100 %).
`PRECISION = 10 000 000` for price per share.

| Type | Key | Value | TTL |
|---|---|---|---|
| instance | `Config` | admin, pending_admin, asset, oracle, fee_recipient, token_suffix, fee_bps, deposit_cap, paused, allowlist_enabled, allowlist_expires_at, params, rent params | bumped on every write |
| instance | `State` | the round · its clock · its prices · what was sold · what it started from · running totals · the four claim pools | bumped on every write |
| instance | `AppVersion` | `u32` migration schema version | bumped on every write |
| persistent | `Shares(Address)` | `i128` | bumped on touch |
| persistent | `Allowance(Address, Address)` | SEP-41 allowance with `live_until_ledger` | bumped on touch |
| persistent | `PendingDeposit(Address)` | `{ round, amount }` | bumped on touch |
| persistent | `PendingWithdraw(Address)` | `{ round, shares }` | bumped on touch; **also bumps `Round(round)`** |
| persistent | `Round(u32)` | `{ outcome, pps, strike, expiry, notional_sold, premium, fee, settled_spot, payout_total }` | bumped while any pending withdrawal or fill references it |
| persistent | `Fill(u32, Address)` | `{ notional, premium_paid, claimed }` | bumped on touch; **also bumps `Round(round)`** |
| persistent | `Allowed(Address)` | `bool` | bumped on touch |
| **temporary** | — | **nothing** | no value-bearing state is temporary, ever |

`State` is one struct of twenty-five fields, and the last group is why it is worth reading in full:
[I1](../trust/invariants.md#i1-solvency) bounds the contract's balance below by `locked_assets` plus
four claim pools — **five terms, and every one of them is a field here.** The invariant is checkable
against storage rather than recomputable only by replaying events.

A `Round` record may only be allowed to expire once no `PendingWithdraw` references it.

## Enums

```rust
enum Phase        { Idle, Auction, Active }
enum RoundOutcome { Settled, Lapsed, Voided, Unresolved }
enum VoidReason   { FeedUnusable, InvalidPrice }
```

`VoidReason` has two variants and both are reachable. Ones that were not reachable were removed
rather than reserved, on the grounds that an unobservable variant is ABI an integrator must handle
and can never see.

## Events

**Thirty-six in all: the thirty-one below, plus the five the share token emits as a SEP-41 token —
`transfer`, `transfer_muxed`, `mint`, `burn`, `approve`.** Those follow the standard. There is no
`clawback`, because there is no clawback.

Every state transition emits. An off-chain collector or dashboard can read only events; no indexer
needs to reconstruct state from storage.

```
initialized{admin, asset, oracle, fee_recipient, token_suffix, deposit_cap,
            rent_threshold, rent_extend_to, allowlist_expires_at, params,
            fee_bps, paused, allowlist_enabled, app_version}

deposited{user, round, amount, shares_minted, instant}
deposit_cancelled{user, round, amount}
pending_redeemed{user, round, amount, shares, pps}
withdraw_requested{user, round, shares}
withdraw_claimed{user, round, shares, amount}
position_restored{user}

epoch_opened{round, strike, expiry, opened_at, auction_end,
             notional_offered, open_twap, premium_start_bps, premium_floor_bps}
bid_filled{round, bidder, notional, premium_bps, premium, notional_sold_after}
epoch_lapsed{round, notional_offered, pps, wclaims}
settled{round, spot, strike, notional_sold, payout_total, premium, fee, pps, wclaims}
epoch_voided{round, reason, premium_refunded, pps, wclaims}
epoch_unresolved{round, premium_retained, fee, pps, wclaims, oracle_answered}

payout_claimed{round, bidder, amount}
refund_claimed{round, bidder, amount}
fee_accrued{round, amount}
fee_claimed{recipient, amount}
settle_bounty{round, to, amount}

paused{by} · unpaused{by} · params_changed{params}
cap_changed{old, new} · fee_changed{old, new} · fee_recipient_changed{old, new}
allowlist_toggled{enabled} · allowed_changed{bidder, allowed}
rent_params_changed{old_threshold, new_threshold, old_extend_to, new_extend_to}
admin_transfer_started{current, pending} · admin_changed{old, new}
upgraded{wasm_hash, app_version} · migrated{from_version, to_version}
```

Four things an indexer has to know:

1. **All four finalization events carry `wclaims`.** Every outcome credits the withdrawal queue, so
   an indexer that only read it on `settled` would drift permanently the first time a round lapsed
   with a queued exit.
2. **`settle_bounty` is a separate event and is not emitted when the bounty floors to zero.**
   Checking `assets_after = assets_before + premium − payout − fee − bounty` against `settled` alone
   leaves you short the bounty term.
3. **`upgraded` carries the wasm hash and the *schema* version, which `upgrade` does not change.**
   Code and schema are versioned separately; only `migrate` moves the second.
4. **`epoch_lapsed`, `epoch_voided` and `epoch_unresolved` are first-class.** An auction that clears
   empty is a data point about demand, not a failure to hide. `epoch_unresolved` carries
   `oracle_answered`, which distinguishes the two ways into that outcome.

**Rejected calls emit nothing**, because in Soroban a reverting invocation discards its events along
with its state — an event on a failing path is not implementable. A stale or deviating feed is
observed through the error code that simulation returns.

## Errors

**Error numbers are ABI.** Gaps are never re-used and retired codes stay retired, which is why the
unallocated numbers are written down rather than left as silent holes.

Every public function returns `Result<T, Error>`, the SEP-41 surface included. The one exception is
arithmetic overflow, which panics: the bounds prove it unreachable, so reaching it means an
assumption broke and the transaction must die rather than continue on a wrapped value. **No
foreseeable condition panics** — "insufficient balance" is `InsufficientBalance`, not a checked
subtraction. Authorization failures surface as Soroban auth errors, never as a variant here. There is
deliberately no `NotInitialized`: with a `__constructor`, an uninitialized-but-deployed contract is
unrepresentable.

| # | Error | Meaning |
|---|---|---|
| 1 | `Paused` | Blocked by pause. Only `deposit`, `bid`, `open_epoch` can return it |
| 2 | `WrongPhase` | Wrong lifecycle phase — including a late bid and a fully subscribed offer |
| 3 | `IdleGapNotElapsed` | The gap between rounds has not elapsed |
| 4 | `NotExpired` | `close_round` before expiry |
| 6 | `OracleNotDeadYet` | Dead at expiry, but before `expiry + oracle_dead_after` |
| 7 | `NothingOffered` | `open_epoch` with less than `min_fill` locked |
| 8 | `NoShares` | The vault has never had a deposit |
| 9 | `RoundNotFound` | That round never existed. Distinct from *archived* |
| 10 | `OracleStale` | Feed older than `max_staleness`, at open |
| 11 | `OracleDeviation` | Short and guard windows diverge past the breaker, at open |
| 12 | `OracleInvalidPrice` | Non-positive or absurd price |
| 13 | `OracleUnreachable` | The adapter call itself failed — trap or budget |
| 20 | `BelowMinDeposit` | |
| 21 | `DepositCapExceeded` | |
| 22 | `NothingPending` | |
| 24 | `UnredeemedPending` | An earlier queued deposit is still unredeemed |
| 25 | `InsufficientShares` | |
| 26 | `NothingToClaim` | |
| 27 | `WithdrawNotSettled` | The round this withdrawal belongs to has not finalized |
| 29 | `InsufficientAllowance` | SEP-41 |
| 30 | `AllowlistForbidden` | Launch control, and it expires |
| 31 | `PremiumAboveMax` | The bidder's own slippage guard |
| 32 | `BelowMinFill` | Dust guard; the final sliver of an offer is exempt |
| 34 | `InTheMoney` | Spot has reached the strike; the vault will not sell intrinsic value |
| 35 | `ZeroPremium` | The fill is too small to pay a premium |
| 36 | `InsufficientBalance` | SEP-41, never a raw panic |
| 37 | `AlreadyClaimed` | |
| 38 | `NoFill` | Claim by an address that never filled that round |
| 39 | `WrongOutcome` | `claim_payout` on a non-settled round, or `claim_refund` on a non-voided one |
| 40 | `InvalidAmount` | Non-positive amount, anywhere |
| 41 | `InvalidParams` | |
| 44 | `ZeroShares` | A mint that would round to zero shares |
| 51 | `MigrationOrder` | `migrate` target version is not monotonic |
| 52 | `NoPendingAdmin` | `accept_admin` with no pending transfer |
| 53 | `InvalidAddress` | The contract's own address, or a role collision such as `asset == oracle` |
| 54 | `VaultWorthless` | A mint while `pps == 0`. **Withdrawals still work — that asymmetry is the point** |

Unallocated, permanently: **5** (`AuctionClosed`, retired — the phase moves before a late bid is
evaluated), **23** (`PendingNotFinalized`, unreachable), **28** (`PendingAlreadyFinalized`, retired —
cancel is now always allowed), **33** (`SoldOut`, retired — no transaction can reach a zero fill),
**55–56** (three rejections that existed when there were three terminal entry points; collapsing them
into one dispatcher made all three unreachable).

## Test strategy

| Layer | Covers |
|---|---|
| **Unit** | Every state transition, including every rejected one. Each guard has a test that proves it rejects |
| **Integration** | Full rounds against testnet: open → bid → settle, plus the lapse path and the void path |
| **Property-based** | Settlement math and round accounting. For arbitrary `(spot, strike, notional, deposits, withdrawals)`: I1–I10 hold, `payout ∈ [0, notional_sold)`, and `pps ≥ 0` with every withdrawal claim from a `pps == 0` round still summing to no more than the pool |
| **Fuzz** | Call-sequence fuzzing in adversarial orderings — over-sell attempts, double-settle, settle-before-expiry, bid-after-close. Every ordering is repeated under `paused == true` to prove I8 |
| **Differential** | Curve, settlement and claim output replayed against an independent Python reference written from the spec, not from the Rust. All four sections agree byte for byte on the four hand-written vectors. **A generated 204-vector corpus is currently red on about 87 of them** — one categorised cause, and a specification question rather than a defect in either implementation: two documents disagree about which error a post-sellout bid should return. The contract answers `WrongPhase`, which is what makes the retired `SoldOut` code unreachable |

Stale feeds and deviating prices are simulated through a mock price source rather than waited for.
That mock is deployed nowhere.
