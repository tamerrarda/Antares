//! The constructor and parameter validation — `02-CONTRACT-SPEC.md` §1, §4, §11.
//!
//! **`validate_params` lives here rather than in `admin.rs`** even though
//! `set_epoch_params` is what calls it most: it is the thing that *bounds* that
//! setter, so it carries `vault`'s 0-MISSED mutation bar instead of admin's ≤5 %
//! (06-TEST-PLAN §6). It is also the only thing standing between a setter and an
//! `unresolved_after` that disables the one terminal path not depending on the
//! oracle — and that overflows `expiry + unresolved_after` on the unpausable exit
//! path.
//!
//! Arithmetic here is written with explicit `checked_*` even where the profile's
//! `overflow-checks` would catch it. §8's bounds are proofs *about the inputs*;
//! the checked operation is what turns a violated proof into a revert instead of
//! a wrap, and the lint refuses the unchecked form at compile time.

use price_source_api::PriceSourceClient;
use soroban_sdk::{contractimpl, token::TokenClient, Address, Env, String};

use crate::errors::Error;
use crate::events::{
    DepositCancelled, Deposited, EpochLapsed, Initialized, PendingRedeemed, PositionRestored,
    WithdrawClaimed, WithdrawRequested,
};
use crate::storage::{self, Rent};
use crate::types::{
    Config, EpochParams, PendingDeposit, PendingWithdraw, Phase, Round, RoundOutcome, State,
    DEAD_SHARES, INITIAL_PPS, PRECISION,
};
// `#[contractimpl]` in a module other than the one holding `#[contract]` refers
// to the client and args types the latter generates, so they are imported rather
// than re-declared. This is what lets the contract surface be split across
// `vault`, `token`, `admin` and `views` instead of one file.
use crate::{AntaresVault, AntaresVaultArgs, AntaresVaultClient};

// One year. Every duration is bounded on **both** sides.
//
// The upper half is not decoration: before it, only `epoch_duration` had a
// ceiling, and an unbounded `unresolved_after` both disabled the one terminal
// path that does not depend on the oracle *and* overflowed `expiry +
// unresolved_after` outright — turning a checked add into a permanent panic on
// the exit path. Any parameter that appears in a timestamp sum needs a ceiling
// for that reason, so they all have one (D-68).
pub const MAX_DURATION: u64 = 31_536_000;

// 30 days (D-63). The allowlist expires on a timestamp fixed at construction and
// there is **no setter** — the admin may open the vault early but can never keep
// it closed, which is what makes the permissionless path a property rather than
// an operational promise.
pub const MAX_ALLOWLIST_WINDOW: u64 = 2_592_000;

// Basis points, as an integer bound.
const BPS_U32: u32 = 10_000;

// `settle_bounty_bps` ceiling (D-51): an uncapped bounty is D-39's mistake
// again — a live-read, participant-facing lever over money already committed.
const MAX_BOUNTY_BPS: u32 = 100;

// `auction_duration ≤ epoch_duration / AUCTION_FRACTION`.
const AUCTION_FRACTION: u64 = 24;

// `min_idle_gap ≥ epoch_duration / IDLE_GAP_FRACTION` — the guaranteed exit
// window has to scale with the epoch, because a fixed hour on a weekly epoch is
// not a window (D-33).
const IDLE_GAP_FRACTION: u64 = 50;

fn in_duration_range(d: u64) -> bool {
    d > 0 && d <= MAX_DURATION
}

// §1's validation, in full. Every rule here has a test that drives it to reject;
// §1 is an inventory, not a sample.
//
// `round_span` is `0` from here — which makes `supports_round` skip condition 7,
// deliberately. Sponsorship is a **liveness** fact and must not be allowed to
// block a parameter repair: if the feed's runway were checked in
// `set_epoch_params`, an admin could not lower `unresolved_after` to recover from
// exactly the shortfall that triggered it (D-68). `open_epoch` passes
// `epoch_duration + unresolved_after` and enforces it there instead.
pub fn validate_params(
    env: &Env,
    oracle: &Address,
    params: &EpochParams,
    deposit_cap: i128,
) -> Result<(), Error> {
    // -- every duration, both sides --
    for d in [
        params.epoch_duration,
        params.auction_duration,
        params.min_idle_gap,
        params.twap_window,
        params.guard_window,
        params.max_staleness,
        params.oracle_dead_after,
        params.settle_grace,
        params.unresolved_after,
    ] {
        if !in_duration_range(d) {
            return Err(Error::InvalidParams);
        }
    }

    // -- relations between durations --
    let auction_cap = params
        .epoch_duration
        .checked_div(AUCTION_FRACTION)
        .ok_or(Error::InvalidParams)?;
    if params.auction_duration > auction_cap {
        return Err(Error::InvalidParams);
    }

    let idle_floor = params
        .epoch_duration
        .checked_div(IDLE_GAP_FRACTION)
        .ok_or(Error::InvalidParams)?;
    if params.min_idle_gap < idle_floor {
        return Err(Error::InvalidParams);
    }

    if params.guard_window <= params.twap_window {
        return Err(Error::InvalidParams);
    }

    // The evidence-based window must open before the evidence-free fallback
    // closes it, or the void branch is unreachable.
    if params.unresolved_after <= params.oracle_dead_after {
        return Err(Error::InvalidParams);
    }

    // -- premium band --
    //
    // The lower bound on the floor is load-bearing: a floor of 0 satisfies every
    // other rule and then makes the curve reject every bid with `ZeroPremium`
    // once it arrives there, so the last stretch of every auction is dead.
    if params.premium_floor_bps == 0 || params.premium_floor_bps > params.premium_start_bps {
        return Err(Error::InvalidParams);
    }
    if params.premium_start_bps >= BPS_U32 {
        return Err(Error::InvalidParams);
    }

    // -- strike and breaker --
    if params.strike_bps_otm > BPS_U32 {
        return Err(Error::InvalidParams);
    }
    if params.max_deviation_bps == 0 || params.max_deviation_bps > BPS_U32 {
        return Err(Error::InvalidParams);
    }

    // -- dust guards --
    if params.min_fill <= 0 {
        return Err(Error::InvalidParams);
    }
    // `> DEAD_SHARES`, not merely `> 0`. §1's claim that the first deposit can
    // never underflow rested on the *default* being 10 XLM, which is an
    // observation about a value rather than a constraint on it: at `INITIAL_PPS`
    // a `min_deposit` of 1 stroop mints 1 share and `minted − DEAD_SHARES`
    // underflows a checked subtraction, contradicting the promise that no
    // foreseeable condition panics.
    if params.min_deposit <= DEAD_SHARES {
        return Err(Error::InvalidParams);
    }

    // The pair spans two structs and two setters, so either one alone can produce
    // a vault no deposit can enter. Re-asserted here as well as in
    // `set_deposit_cap`.
    if deposit_cap != 0 && deposit_cap < params.min_deposit {
        return Err(Error::InvalidParams);
    }

    if params.settle_bounty_bps > MAX_BOUNTY_BPS {
        return Err(Error::InvalidParams);
    }

    // -- and the feed's own answer --
    //
    // The adapter owns every rule that depends on its tick and reachable depth,
    // and answers yes or no, so the vault never grows a `resolution` field (D-58).
    // Called through the client's recoverable `try_` form (04-ORACLE §3b): a
    // trapping or budget-exhausted adapter must surface as `InvalidParams`, not
    // as a host trap escaping the constructor.
    //
    // outbound: config.oracle
    let client = PriceSourceClient::new(env, oracle);
    let supported = client
        .try_supports_round(
            &params.twap_window,
            &params.guard_window,
            &params.oracle_dead_after,
            &params.settle_grace,
            &params.unresolved_after,
            &0,
        )
        .map_err(|_| Error::InvalidParams)?
        .map_err(|_| Error::InvalidParams)?;

    if !supported {
        return Err(Error::InvalidParams);
    }

    Ok(())
}

// §4's rent bound, shared by the constructor and `set_rent_params`.
//
// The ceiling is read **live** from the network rather than compiled in (D-50).
// This check is hygiene that catches typos at the door: the load-bearing defence
// is the per-call clamp in `storage::Rent::effective`, because the network can
// lower `max_ttl` by protocol vote after the value is stored, and this check
// cannot see the future.
pub fn validate_rent(env: &Env, threshold: u32, extend_to: u32) -> Result<(), Error> {
    if threshold == 0 || threshold >= extend_to || extend_to > env.storage().max_ttl() {
        return Err(Error::InvalidParams);
    }
    Ok(())
}

// §11. The contract's own address in any role, and the `asset == oracle`
// collision.
//
// Not cosmetic in either half: the vault calling itself as a token would make a
// self-transfer succeed while moving nothing, and an oracle that is also the
// asset means one address answers two interfaces it cannot both satisfy.
fn validate_addresses(
    env: &Env,
    admin: &Address,
    asset: &Address,
    oracle: &Address,
    fee_recipient: &Address,
) -> Result<(), Error> {
    let me = env.current_contract_address();
    if *admin == me || *asset == me || *oracle == me || *fee_recipient == me {
        return Err(Error::InvalidAddress);
    }
    if asset == oracle {
        return Err(Error::InvalidAddress);
    }
    Ok(())
}

#[contractimpl]
impl AntaresVault {
    // Ten arguments, one transaction (D-56/D-63). Runs once by construction —
    // there is no `initialize` function to call twice, which is why no
    // `NotInitialized` error exists.
    //
    // Three `Config` fields are **genesis constants rather than arguments**
    // (D-56), and each for a reason worth keeping:
    // - `fee_bps = 0`, so a non-zero fee always costs a separate, publicly
    //   visible `set_fee_bps` transaction;
    // - `paused = false`, because the launch control is the cap, not pause;
    // - `allowlist_enabled = true`, safe by default — and disabling it is the
    //   on-chain evidence that the permissionless path is live.
    #[allow(clippy::too_many_arguments)] // ten of them, by D-56's design
    /// Deploy the vault. Runs once, at creation.
    pub fn __constructor(
        env: Env,
        admin: Address,
        asset: Address,
        oracle: Address,
        fee_recipient: Address,
        params: EpochParams,
        token_suffix: String,
        deposit_cap: i128,
        rent_threshold: u32,
        rent_extend_to: u32,
        allowlist_expires_at: u64,
    ) -> Result<(), Error> {
        validate_addresses(&env, &admin, &asset, &oracle, &fee_recipient)?;

        if token_suffix.len() > 4 {
            return Err(Error::InvalidParams);
        }
        if deposit_cap < 0 {
            return Err(Error::InvalidParams);
        }
        validate_rent(&env, rent_threshold, rent_extend_to)?;

        // D-63: capped at construction, and there is no setter anywhere in the
        // contract that can move it afterwards.
        let horizon = env
            .ledger()
            .timestamp()
            .checked_add(MAX_ALLOWLIST_WINDOW)
            .ok_or(Error::InvalidParams)?;
        if allowlist_expires_at > horizon {
            return Err(Error::InvalidParams);
        }

        validate_params(&env, &oracle, &params, deposit_cap)?;

        let config = Config {
            admin: admin.clone(),
            pending_admin: None,
            asset: asset.clone(),
            oracle: oracle.clone(),
            fee_recipient: fee_recipient.clone(),
            token_suffix: token_suffix.clone(),
            fee_bps: 0,
            deposit_cap,
            paused: false,
            allowlist_enabled: true,
            allowlist_expires_at,
            params: params.clone(),
            rent_threshold,
            rent_extend_to,
        };

        // `round = 0` and `last_finalize_time = 0`, so the first `open_epoch` is
        // not gated by `min_idle_gap`. The first opened round is 1.
        let state = State {
            round: 0,
            phase: Phase::Idle,
            params: params.clone(),
            fee_bps_snapshot: 0,
            opened_at: 0,
            auction_end: 0,
            expiry: 0,
            feed_decimals: 0,
            strike: 0,
            open_twap: 0,
            notional_offered: 0,
            notional_sold: 0,
            premium_collected: 0,
            locked_at_open: 0,
            shares_snapshot: 0,
            burned_this_round: 0,
            locked_assets: 0,
            shares_outstanding: 0,
            last_pps: INITIAL_PPS,
            last_settled_spot: 0,
            last_finalize_time: 0,
            pending_deposits_total: 0,
            withdraw_claimable_total: 0,
            bidder_claimable_total: 0,
            fee_claimable: 0,
        };

        storage::set_config(&env, &config);
        storage::set_state(&env, &state);
        storage::set_app_version(&env, APP_VERSION);
        storage::bump_instance(&env, Rent::effective(&env, &config));

        Initialized {
            admin,
            asset,
            oracle,
            fee_recipient,
            token_suffix,
            deposit_cap,
            rent_threshold,
            rent_extend_to,
            allowlist_expires_at,
            params,
            fee_bps: 0,
            paused: false,
            allowlist_enabled: true,
            app_version: APP_VERSION,
        }
        .publish(&env);

        Ok(())
    }
}

// Genesis schema version. `migrate` is monotonic from here (D-13).
pub const APP_VERSION: u32 = 1;

// =================================================================================================
// §2.5 — the single exit from a live round, and the lazy path that reaches it
// =================================================================================================

// **Every** round terminates here. Four call sites — settle, lazy lapse, void,
// unresolved — with different `pps` and `assets_after`, but identical
// bookkeeping, because the withdrawal-queue accounting below is easy to forget
// in one branch and that omission is a solvency bug rather than a style issue.
// It was forgotten once, in the Lapsed branch, and D-32 is the repair.
//
// ```text
// wclaims                   = ⌊burned_this_round × pps / PRECISION⌋
// withdraw_claimable_total += wclaims
// locked_assets             = assets_after − wclaims
// ```
//
// **`wclaims ≤ assets_after` needs no guard, and that is exactly why `pps` is
// never clamped** (D-66): `pps = ⌊assets_R·P/S⌋` gives `S·pps ≤ assets_R·P`,
// hence `wclaims ≤ burned·pps/P ≤ S·pps/P ≤ assets_after`. Any rule that raises
// `pps` above the computed value breaks that chain and makes the subtraction
// below underflow — and capping `wclaims` instead would not have helped, because
// `claim_withdraw` recomputes each user's amount from the round record and never
// reads the aggregate.
// The three `Round` fields no caller of `finalize_round` could supply through its original
// signature, and which I7 forbids writing in a second pass.
//
// **Found 2026-08-19 while writing `settle.rs`, and it is a gap in 02-CONTRACT-SPEC §5 rather than
// in this function.** §5 titles it `finalize_round(outcome, pps, assets_after)` and says it
// "handles ... the `Round` record" — but §2 declares `settled_spot` as *"0 unless `Settled`"*,
// `payout_total` as *"0 unless `Settled` with `spot > strike`"*, and §5's own settle and unresolved
// paths accrue a `fee`. None of the three is derivable from `(outcome, pps, assets_after)`, and I7
// makes the record immutable once written, so they cannot be patched in afterwards. A struct rather
// than three more positional `i128`s because `Settlement::NONE` says at the lapse and void call
// sites what `0, 0, 0` would only imply. It is deliberately **not** a `#[contracttype]`: it never
// crosses the ABI, and §2's surface is frozen at IP-1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub fee: i128,
    pub settled_spot: i128,
    pub payout_total: i128,
}

impl Settlement {
    // Lapse and void: no fee accrues, no price was observed, nothing was paid out.
    pub const NONE: Settlement = Settlement {
        fee: 0,
        settled_spot: 0,
        payout_total: 0,
    };
}

/// The bookkeeping every outcome shares: `(wclaims, locked_after)`.
// Lifted out of `finalize_round` so the differential layer can reach it, following
// `round_numbers` and `payout_for_fill` rather than inventing a third shape. A replay
// harness cannot call the inside of an entry point, and a term the layer cannot reach
// is a term it does not cover — `settle_ref.py` has been undiffed since the second
// commit in this project for exactly this reason, and `claims_ref.withdraw_claims`
// behind it.
//
// `finalize_round` calls this, so the vectors exercise the shipped arithmetic rather
// than a copy of it. That is the whole point of the extraction and the reason it is
// not simply duplicated into the test.
//
// **It refuses a negative `locked_after`, and the precedent is `round_numbers`.**
// `round_numbers` was made to refuse five fields it cannot reach after a fuzz target
// walked straight into the gap that "other code guarantees this" leaves. This is the
// same class — extracted, pure, reachable from a replay harness that does not honour
// its caller's domain — and its output is `locked_assets`, the vault's own solvency
// number. Three extracted functions exist and it would have been the only one
// declining to state its domain.
//
// Nothing reachable gets here: `close_round` rejects `assets_R < 0` upstream, and
// `wclaims ≤ burned·pps/P ≤ S·pps/P ≤ assets_after` holds whenever
// `burned ≤ shares_snapshot` — the same chain I9 rests on. **"Impossible" is exactly
// what stopped being load-bearing** on the one path that must never fail.
//
// `settle_ref.py` refuses it too. That was noticed *after* the guard was argued for
// and **is not the justification** — a fix written to match a reference makes the next
// diff worthless, and the provenance record on that file is worth nothing if either
// side drifts toward the other. Ruled by Tamer 2026-08-19; 02-CONTRACT-SPEC §5.
pub fn finalize_numbers(
    burned_this_round: i128,
    pps: i128,
    assets_after: i128,
) -> Result<(i128, i128), Error> {
    let wclaims = mul_div_floor(burned_this_round, pps, PRECISION)?;
    let locked_after = assets_after
        .checked_sub(wclaims)
        .ok_or(Error::InvalidAmount)?;
    // `checked_sub` catches the wrap, not the sign. Both are refused.
    if locked_after < 0 {
        return Err(Error::InvalidAmount);
    }
    Ok((wclaims, locked_after))
}

pub fn finalize_round(
    env: &Env,
    state: &mut State,
    rent: Rent,
    outcome: RoundOutcome,
    pps: i128,
    assets_after: i128,
    settlement: Settlement,
) -> Result<i128, Error> {
    let (wclaims, locked_after) = finalize_numbers(state.burned_this_round, pps, assets_after)?;

    state.withdraw_claimable_total = state
        .withdraw_claimable_total
        .checked_add(wclaims)
        .ok_or(Error::InvalidAmount)?;
    state.locked_assets = locked_after;

    // Immutable from here (I7). Written once, never rewritten, by anything.
    let record = Round {
        outcome,
        pps,
        strike: state.strike,
        expiry: state.expiry,
        notional_sold: state.notional_sold,
        premium: state.premium_collected,
        fee: settlement.fee,
        settled_spot: settlement.settled_spot,
        payout_total: settlement.payout_total,
    };
    storage::set_round(env, rent, state.round, &record);

    state.last_pps = pps;
    state.last_finalize_time = env.ledger().timestamp();
    state.phase = Phase::Idle;
    state.burned_this_round = 0;

    Ok(wclaims)
}

// Runs at the top of every state-mutating entry point, **after `require_auth`
// and before the pause check** (§16's canonical order). Returns whether it
// actually finalized a round, because `open_epoch` and `close_round` both branch
// on that (D-43, D-61) — so the signature has to carry it.
//
// `Active → Settled/Voided` is never lazy: it needs the oracle and stays an
// explicit `close_round`. What is lazy is the empty auction, which keeps
// `Lapsed` permissionless by construction — nobody has to send a dedicated
// "close the empty auction" transaction, the next interaction of any kind
// absorbs it.
pub fn lazy_finalize(env: &Env, state: &mut State, rent: Rent) -> Result<bool, Error> {
    if state.phase != Phase::Auction || env.ledger().timestamp() < state.auction_end {
        return Ok(false);
    }

    if state.notional_sold > 0 {
        // The auction closed with fills: the option is live, and this is not a
        // finalization — the round still has to be closed against the oracle.
        state.phase = Phase::Active;
        return Ok(false);
    }

    let wclaims = finalize_round(
        env,
        state,
        rent,
        RoundOutcome::Lapsed,
        state.last_pps,
        state.locked_at_open,
        Settlement::NONE,
    )?;
    EpochLapsed {
        round: state.round,
        notional_offered: state.notional_offered,
        pps: state.last_pps,
        wclaims,
    }
    .publish(env);
    Ok(true)
}

// `⌊a × b / d⌋` with every step checked.
//
// Floor division, always in the vault's favour — that is what makes I1 hold
// under rounding (D-20, §6). The checked operations are not redundant with the
// profile's `overflow-checks`: §8's bounds are proofs about the inputs, and a
// checked op is what turns a violated proof into a revert rather than a wrap.
pub(crate) fn mul_div_floor(a: i128, b: i128, d: i128) -> Result<i128, Error> {
    a.checked_mul(b)
        .and_then(|p| p.checked_div(d))
        .ok_or(Error::InvalidAmount)
}

// =================================================================================================
// §2.4 — deposit, pending, withdraw. The heart.
// =================================================================================================

// `Config` and `State` exist from the moment the contract does.
//
// There is no `NotInitialized` error and deliberately so (§3): with a
// `__constructor`, an uninitialized-but-deployed contract is unrepresentable. A
// missing entry here is not a foreseeable condition returning an error — it is
// an assumption having broken, and the transaction must die rather than
// continue on a default.
fn load(env: &Env) -> (Config, State) {
    let config = storage::get_config(env).expect("Config: unrepresentable after __constructor");
    let state = storage::get_state(env).expect("State: unrepresentable after __constructor");
    (config, state)
}

// §16's canonical order, in one place.
//
// `require_auth` stays at the call site — only the entry point knows whose auth
// it is — and everything after it lives here, so no entry point can get the
// order wrong and no two can disagree about *which* rejection a given call
// produces. That last part is the reason the order is canonical at all.
pub struct Ctx {
    pub config: Config,
    pub state: State,
    pub rent: Rent,
}

pub fn enter(env: &Env, pause_blocks: bool) -> Result<Ctx, Error> {
    let (config, mut state) = load(env);
    let rent = Rent::effective(env, &config);

    // After auth, before the pause check and the preconditions. A revert later
    // discards these writes along with everything else, which is why the pause
    // check's position is *not* load-bearing (§16) — pause cannot trap funds,
    // because the unpausable entry points finalize instead of reverting.
    lazy_finalize(env, &mut state, rent)?;

    if pause_blocks && config.paused {
        return Err(Error::Paused);
    }
    Ok(Ctx {
        config,
        state,
        rent,
    })
}

pub(crate) fn commit(env: &Env, ctx: &Ctx) {
    storage::set_state(env, &ctx.state);
    storage::bump_instance(env, ctx.rent);
}

// The SAC at `Config.asset`. Not a third-party dependency and no conflict with
// D-24: this is the SDK's binding to platform code, the same way `Address` is.
// What D-24 forbids is importing somebody else's vault or token implementation.
pub(crate) fn asset_client<'a>(env: &'a Env, config: &Config) -> TokenClient<'a> {
    // outbound: config.asset
    TokenClient::new(env, &config.asset)
}

// Mint at the **current** price, and only ever in Idle (D-18).
//
// Two guards, both from D-36 and both mandatory, because either alone is
// insufficient: `DEAD_SHARES` floors the supply so it can never be driven back
// to zero, and `ZeroShares` refuses a mint that would round to nothing rather
// than absorbing the deposit silently.
fn mint(env: &Env, ctx: &mut Ctx, to: &Address, amount: i128) -> Result<i128, Error> {
    let minted = mul_div_floor(amount, PRECISION, ctx.state.last_pps)?;
    if minted <= 0 {
        return Err(Error::ZeroShares);
    }

    // The very first deposit pays for the dead shares out of its own amount.
    // `min_deposit > DEAD_SHARES` (§1) is what makes this subtraction safe: at
    // genesis `last_pps == INITIAL_PPS`, so `minted == amount ≥ min_deposit`.
    let credited = if ctx.state.shares_outstanding == 0 {
        let vault = env.current_contract_address();
        storage::set_shares(env, ctx.rent, &vault, DEAD_SHARES);
        minted.checked_sub(DEAD_SHARES).ok_or(Error::ZeroShares)?
    } else {
        minted
    };
    if credited <= 0 {
        return Err(Error::ZeroShares);
    }

    let balance = storage::get_shares(env, to)
        .checked_add(credited)
        .ok_or(Error::InvalidAmount)?;
    storage::set_shares(env, ctx.rent, to, balance);

    ctx.state.shares_outstanding = ctx
        .state
        .shares_outstanding
        .checked_add(minted)
        .ok_or(Error::InvalidAmount)?;
    ctx.state.locked_assets = ctx
        .state
        .locked_assets
        .checked_add(amount)
        .ok_or(Error::InvalidAmount)?;

    // §10: the SEP-41 stream is the token view and the vault stream is the
    // protocol view. Both are emitted; an indexer counts one or the other.
    crate::token::emit_mint(env, to, credited);

    Ok(credited)
}

// Convert a pending deposit at `last_pps` — **the current price, not the pps of
// the round it was deposited during** (D-37).
//
// Capital sitting as a pending deposit took no risk in that round and none in
// the rounds since, so it has earned none of their premium and must enter at
// today's price. Converting at the old `pps[R]` broke I9 — whose proof sketch
// silently assumes the mint price *equals* `last_pps` — and handed the depositor
// a free lookback option: wait, watch `pps` across several rounds, redeem into
// the best one.
fn redeem_pending(
    env: &Env,
    ctx: &mut Ctx,
    user: &Address,
    pending: &PendingDeposit,
) -> Result<i128, Error> {
    ctx.state.pending_deposits_total = ctx
        .state
        .pending_deposits_total
        .checked_sub(pending.amount)
        .ok_or(Error::InvalidAmount)?;

    let shares = mint(env, ctx, user, pending.amount)?;
    storage::remove_pending_deposit(env, user);

    PendingRedeemed {
        user: user.clone(),
        round: pending.round,
        amount: pending.amount,
        shares,
        pps: ctx.state.last_pps,
    }
    .publish(env);

    Ok(shares)
}

#[contractimpl]
impl AntaresVault {
    // Returns the shares minted — `0` for a pending deposit.
    /// Deposit XLM. Returns the shares minted, or `0` when a live round queues it.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<i128, Error> {
        from.require_auth();
        let mut ctx = enter(&env, true)?;

        // §15: `Config.params`, because deposits happen in every phase —
        // including before the first round exists, when there is no snapshot.
        if amount < ctx.config.params.min_deposit {
            return Err(Error::BelowMinDeposit);
        }
        // §11, and not cosmetic: a SAC self-transfer **succeeds while moving
        // nothing**, so without this the vault would mint shares against a
        // transfer that never happened.
        //
        // Position per F-6's ruling, which is one ruling for `deposit` and `bid`
        // because the hole was identical in both: immediately after the first
        // check on the arguments' values. Pause still dominates, so a paused
        // self-deposit answers `Paused` — §16's own rule, and the reason there is
        // a canonical order at all. This sat before `min_deposit` until the
        // ruling; moving it costs nothing and matching `bid` is worth more than
        // my preference, since the two are written by different people.
        if from == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }
        // A mint divides by `pps`, and §16 allows `pps == 0` in the degenerate
        // state where the pool is worth less than a stroop per PRECISION
        // share-units. Withdrawals still work there; minting does not.
        if ctx.state.last_pps == 0 {
            return Err(Error::VaultWorthless);
        }
        if ctx.config.deposit_cap != 0 {
            let total = ctx
                .state
                .locked_assets
                .checked_add(ctx.state.pending_deposits_total)
                .and_then(|t| t.checked_add(amount))
                .ok_or(Error::InvalidAmount)?;
            if total > ctx.config.deposit_cap {
                return Err(Error::DepositCapExceeded);
            }
        }

        let minted = if ctx.state.phase == Phase::Idle {
            // Every pending is finalized in Idle by construction, so this is the
            // auto-redeem §10 requires to be emitted **first**, before `deposited`.
            if let Some(pending) = storage::get_pending_deposit(&env, &from) {
                redeem_pending(&env, &mut ctx, &from, &pending)?;
            }
            mint(&env, &mut ctx, &from, amount)?
        } else {
            match storage::get_pending_deposit(&env, &from) {
                // A second deposit in the same live round accumulates.
                Some(p) if p.round == ctx.state.round => {
                    let sum = p.amount.checked_add(amount).ok_or(Error::InvalidAmount)?;
                    storage::set_pending_deposit(
                        &env,
                        ctx.rent,
                        &from,
                        &PendingDeposit {
                            round: p.round,
                            amount: sum,
                        },
                    );
                }
                // **Finalized, not settled**: a lapsed or voided round also leaves
                // a redeemable pending, and `PendingDeposit(user)` is one slot —
                // the narrower word would let this deposit overwrite it, stranding
                // the old amount inside `pending_deposits_total` forever.
                Some(_) => return Err(Error::UnredeemedPending),
                None => storage::set_pending_deposit(
                    &env,
                    ctx.rent,
                    &from,
                    &PendingDeposit {
                        round: ctx.state.round,
                        amount,
                    },
                ),
            }
            ctx.state.pending_deposits_total = ctx
                .state
                .pending_deposits_total
                .checked_add(amount)
                .ok_or(Error::InvalidAmount)?;
            0
        };

        let instant = ctx.state.phase == Phase::Idle;
        let round = ctx.state.round;
        commit(&env, &ctx);

        // Checks, effects, then interactions — the transfer is last.
        let vault = env.current_contract_address();
        asset_client(&env, &ctx.config).transfer(&from, &vault, &amount);

        Deposited {
            user: from,
            round,
            amount,
            shares_minted: minted,
            instant,
        }
        .publish(&env);

        Ok(minted)
    }

    // Any phase, **unpausable**, exact amount back (D-37).
    //
    // The only instant exit that works during a live round, and it is safe
    // precisely because that capital never backed an option — I4's own stated
    // exception, and the counterexample that makes a naive reading of it fail.
    /// Take back a queued deposit, in full. Works in any phase, including while paused.
    pub fn cancel_pending_deposit(env: Env, from: Address) -> Result<i128, Error> {
        from.require_auth();
        let mut ctx = enter(&env, false)?;

        let pending = storage::get_pending_deposit(&env, &from).ok_or(Error::NothingPending)?;

        ctx.state.pending_deposits_total = ctx
            .state
            .pending_deposits_total
            .checked_sub(pending.amount)
            .ok_or(Error::InvalidAmount)?;
        storage::remove_pending_deposit(&env, &from);
        commit(&env, &ctx);

        asset_client(&env, &ctx.config).transfer(
            &env.current_contract_address(),
            &from,
            &pending.amount,
        );

        DepositCancelled {
            user: from,
            round: pending.round,
            amount: pending.amount,
        }
        .publish(&env);

        Ok(pending.amount)
    }

    // Idle only, and at `last_pps` — never at the pps of the round the deposit
    // was made during (D-37).
    /// Turn a queued deposit into shares at the current price. Between rounds only.
    pub fn redeem_shares(env: Env, from: Address) -> Result<i128, Error> {
        from.require_auth();
        let mut ctx = enter(&env, false)?;

        if ctx.state.phase != Phase::Idle {
            return Err(Error::WrongPhase);
        }
        if ctx.state.last_pps == 0 {
            return Err(Error::VaultWorthless);
        }
        let pending = storage::get_pending_deposit(&env, &from).ok_or(Error::NothingPending)?;

        let shares = redeem_pending(&env, &mut ctx, &from, &pending)?;
        commit(&env, &ctx);
        Ok(shares)
    }
}

// Pay out a `PendingWithdraw` whose round has finalized.
//
// A `Round` record exists **iff** the round finalized — `finalize_round` is the
// only writer — so its presence is the finalization test, and there is no second
// flag that could disagree with it.
fn claim_pending_withdraw(
    env: &Env,
    ctx: &mut Ctx,
    user: &Address,
    pending: &PendingWithdraw,
) -> Result<i128, Error> {
    let record = storage::get_round(env, pending.round).ok_or(Error::WithdrawNotSettled)?;

    // Recomputed from the immutable round record, exactly as every other claim
    // is. This is the half a cap on the aggregate `wclaims` would not have
    // fixed, and the reason `pps` is never clamped (D-66).
    let amount = mul_div_floor(pending.shares, record.pps, PRECISION)?;

    ctx.state.withdraw_claimable_total = ctx
        .state
        .withdraw_claimable_total
        .checked_sub(amount)
        .ok_or(Error::InvalidAmount)?;
    storage::remove_pending_withdraw(env, user);

    Ok(amount)
}

#[contractimpl]
impl AntaresVault {
    // Returns the XLM paid now, or `0` when the request was queued.
    //
    // `require_idle` is D-46: with it true the call reverts unless the vault is
    // Idle, so a user asking for an instant exit can never be silently converted
    // into a queued one by an `open_epoch` landing first. Unpausable (I8).
    /// Burn shares: paid at once between rounds, otherwise queued until the round ends.
    pub fn request_withdraw(
        env: Env,
        from: Address,
        shares: i128,
        require_idle: bool,
    ) -> Result<i128, Error> {
        from.require_auth();
        let mut ctx = enter(&env, false)?;

        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        if shares > storage::get_shares(&env, &from) {
            return Err(Error::InsufficientShares);
        }
        if require_idle && ctx.state.phase != Phase::Idle {
            return Err(Error::WrongPhase);
        }

        // An older finalized request is settled first: there is one
        // `PendingWithdraw` slot per user, so a second request would otherwise
        // overwrite a claim the user has already earned.
        let mut paid = 0i128;
        let mut claimed_round = 0u32;
        if let Some(existing) = storage::touch_pending_withdraw(&env, ctx.rent, &from) {
            if storage::get_round(&env, existing.round).is_some() {
                paid = claim_pending_withdraw(&env, &mut ctx, &from, &existing)?;
                claimed_round = existing.round;
            }
        }

        let round = ctx.state.round;

        // §16's zero-value rule, and its one exception — **evaluated before the
        // burn, not after it.**
        //
        // Rejecting a dust payout stops shares being burned for nothing; but at
        // `last_pps == 0` the *vault* is worth nothing, and the same reject would
        // turn "your shares are worth nothing" into "you cannot remove your
        // shares", making I8's promise false. So the reject applies only where a
        // zero payout means the caller's stake is dust.
        //
        // It sat *after* the burn until a snapshot review found the burn event
        // recorded on a call that rejected. On-chain the revert discards both the
        // write and the event, so nothing was wrong — but a guard that runs after
        // its own effect contradicts §11's checks-effects-interactions and is one
        // refactor away from being real. This project's bugs live in exactly that
        // kind of ordering.
        let instant_amount = if ctx.state.phase == Phase::Idle {
            let amount = mul_div_floor(shares, ctx.state.last_pps, PRECISION)?;
            if amount == 0 && ctx.state.last_pps > 0 {
                return Err(Error::InvalidAmount);
            }
            amount
        } else {
            0
        };

        // Burn now, in both paths. The queued path prices the shares at the
        // round's recorded pps once it finalizes; the instant path priced them at
        // `last_pps` just above.
        let balance = storage::get_shares(&env, &from)
            .checked_sub(shares)
            .ok_or(Error::InsufficientShares)?;
        storage::set_shares(&env, ctx.rent, &from, balance);
        ctx.state.shares_outstanding = ctx
            .state
            .shares_outstanding
            .checked_sub(shares)
            .ok_or(Error::InvalidAmount)?;
        crate::token::emit_burn(&env, &from, shares);

        if ctx.state.phase == Phase::Idle {
            ctx.state.locked_assets = ctx
                .state
                .locked_assets
                .checked_sub(instant_amount)
                .ok_or(Error::InvalidAmount)?;
        } else {
            // A second request in the same live round accumulates into the
            // existing record rather than replacing or rejecting it (§16).
            let queued = match storage::get_pending_withdraw(&env, &from) {
                Some(p) if p.round == round => {
                    p.shares.checked_add(shares).ok_or(Error::InvalidAmount)?
                }
                _ => shares,
            };
            storage::set_pending_withdraw(
                &env,
                ctx.rent,
                &from,
                &PendingWithdraw {
                    round,
                    shares: queued,
                },
            );
            ctx.state.burned_this_round = ctx
                .state
                .burned_this_round
                .checked_add(shares)
                .ok_or(Error::InvalidAmount)?;
        }

        let total_out = paid
            .checked_add(instant_amount)
            .ok_or(Error::InvalidAmount)?;
        commit(&env, &ctx);

        if total_out > 0 {
            asset_client(&env, &ctx.config).transfer(
                &env.current_contract_address(),
                &from,
                &total_out,
            );
        }

        if paid > 0 || claimed_round != 0 {
            WithdrawClaimed {
                user: from.clone(),
                round: claimed_round,
                shares: 0,
                amount: paid,
            }
            .publish(&env);
        }

        WithdrawRequested {
            user: from.clone(),
            round,
            shares,
        }
        .publish(&env);

        // An instant Idle withdrawal emits both events in the same transaction,
        // both carrying the last opened round — already finalized, and the one
        // whose `pps` was used (§10).
        if ctx.state.phase == Phase::Idle {
            WithdrawClaimed {
                user: from,
                round,
                shares,
                amount: instant_amount,
            }
            .publish(&env);
        }

        Ok(total_out)
    }

    // Any phase, unpausable, at the referenced round's **recorded** `pps`.
    //
    // A `pps == 0` round pays 0 and **succeeds** — rejecting would strand the
    // record while the shares are already burned (D-66's test).
    /// Collect a queued withdrawal once its round has finalized.
    pub fn claim_withdraw(env: Env, from: Address) -> Result<i128, Error> {
        from.require_auth();
        let mut ctx = enter(&env, false)?;

        let pending =
            storage::touch_pending_withdraw(&env, ctx.rent, &from).ok_or(Error::NothingPending)?;
        let amount = claim_pending_withdraw(&env, &mut ctx, &from, &pending)?;
        commit(&env, &ctx);

        // Zero is a success, not a transfer: a zero-amount SAC call is a legal
        // no-op but would publish a transfer event for money that did not move.
        if amount > 0 {
            asset_client(&env, &ctx.config).transfer(
                &env.current_contract_address(),
                &from,
                &amount,
            );
        }

        WithdrawClaimed {
            user: from,
            round: pending.round,
            shares: pending.shares,
            amount,
        }
        .publish(&env);

        Ok(amount)
    }

    // Permissionless storage maintenance (03-STORAGE-TTL §4), on I8's
    // unpausable list — a paused vault whose entries are archiving must still be
    // reachable, and a helper must be able to maintain a dormant user's position.
    /// Refresh the storage backing a user's position. Callable by anyone.
    pub fn restore_position(env: Env, user: Address) -> Result<(), Error> {
        let ctx = enter(&env, false)?;
        storage::restore_position_keys(&env, ctx.rent, &user);
        commit(&env, &ctx);
        PositionRestored { user }.publish(&env);
        Ok(())
    }
}
