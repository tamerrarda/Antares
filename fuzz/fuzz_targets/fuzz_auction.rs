//! `fuzz_auction` — bid storms against arbitrary curves (`06-TEST-PLAN.md` §4, target 3).
//!
//! Many bidders, dust attempts, re-bids and boundary timestamps, against a curve whose shape is
//! itself generated. Asserts three things:
//!
//! 1. **I2** — `notional_sold <= notional_offered <= locked_at_open`, after every bid including
//!    every rejected one.
//! 2. **Premium accounting exactness** — `premium_collected == Σ fills`, recomputed from the `Fill`
//!    records rather than tracked alongside. A running total kept by the target would agree with a
//!    contract that had lost a premium in the same way the contract lost it.
//! 3. **The sliver rule** — a fill below `min_fill` is admissible only when it exactly empties the
//!    offer, and never otherwise.
//!
//! # Why the curve is generated rather than fixed
//!
//! `fuzz_call_sequence` drives orderings against one parameter set; this drives one ordering shape
//! against arbitrary parameter sets. The interesting arithmetic in `bid` is the interaction between
//! `premium_bps(t)`, `min_fill` and the remaining offer — a fixed curve exercises one point of it.
//! `premium_start_bps` and `premium_floor_bps` are constrained only to what `validate_params`
//! already enforces (`0 < floor <= start < 10 000`), because a set the constructor refuses tests
//! the constructor, not the auction.

#![no_main]

use libfuzzer_sys::fuzz_target;

use antares_vault::types::{EpochParams, Phase};
use antares_vault::{AntaresVault, AntaresVaultClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token::StellarAssetClient, Address, Env, String};

const XLM: i128 = 10_000_000;
const BIDDERS: usize = 4;

#[derive(arbitrary::Arbitrary, Debug)]
struct Shape {
    /// `floor = 1 + span/2`, `start = 10 + span` — always `0 < floor <= start`, which is §1's rule.
    span: u16,
    auction_duration: u16,
    /// The offer, in whole XLM.
    offered: u16,
    /// `min_fill` as a percentage of the offer, so dust and sliver cases are reachable at any size.
    min_fill_pct: u8,
}

#[derive(arbitrary::Arbitrary, Debug)]
struct Bid {
    who: u8,
    /// Percentage of the offer. Allowed past 100 so the clamp to the remainder is exercised.
    part: u8,
    max_bps: u16,
    /// Seconds into the auction window, wrapped — so `0` and the last admissible second both occur.
    at: u16,
}

#[derive(arbitrary::Arbitrary, Debug)]
struct Input {
    shape: Shape,
    bids: Vec<Bid>,
}

fuzz_target!(|input: Input| {
    if input.bids.is_empty() || input.bids.len() > 24 {
        return;
    }

    let span = i64::from(input.shape.span % 9_000);
    let premium_floor_bps = 1 + (span as u32) / 2;
    let premium_start_bps = 10 + span as u32;
    if premium_start_bps >= 10_000 || premium_floor_bps > premium_start_bps {
        return;
    }
    let auction_duration = u64::from(input.shape.auction_duration % 3_600) + 1;
    let offered = (i128::from(input.shape.offered % 5_000) + 200) * XLM;
    let min_fill = (offered * i128::from(input.shape.min_fill_pct % 60) / 100).max(1);

    let params = EpochParams {
        // §1: `auction_duration <= epoch_duration / 24` and `min_idle_gap >= epoch_duration / 50`.
        epoch_duration: auction_duration * 24 + 50,
        auction_duration,
        min_idle_gap: (auction_duration * 24 + 50) / 50 + 1,
        strike_bps_otm: 300,
        premium_start_bps,
        premium_floor_bps,
        twap_window: 10,
        guard_window: 20,
        max_staleness: 30,
        max_deviation_bps: 100,
        oracle_dead_after: 60,
        settle_grace: 10,
        unresolved_after: 240,
        min_fill,
        min_deposit: 10 * XLM,
        settle_bounty_bps: 25,
    };

    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_800_000_000);
    env.cost_estimate().budget().reset_unlimited();

    let admin = Address::generate(&env);
    let oracle = env.register(mock_price_source::MockPriceSource, (admin.clone(), 14u32));
    let asset = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let prime = |now: u64| {
        let o = mock_price_source::MockPriceSourceClient::new(&env, &oracle);
        o.fill(&now, &40, &(4_000_000i128 * 10_000_000));
        o.set_expires(&Some(now + 10_000_000));
    };
    prime(env.ledger().timestamp());

    // A parameter set the constructor refuses tests the constructor, not the auction.
    let Ok(vault) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(
            AntaresVault,
            (
                admin.clone(),
                asset.clone(),
                oracle.clone(),
                admin.clone(),
                params.clone(),
                String::from_str(&env, "-G"),
                10_000_000 * XLM,
                100u32,
                5_000u32,
                0u64,
            ),
        )
    })) else {
        return;
    };

    let c = AntaresVaultClient::new(&env, &vault);
    let sac = StellarAssetClient::new(&env, &asset);
    let bidders: Vec<Address> = (0..BIDDERS).map(|_| Address::generate(&env)).collect();
    let depositor = Address::generate(&env);
    sac.mint(&depositor, &(offered * 2));
    for b in &bidders {
        sac.mint(b, &(1_000_000 * XLM));
    }

    if c.try_deposit(&depositor, &offered).is_err() {
        return;
    }
    // The gap, then the open. The test ledger starts far from zero but `last_finalize_time` is 0,
    // so the first open is ungated; the jump is what makes the feed fresh at the open's anchor.
    let opened_at = env.ledger().timestamp() + 60;
    env.ledger().set_timestamp(opened_at);
    prime(opened_at);
    if c.try_open_epoch().is_err() {
        return;
    }
    let st0 = env.as_contract(&vault, || antares_vault::storage::get_state(&env).unwrap());
    if st0.phase != Phase::Auction {
        return;
    }

    let mut last_ts = opened_at;
    for bid in &input.bids {
        // Boundary timestamps are the point: `at % (auction_duration + 2)` reaches the last
        // admissible second, `auction_end` itself, and one past it — where `bid` must answer
        // `WrongPhase` rather than fill at the floor.
        let offset = u64::from(bid.at) % (auction_duration + 2);
        let ts = opened_at + offset;
        if ts >= last_ts {
            env.ledger().set_timestamp(ts);
            prime(ts);
            last_ts = ts;
        }

        let who = &bidders[usize::from(bid.who) % BIDDERS];
        let st = env.as_contract(&vault, || antares_vault::storage::get_state(&env).unwrap());
        let remaining = st.notional_offered - st.notional_sold;
        let requested = st.notional_offered * i128::from(bid.part) / 100;

        let before_sold = st.notional_sold;
        let filled = c
            .try_bid(who, &requested, &u32::from(bid.max_bps))
            .ok()
            .and_then(|r| r.ok());

        let st = env.as_contract(&vault, || antares_vault::storage::get_state(&env).unwrap());

        // ---- I2, after every bid including every rejected one. ----------------------------------
        assert!(
            st.notional_sold <= st.notional_offered && st.notional_offered <= st.locked_at_open,
            "I2 violated: sold {} offered {} locked_at_open {}",
            st.notional_sold,
            st.notional_offered,
            st.locked_at_open
        );

        if let Some(filled) = filled {
            // ---- The sliver rule. -----------------------------------------------------------
            //
            // A fill under `min_fill` is admissible **only** when it exactly empties the offer.
            // Stated as an implication rather than as two branches, because the failure being
            // hunted is a fill that is small *and* leaves a remainder — which is the shape an
            // off-by-one in the exception produces.
            assert!(
                filled >= st.params.min_fill || filled == remaining,
                "sliver rule violated: filled {filled} is below min_fill {} and did not empty the \
                 offer (remaining was {remaining})",
                st.params.min_fill
            );
            assert!(
                filled > 0 && filled <= remaining,
                "a fill of {filled} against a remainder of {remaining}"
            );
            assert_eq!(
                st.notional_sold - before_sold,
                filled,
                "notional_sold moved by something other than the fill"
            );
        } else {
            assert_eq!(
                st.notional_sold, before_sold,
                "a rejected bid moved notional_sold"
            );
        }

        // ---- Premium exactness: `premium_collected == Σ fills`. ----------------------------
        //
        // Recomputed from the `Fill` records rather than tracked alongside. A running total kept
        // here would have lost a premium in the same way the contract lost it, and agreed.
        let summed: i128 = bidders
            .iter()
            .filter_map(|b| {
                env.as_contract(&vault, || {
                    antares_vault::storage::get_fill(&env, st.round, b)
                })
            })
            .map(|f| f.premium_paid)
            .sum();
        assert_eq!(
            st.premium_collected, summed,
            "premium accounting broke: state says {} and the fills sum to {summed}",
            st.premium_collected
        );

        let sold: i128 = bidders
            .iter()
            .filter_map(|b| {
                env.as_contract(&vault, || {
                    antares_vault::storage::get_fill(&env, st.round, b)
                })
            })
            .map(|f| f.notional)
            .sum();
        assert_eq!(
            st.notional_sold, sold,
            "notional accounting broke: state says {} and the fills sum to {sold}",
            st.notional_sold
        );
    }
});
