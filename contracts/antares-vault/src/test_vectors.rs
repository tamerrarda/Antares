//! The Rust half of the differential layer — `06-TEST-PLAN.md` §5.
//!
//! Replays `test-vectors/*.json` through **the same functions the contract uses**, and emits the
//! canonical document `run_vectors.py` emits, so the two can be diffed byte for byte.
//!
//! # What this covers today, stated so the diff cannot overclaim
//!
//! **The `curve_ref` section only.** `curve_ref.py` (DEV1) mirrors `auction.rs` (DEV3), and both
//! now exist — which is the first pair in this project where the layer can return anything at all.
//! The `settle_ref` and `claims_ref` sections need `finalize_round` and the claim paths replayed
//! from the Rust side, and those are DEV1's and DEV2's halves of the same work.
//!
//! A partial diff is only honest if it says which part. Here that is carried two ways, both
//! checkable: the emitted document has **one section key per vector** (`curve_ref`) and nothing
//! else, so a reader sees the scope in the artifact itself; and the Python side must be asked for
//! the same subset explicitly with `run_vectors.py --only curve`, which is a flag rather than an
//! intersection computed silently. A diff that quietly compared whatever both sides happened to
//! emit would be this project's characteristic bug wearing the layer's clothes.
//!
//! # Reading discipline
//!
//! This file replays `auction.rs`, which is mine. It does **not** read `curve_ref.py`, and did not
//! while being written: the two derivations are independent and the diff is the only thing that
//! joins them. If they disagree the answer is in `02-CONTRACT-SPEC.md` §5-§6 and
//! `05-AUCTION-SETTLEMENT.md` §1, never in the other side's source.

extern crate std;

use std::string::{String as StdString, ToString};
use std::vec::Vec as StdVec;
use std::{fs, vec};

use serde_json::{json, Map, Value};

use crate::auction::{fill_amount, premium_bps, premium_for_fill};
use crate::types::{EpochParams, Phase, State};

fn u64_at(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("vector field {key} missing or not a u64"))
}

fn u32_at(v: &Value, key: &str) -> u32 {
    u32::try_from(u64_at(v, key)).expect("field out of u32 range")
}

/// Amounts are i128 stroops. JSON numbers are read through `as_i64` and widened — the vectors are
/// hand-written in stroops and no value in them approaches 2^63, so a narrower read that *failed*
/// is better than a float that silently rounded.
fn i128_at(v: &Value, key: &str) -> i128 {
    i128::from(
        v.get(key)
            .and_then(Value::as_i64)
            .unwrap_or_else(|| panic!("vector field {key} missing or not an integer")),
    )
}

fn params_from(v: &Value) -> EpochParams {
    EpochParams {
        epoch_duration: u64_at(v, "epoch_duration"),
        auction_duration: u64_at(v, "auction_duration"),
        min_idle_gap: u64_at(v, "min_idle_gap"),
        strike_bps_otm: u32_at(v, "strike_bps_otm"),
        premium_start_bps: u32_at(v, "premium_start_bps"),
        premium_floor_bps: u32_at(v, "premium_floor_bps"),
        twap_window: u64_at(v, "twap_window"),
        guard_window: u64_at(v, "guard_window"),
        max_staleness: u64_at(v, "max_staleness"),
        max_deviation_bps: u32_at(v, "max_deviation_bps"),
        oracle_dead_after: u64_at(v, "oracle_dead_after"),
        settle_grace: u64_at(v, "settle_grace"),
        unresolved_after: u64_at(v, "unresolved_after"),
        min_fill: i128_at(v, "min_fill"),
        min_deposit: i128_at(v, "min_deposit"),
        settle_bounty_bps: u32_at(v, "settle_bounty_bps"),
    }
}

/// The `State` a round opens with, from the vector's `initial` and `open` blocks.
///
/// `notional_offered`, `locked_at_open` and `shares_snapshot` are not schema fields and do not need
/// to be: `open_epoch` sets all three from `locked_assets`/`shares_outstanding` at open
/// (02-CONTRACT-SPEC §5 step 3), and mints happen only in Idle (D-06/D-18), so `initial` *is* the
/// snapshot. The same derivation `settle_ref.py` and the harness both make, independently.
fn state_from(vector: &Value) -> State {
    let params = params_from(&vector["params"]);
    let initial = &vector["initial"];
    let open = &vector["open"];
    let opened_at = u64_at(open, "at");

    State {
        round: 1,
        phase: Phase::Auction,
        auction_end: opened_at + params.auction_duration,
        expiry: opened_at + params.epoch_duration,
        opened_at,
        fee_bps_snapshot: u32_at(&vector["params"], "fee_bps"),
        feed_decimals: 14,
        strike: i128_at(open, "strike"),
        open_twap: i128_at(open, "twap"),
        notional_offered: i128_at(initial, "locked"),
        notional_sold: 0,
        premium_collected: 0,
        locked_at_open: i128_at(initial, "locked"),
        shares_snapshot: i128_at(initial, "shares"),
        burned_this_round: 0,
        locked_assets: i128_at(initial, "locked"),
        shares_outstanding: i128_at(initial, "shares"),
        last_pps: i128_at(initial, "pps"),
        last_settled_spot: 0,
        last_finalize_time: 0,
        pending_deposits_total: 0,
        withdraw_claimable_total: 0,
        bidder_claimable_total: 0,
        fee_claimable: 0,
        params,
    }
}

/// Replay one vector's bids through `auction.rs`'s own functions.
///
/// The guard order is `bid`'s, restricted to the guards a vector can express: the curve-arithmetic
/// ones plus `WrongPhase` and `InvalidAmount`. `Paused`, `AllowlistForbidden`, `InTheMoney` and
/// `OracleUnreachable` read state a vector does not carry and are pinned by unit tests instead —
/// 06-TEST-PLAN §5 says exactly that, and a replay that invented values for them would be diffing
/// its own fixture.
fn replay_curve(vector: &Value) -> Value {
    let mut state = state_from(vector);
    let mut per_bid: StdVec<Value> = vec![];
    let mut rejects: StdVec<Value> = vec![];
    // Insertion-ordered by first fill, which is what a re-bid accumulating into one record means.
    let mut order: StdVec<StdString> = vec![];
    let mut fills: std::collections::BTreeMap<StdString, (i128, i128)> =
        std::collections::BTreeMap::new();

    let empty = vec![];
    let bids = vector["bids"].as_array().unwrap_or(&empty);
    for (index, bid) in bids.iter().enumerate() {
        let bidder = bid["bidder"].as_str().expect("bid.bidder").to_string();
        let now = u64_at(bid, "at");
        let requested = i128_at(bid, "requested");
        let max_premium_bps = u32_at(bid, "max_premium_bps");

        let mut reject = |code: &str| {
            rejects.push(json!({ "bid": index, "code": code }));
        };

        if requested <= 0 {
            reject("InvalidAmount");
            continue;
        }
        if now < state.opened_at || now >= state.auction_end {
            reject("WrongPhase");
            continue;
        }
        if state.phase != Phase::Auction {
            reject("WrongPhase");
            continue;
        }

        let p = premium_bps(&state, now);
        if p > max_premium_bps {
            reject("PremiumAboveMax");
            continue;
        }

        let remaining = state.notional_offered - state.notional_sold;
        let filled = fill_amount(requested, remaining);
        if filled == 0 {
            reject("SoldOut");
            continue;
        }
        if filled < state.params.min_fill && filled != remaining {
            reject("BelowMinFill");
            continue;
        }
        let premium = premium_for_fill(filled, p).expect("premium");
        if premium == 0 {
            reject("ZeroPremium");
            continue;
        }

        let entry = fills.entry(bidder.clone()).or_insert_with(|| {
            order.push(bidder.clone());
            (0, 0)
        });
        entry.0 += filled;
        entry.1 += premium;

        state.notional_sold += filled;
        state.premium_collected += premium;
        if state.notional_sold == state.notional_offered {
            state.phase = Phase::Active;
        }

        per_bid.push(json!({
            "bidder": bidder,
            "filled": i64::try_from(filled).expect("filled fits i64"),
            "premium": i64::try_from(premium).expect("premium fits i64"),
            "premium_bps": p,
        }));
    }

    let accumulated: StdVec<Value> = order
        .iter()
        .map(|bidder| {
            let (notional, premium_paid) = fills[bidder];
            json!({
                "bidder": bidder,
                "notional": i64::try_from(notional).expect("notional fits i64"),
                "premium_paid": i64::try_from(premium_paid).expect("premium fits i64"),
            })
        })
        .collect();

    json!({
        "bids": per_bid,
        "fills": accumulated,
        "notional_sold": i64::try_from(state.notional_sold).expect("fits i64"),
        "premium_collected": i64::try_from(state.premium_collected).expect("fits i64"),
        "rejects": rejects,
        "sold_out": state.notional_sold == state.notional_offered,
    })
}

fn vector_dir() -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR is contracts/antares-vault.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-vectors")
        .canonicalize()
        .expect("test-vectors/ must exist beside the contracts")
}

fn replay_all() -> Value {
    let mut paths: StdVec<_> = fs::read_dir(vector_dir())
        .expect("test-vectors/ is readable")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    // Sorted, so the document does not depend on directory order — a diff that fails because of
    // filesystem iteration order fails for the wrong reason on someone else's machine.
    paths.sort();
    assert!(!paths.is_empty(), "no vectors found");

    let mut out: StdVec<Value> = vec![];
    for path in paths {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let vector: Value = serde_json::from_str(&fs::read_to_string(&path).expect("read"))
            .unwrap_or_else(|e| panic!("{name} is not valid JSON: {e}"));
        let mut entry = Map::new();
        entry.insert("curve_ref".to_string(), replay_curve(&vector));
        entry.insert("vector".to_string(), Value::String(name));
        out.push(Value::Object(entry));
    }
    Value::Array(out)
}

/// Emit the canonical document, or check it against the vectors' own numbers.
///
/// `ANTARES_VECTOR_OUT=<path>` writes the document for the CI diff. **An environment variable
/// rather than a cargo feature**, because a `[features]` table in a contract manifest is rejected
/// by 06-TEST-PLAN §8's own network-agnostic check — and a variable read at test runtime cannot be
/// selected into a `--release` wasm by any invocation, which is the stronger property on D-50's own
/// terms.
#[test]
fn vector_replay() {
    let document = replay_all();

    if let Ok(path) = std::env::var("ANTARES_VECTOR_OUT") {
        let mut text = serde_json::to_string_pretty(&document).expect("serialize");
        text.push('\n');
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&path, text).expect("write the canonical document");
        std::println!("wrote {path}");
        return;
    }

    // Without the variable, `cargo test` still has to mean something: pin the replay against each
    // vector's own `expected.fills`, which are numbers a human derived from 05 §4.
    let dir = vector_dir();
    for entry in document.as_array().expect("array") {
        let name = entry["vector"].as_str().unwrap();
        let vector: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(name)).expect("read")).expect("json");
        let Some(want) = vector.get("expected").and_then(|e| e.get("fills")) else {
            continue;
        };
        let got = entry["curve_ref"]["bids"].as_array().expect("bids");
        let want = want.as_array().expect("expected.fills");
        assert_eq!(got.len(), want.len(), "{name}: fill count");
        for (g, w) in got.iter().zip(want.iter()) {
            assert_eq!(g["bidder"], w["bidder"], "{name}: bidder");
            assert_eq!(g["filled"], w["filled"], "{name}: filled");
            assert_eq!(g["premium"], w["premium"], "{name}: premium");
            // §5's schema calls it `premium_bps_at`; both references emit `premium_bps`.
            assert_eq!(g["premium_bps"], w["premium_bps_at"], "{name}: premium_bps");
        }
    }
}
