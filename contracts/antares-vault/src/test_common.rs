//! Shared test fixtures.
//!
//! One definition of "a valid vault" for every test module, so that a change to
//! the admissible parameter space moves one file rather than several — and so a
//! test that fails is failing about its own subject rather than about a profile
//! that drifted.
//!
//! The profile is §1's **fast-test** set at the mock's default `resolution() = 1`:
//! `twap_window = 10`, `guard_window = 20`, `settle_grace = 10`,
//! `oracle_dead_after = 60`, `unresolved_after` inside `(235, 245]`. That interval
//! is D-69's, one tick below the `(236, 246]` published before the feed's
//! reachable depth was measured at 255 rather than 256 — a profile built on the
//! old pair sits one tick past the horizon and voids on a healthy feed.

#![allow(clippy::inconsistent_digit_grouping)]

use soroban_sdk::{testutils::Address as _, Address, Env, String};

use crate::types::EpochParams;
use crate::AntaresVault;

pub const CAP: i128 = 100_000_0000000;
pub const RENT_THRESHOLD: u32 = 100;
pub const RENT_EXTEND_TO: u32 = 5_000;

pub fn valid_params() -> EpochParams {
    EpochParams {
        epoch_duration: 2_400,
        auction_duration: 100, // == 2400 / 24, the boundary
        min_idle_gap: 48,      // == 2400 / 50, the boundary
        strike_bps_otm: 300,
        premium_start_bps: 450,
        premium_floor_bps: 40,
        twap_window: 10,
        guard_window: 20,
        max_staleness: 30,
        max_deviation_bps: 100,
        oracle_dead_after: 60,
        settle_grace: 10,
        unresolved_after: 240, // inside (235, 245] at res = 1 (D-69)
        min_fill: 100_0000000,
        min_deposit: 10_0000000,
        settle_bounty_bps: 25,
    }
}

/// `admin`, `asset` and `fee_recipient` are unread until §2.4 — deposits need the
/// asset, the setters need the admin. They are here because a fixture that
/// returns half a deployment makes every later module re-derive the other half.
#[allow(dead_code)]
pub struct Deployed {
    pub env: Env,
    pub vault: Address,
    pub oracle: Address,
    pub admin: Address,
    pub asset: Address,
    pub fee_recipient: Address,
}

/// A registered mock and a fully constructed vault.
///
/// The vault cannot be registered without the mock: `__constructor` calls
/// `supports_round`, which is why 00-ROADMAP calls the `PriceSource` mock the
/// first line of code in the project rather than a testing convenience.
pub fn deploy() -> Deployed {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let oracle = env.register(mock_price_source::MockPriceSource, (admin.clone(), 14u32));

    let vault = env.register(
        AntaresVault,
        (
            admin.clone(),
            asset.clone(),
            oracle.clone(),
            fee_recipient.clone(),
            valid_params(),
            String::from_str(&env, "-A"),
            CAP,
            RENT_THRESHOLD,
            RENT_EXTEND_TO,
            0u64,
        ),
    );

    Deployed {
        env,
        vault,
        oracle,
        admin,
        asset,
        fee_recipient,
    }
}
