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

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    token::StellarAssetClient,
    Address, Env, String,
};

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
    deploy_into(Env::default())
}

/// The same vault on an `Env` that writes **no** test snapshot when it drops. For the property
/// suite, and for nothing else.
///
/// Soroban writes `test_snapshots/{test}.N.json` on every `Env` drop. For a deterministic test
/// that file is a record worth keeping — the footprint and the budget of a fixed sequence, which
/// changes only when the contract does. For a *generated* test it is the opposite: proptest builds
/// a fresh random call sequence on every run, so the file records one arbitrary sequence and is
/// rewritten wholesale by the next `cargo test` that touches it.
///
/// Measured before turning it off: the three property tests rewrote **145 files, ~100 000 lines**
/// of tracked JSON per run. That is enough churn to bury a real diff, and it was introduced by the
/// commit that added the property suite (1ba23a7) — so the noise is removed here rather than
/// hidden behind a `.gitignore`, which would leave the files being written and merely stop anyone
/// from seeing it.
pub fn deploy_no_snapshot() -> Deployed {
    deploy_into(Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    }))
}

fn deploy_into(env: Env) -> Deployed {
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let oracle = env.register(mock_price_source::MockPriceSource, (admin.clone(), 14u32));

    // A **real** Stellar Asset Contract, not a generated address. The accounting
    // is only worth as much as the transfers behind it, and a stub asset would
    // let every balance assertion pass while no XLM moved.
    let asset = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

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

impl Deployed {
    /// Fund an address with XLM, the way a faucet would.
    pub fn fund(&self, to: &Address, amount: i128) {
        StellarAssetClient::new(&self.env, &self.asset).mint(to, &amount);
    }

    /// What the SAC says, not what the vault believes — the two agreeing is the
    /// whole point of testing against a real asset.
    pub fn balance(&self, of: &Address) -> i128 {
        soroban_sdk::token::TokenClient::new(&self.env, &self.asset).balance(of)
    }

    pub fn client(&self) -> crate::AntaresVaultClient<'_> {
        crate::AntaresVaultClient::new(&self.env, &self.vault)
    }

    pub fn user(&self, funded: i128) -> Address {
        let a = Address::generate(&self.env);
        self.fund(&a, funded);
        a
    }

    /// Put the vault into a live round **by writing `State` directly**.
    ///
    /// `open_epoch` is DEV2's and lands with IP-2; until it does there is no
    /// other way to reach `Auction` or `Active`, and the accounting paths that
    /// only exist during a live round would otherwise go untested until then.
    /// What this cannot prove is that `open_epoch` produces *this* state — so
    /// every test built on it is re-run against the real opener at IP-2, and
    /// that is recorded in the standup rather than assumed.
    pub fn open_round_manually(&self, round: u32, phase: crate::types::Phase, auction_end: u64) {
        self.env.as_contract(&self.vault, || {
            let mut st = crate::storage::get_state(&self.env).unwrap();
            st.round = round;
            st.phase = phase;
            st.params = valid_params();
            st.opened_at = self.env.ledger().timestamp();
            st.auction_end = auction_end;
            st.expiry = auction_end + 1_000;
            st.locked_at_open = st.locked_assets;
            st.shares_snapshot = st.shares_outstanding;
            st.notional_offered = st.locked_assets;
            st.notional_sold = 0;
            st.premium_collected = 0;
            st.burned_this_round = 0;
            crate::storage::set_state(&self.env, &st);
        });
    }

    pub fn advance(&self, seconds: u64) {
        let t = self.env.ledger().timestamp();
        self.env.ledger().set_timestamp(t + seconds);
    }

    pub fn state(&self) -> crate::types::State {
        self.env.as_contract(&self.vault, || {
            crate::storage::get_state(&self.env).unwrap()
        })
    }
}
