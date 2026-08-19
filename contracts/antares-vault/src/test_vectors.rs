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
use std::{format, fs, vec};

use serde_json::{json, Map, Value};

use crate::auction::{fill_amount, premium_bps, premium_for_fill};
use crate::claims::{payout_for_fill, refund_for_fill};
use crate::settle::round_numbers;
use crate::types::{EpochParams, Phase, State};
use crate::vault::finalize_numbers;

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
    // Per-bid outcomes, in order. **A rejection is an entry here, not a separate list** — matching
    // `curve_ref`'s representation, which keeps the list total: every bid has an entry, in
    // sequence, and "bid 3 was rejected" is visible where bid 3 is.
    //
    // §5's schema specifies `expected.rejects: [{bid, code}]` for a *vector's declared* output. It
    // does not specify the replay document's layout — a gap my own invocation contract left open,
    // and the generated corpus is what surfaced it, because four hand-written vectors contained no
    // rejection at all. The two sides have to agree on one wire format or the diff compares
    // nothing; agreeing a serialization is not taking a disagreement to the other side's source,
    // and no arithmetic moves for it.
    let mut per_bid: StdVec<Value> = vec![];
    // Insertion-ordered by first fill, which is what a re-bid accumulating into one record means.
    let mut order: StdVec<StdString> = vec![];
    let mut fills: std::collections::BTreeMap<StdString, (i128, i128)> =
        std::collections::BTreeMap::new();

    let empty = vec![];
    let bids = vector["bids"].as_array().unwrap_or(&empty);
    for bid in bids.iter() {
        let bidder = bid["bidder"].as_str().expect("bid.bidder").to_string();
        let now = u64_at(bid, "at");
        let requested = i128_at(bid, "requested");
        let max_premium_bps = u32_at(bid, "max_premium_bps");

        // `bid`'s guard order, restricted to the guards a vector can express: the curve-arithmetic
        // ones plus `WrongPhase` and `InvalidAmount`. `Paused`, `AllowlistForbidden`, `InTheMoney`
        // and `OracleUnreachable` read state a vector does not carry and are pinned by unit tests
        // instead (06-TEST-PLAN §5) — a replay that invented values for them would be diffing its
        // own fixture.
        let outcome: Result<(i128, u32, i128), &str> = (|| {
            if requested <= 0 {
                return Err("InvalidAmount");
            }
            if now < state.opened_at || now >= state.auction_end {
                return Err("WrongPhase");
            }
            if state.phase != Phase::Auction {
                return Err("WrongPhase");
            }
            let p = premium_bps(&state, now);
            if p > max_premium_bps {
                return Err("PremiumAboveMax");
            }
            let remaining = state.notional_offered - state.notional_sold;
            let filled = fill_amount(requested, remaining);
            if filled == 0 {
                // Matches `auction.rs` after error 33's retirement: the refusal
                // stays, the code it reports does not.
                return Err("WrongPhase");
            }
            if filled < state.params.min_fill && filled != remaining {
                return Err("BelowMinFill");
            }
            let premium = premium_for_fill(filled, p).expect("premium");
            if premium == 0 {
                return Err("ZeroPremium");
            }
            Ok((filled, p, premium))
        })();

        match outcome {
            Err(code) => per_bid.push(json!({ "bidder": bidder, "reject": code })),
            Ok((filled, p, premium)) => {
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
        }
    }

    // **Sorted by bidder, not in first-fill order — and the distinction is the wire-format rule
    // the corpus forced out of hiding.** `bids` is a *sequence* and keeps its order, because "bid 3
    // was rejected" is only meaningful in position. `fills` is an *aggregate* over bidders, so its
    // order carries no information and has to be canonical or the two sides diverge on 4 vectors
    // out of 204 with byte-identical contents. My own invocation contract in 06-TEST-PLAN §5 said
    // "keys sorted" and said nothing about arrays, which is the gap.
    //
    // `order` is retained rather than deleted: it is what makes the accumulation a per-bidder
    // aggregate rather than a per-bid list in the first place.
    let mut sorted_bidders = order.clone();
    sorted_bidders.sort();
    let accumulated: StdVec<Value> = sorted_bidders
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
        "sold_out": state.notional_sold == state.notional_offered,
    })
}

/// Replay the settlement section through **DEV2's `round_numbers` and DEV1's `finalize_numbers`**.
///
/// Both are pure and total — they were lifted out of `close_round` and `finalize_round` precisely
/// so a harness could reach them, which is the same argument that pulled `fill_amount` out of `bid`
/// and `payout_for_fill` out of `claim_payout`. Nothing here reimplements arithmetic.
///
/// **What this replay does contribute is the four-branch dispatch**, and that is worth naming
/// rather than glossing. `round_numbers` covers the two branches that have closed forms — settle
/// (`Some(spot)`) and unresolved (`None`, payout pinned to 0). Void and lapse have no pure function
/// to call because `finalize_round` mutates state, so their constants come from §5's own call-site
/// table: `pps` unchanged at `last_pps`, `assets_after = locked_at_open`, and payout, fee and
/// bounty all zero. A void refunds the premium in full, so there is nothing to take a fee on and a
/// bounty would have no source (D-51); a lapse has no premium at all.
///
/// **`finalize_numbers` runs on all four**, which is the part that matters: `wclaims` and
/// `locked_after` are the subtraction D-32 and D-66 both turned on, and §5 is emphatic that one
/// function serves every branch because forgetting it in one is a solvency bug rather than a style
/// one. Diffing it on all four is what this section is for.
///
/// This is the one module where the Python and the Rust harness are both DEV3's. The derivations
/// were still independent — `settle_ref.py` was written from §5–§6 before `settle.rs` existed on
/// any ref, frozen at blob `6b31a19`, and the freeze is checkable. The wiring does not contaminate
/// that. But the temptation is a different shape here: a disagreement would be one I could resolve
/// from memory of my own Python. It goes to 02-CONTRACT-SPEC §5–§6 and 05 §4, or to Tamer.
fn replay_settle(vector: &Value, curve: &Value) -> Value {
    let params = &vector["params"];
    let initial = &vector["initial"];
    let kind = vector["outcome"]["kind"].as_str().unwrap_or("");

    let locked_at_open = i128_at(initial, "locked");
    let shares_snapshot = i128_at(initial, "shares");
    let last_pps = i128_at(initial, "pps");
    let notional_sold = i128::from(curve["notional_sold"].as_i64().expect("notional_sold"));
    let premium_collected = i128::from(curve["premium_collected"].as_i64().expect("premium"));
    let strike = i128_at(&vector["open"], "strike");
    let fee_bps = u32_at(params, "fee_bps");
    let bounty_bps = u32_at(params, "settle_bounty_bps");

    let empty = vec![];
    let burned: i128 = vector["burns"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|b| i128_at(b, "shares"))
        .sum();

    let (payout_total, fee, bounty, assets_r, pps) = match kind {
        "settled" | "unresolved" => {
            let spot = if kind == "settled" {
                Some(i128::from(
                    vector["outcome"]["spot"]
                        .as_i64()
                        .expect("settled needs a spot"),
                ))
            } else {
                None
            };
            let n = round_numbers(
                spot,
                strike,
                notional_sold,
                locked_at_open,
                premium_collected,
                shares_snapshot,
                fee_bps,
                bounty_bps,
            )
            .expect("round_numbers");
            (n.payout_total, n.fee, n.bounty, n.assets_r, n.pps)
        }
        // §5's call-site table: both leave `pps` at `last_pps` and `assets_after` at
        // `locked_at_open`, and neither takes a fee or a bounty.
        _ => (0, 0, 0, locked_at_open, last_pps),
    };

    let (wclaims, locked_after) =
        finalize_numbers(burned, pps, assets_r).expect("finalize_numbers");

    json!({
        // `assets_R` with a capital R, matching `settle_ref.py`'s key and §5's own notation. The
        // Rust struct field is `assets_r` because Rust is snake_case; the wire name is the spec's.
        "assets_R": i64::try_from(assets_r).expect("fits i64"),
        "bounty": i64::try_from(bounty).expect("fits i64"),
        "fee": i64::try_from(fee).expect("fits i64"),
        "locked_after": i64::try_from(locked_after).expect("fits i64"),
        "payout_total": i64::try_from(payout_total).expect("fits i64"),
        "pps": i64::try_from(pps).expect("fits i64"),
        "wclaims": i64::try_from(wclaims).expect("fits i64"),
    })
}

/// Replay the bidder half of the claims section through `claims.rs`'s own functions.
///
/// **`per_bidder` only.** `claims_ref.py` also produces `withdraw_claims`, which is
/// `claim_withdraw`'s arithmetic — DEV1's, and it needs `pps` from a settle replay that does not
/// exist yet. Computing that formula here instead would be a **third** derivation of it, diffed by
/// nothing, which is the objection that kept the curve out of `views.rs`. `coverage.json` declares
/// the path rather than the section for exactly this reason.
///
/// Order follows the vector's fills, which is what `claims_ref` iterates, so the two documents are
/// comparable element by element rather than as sets.
///
/// A zero amount is **listed, not omitted**: §12 distinguishes an address owed nothing (a zeroed
/// `BidderPosition`) from one that was never there (`RoundNotFound`), and collapsing the two would
/// make an out-of-the-money settled round indistinguishable from a lapse.
fn replay_claims(vector: &Value, curve: &Value, settle: &Value) -> Value {
    let outcome = vector["outcome"]["kind"].as_str().unwrap_or("");
    let strike = i128_at(&vector["open"], "strike");
    let spot = vector["outcome"]
        .get("spot")
        .and_then(Value::as_i64)
        .map(i128::from)
        .unwrap_or(0);

    // The previous stage's product, never the vector's `expected` block. Reading the hand-written
    // answer here is exactly the break DEV3 raised against `claims_ref` last block, and it would be
    // no better on this side of the diff.
    let empty = vec![];
    let fills = curve["fills"].as_array().unwrap_or(&empty);

    let mut per_bidder: StdVec<Value> = vec![];
    for fill in fills {
        let bidder = fill["bidder"].as_str().expect("bidder").to_string();
        let notional = i128::from(fill["notional"].as_i64().expect("notional"));
        let premium_paid = i128::from(fill["premium_paid"].as_i64().expect("premium_paid"));

        let amount = match outcome {
            "settled" => payout_for_fill(notional, spot, strike).expect("payout"),
            "voided" => refund_for_fill(premium_paid),
            // **Unresolved and lapsed owe the bidder nothing, and "nothing" is `0` listed rather
            // than an omission.** This skipped them until the corpus caught it, on 11 vectors where
            // the curve section agreed — so it was a defect of mine, not a spec question.
            //
            // The resolution is §12's, the same one that corrected vector 2's expected block: a
            // zeroed `BidderPosition` is the answer for an address owed nothing and `RoundNotFound`
            // for one that was never there, so omitting here would make "filled and owed nothing"
            // indistinguishable from "never filled". D-59 makes an unresolved round the
            // out-of-the-money outcome — premium retained by depositors, payout zero — so a bidder
            // in one is owed exactly nothing, which is a fact worth stating rather than a row to
            // drop. `per_bidder` reports what is owed, not which call succeeds; the contract
            // separately answers `WrongOutcome` on both claim paths for such a round.
            //
            // A lapse reaches this arm only vacuously: `notional_sold == 0` means no fills.
            _ => 0,
        };
        per_bidder.push(json!({
            "bidder": bidder,
            "amount": i64::try_from(amount).expect("amount fits i64"),
        }));
    }

    // **`withdraw_claims` unblocks behind the settle replay**, because it was only ever waiting on
    // `pps`. One claim per recorded burn, in vector order, matching `claims_ref`.
    //
    // The amount is `⌊shares × pps / PRECISION⌋` — and it is computed by calling DEV1's
    // `finalize_numbers` with this depositor's share count rather than by writing the formula here.
    // `wclaims` is the same expression over the round's total burn, so their function *is* the
    // shipped arithmetic; writing `mul_div_floor(shares, pps, PRECISION)` in this file instead
    // would be a third derivation of it, diffed by nothing. `assets_after` is passed large enough
    // that the subtraction cannot bind, since only the first element of the pair is used.
    let pps = i128::from(settle["pps"].as_i64().expect("pps"));
    let mut withdraw_claims: StdVec<Value> = vec![];
    for burn in vector["burns"].as_array().unwrap_or(&empty) {
        let shares = i128_at(burn, "shares");
        let (amount, _) = finalize_numbers(shares, pps, i128::MAX / 2).expect("withdraw claim");
        withdraw_claims.push(json!({
            "amount": i64::try_from(amount).expect("fits i64"),
            "shares": i64::try_from(shares).expect("fits i64"),
        }));
    }

    json!({ "per_bidder": per_bidder, "withdraw_claims": withdraw_claims })
}

fn vector_dir() -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR is contracts/antares-vault.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-vectors")
        .canonicalize()
        .expect("test-vectors/ must exist beside the contracts")
}

fn replay_all() -> Value {
    // Hand-written first, then the generated corpus, each sorted — **the same traversal
    // `run_vectors.py::load_vectors` performs.** The two documents are compared element by element,
    // so a different order is a false divergence; and a diff that fails because of filesystem
    // iteration order fails for the wrong reason on someone else's machine.
    //
    // An absent or empty `generated/` is not a failure: the corpus is built on demand with
    // `ANTARES_VECTOR_DUMP` and is not committed, because it is proptest output and differs every
    // run.
    let root = vector_dir();
    let mut paths: StdVec<std::path::PathBuf> = vec![];
    for dir in [root.clone(), root.join("generated")] {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut batch: StdVec<std::path::PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            // `coverage.json` shares the directory because both sides read it; it is not a vector.
            .filter(|p| p.file_name().is_some_and(|n| n != "coverage.json"))
            .collect();
        batch.sort();
        paths.extend(batch);
    }
    assert!(!paths.is_empty(), "no vectors found");

    let mut out: StdVec<Value> = vec![];
    for path in paths {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let vector: Value = serde_json::from_str(&fs::read_to_string(&path).expect("read"))
            .unwrap_or_else(|e| panic!("{name} is not valid JSON: {e}"));
        let curve = replay_curve(&vector);
        let settle = replay_settle(&vector, &curve);
        let mut entry = Map::new();
        entry.insert(
            "claims_ref".to_string(),
            replay_claims(&vector, &curve, &settle),
        );
        entry.insert("curve_ref".to_string(), curve);
        entry.insert("settle_ref".to_string(), settle);
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
/// The sections `test-vectors/coverage.json` declares both sides can produce.
fn declared_sections() -> StdVec<StdString> {
    let path = vector_dir().join("coverage.json");
    let manifest: Value =
        serde_json::from_str(&fs::read_to_string(path).expect("coverage.json is readable"))
            .expect("coverage.json is valid JSON");
    manifest["sections"]
        .as_array()
        .expect("coverage.json has a sections array")
        .iter()
        .map(|v| v.as_str().expect("section names are strings").to_string())
        .collect()
}

#[test]
fn vector_replay() {
    let document = replay_all();

    // **The scope of the diff is one committed fact, and this is half of what keeps it true.**
    // What this file emits must be exactly what `coverage.json` declares, so adding a replay
    // without widening the manifest fails here — and widening the manifest without adding the
    // replay fails the diff itself. Neither side can drift from it silently, which a
    // hand-maintained scope would not give.
    let mut declared = declared_sections();
    declared.sort();
    for entry in document.as_array().expect("array") {
        // Paths, not top-level keys: `claims_ref.per_bidder` is declared and
        // `claims_ref.withdraw_claims` is not, so a section-level check would pass while half the
        // section went unreplayed.
        let mut emitted: StdVec<StdString> = vec![];
        for (key, value) in entry.as_object().expect("object") {
            if key == "vector" {
                continue;
            }
            match value.as_object() {
                Some(inner) if key == "claims_ref" => {
                    for sub in inner.keys() {
                        emitted.push(format!("{key}.{sub}"));
                    }
                }
                _ => emitted.push(key.clone()),
            }
        }
        emitted.sort();
        assert_eq!(
            emitted, declared,
            "this replay emits {emitted:?} but test-vectors/coverage.json declares {declared:?} — \
             widen the manifest in the same commit as the replay that earns it"
        );
    }

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
        // A vector is named by its file name alone, matching `run_vectors.py`, so re-reading it has
        // to look in both homes: hand-written at the root, generated in `generated/`. The first
        // version of this looked only at the root and panicked on the first corpus build — which is
        // the corpus finding a defect in the code that reads the corpus.
        let root_path = dir.join(name);
        let path = if root_path.exists() {
            root_path
        } else {
            dir.join("generated").join(name)
        };
        let vector: Value =
            serde_json::from_str(&fs::read_to_string(path).expect("read")).expect("json");
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

// =================================================================================================
// The generated corpus — 06-TEST-PLAN §5's second producer
// =================================================================================================
//
// The hand-written vectors are four cases a human derived from 05 §4. This turns the same two
// independently derived implementations loose on hundreds, at no extra authoring cost: the property
// layer's strategies already know how to construct a valid round, and the differential layer
// already knows how to compare one.
//
// **`ANTARES_VECTOR_DUMP=<dir>` rather than a cargo feature**, per 06-TEST-PLAN §5 as corrected: a
// `[features]` table in a contract manifest is rejected by §8's own network-agnostic check, and a
// variable read at test runtime cannot be selected into a `--release` wasm by any invocation —
// which is the stronger property on D-50's terms. Unset, this test generates and discards, so the
// suite is unchanged for anyone not producing a corpus.
//
// **The output is not committed.** It is proptest output, so it differs every run — the same reason
// `test_snapshots/test_properties/` is untracked. A corpus is regenerated, not reviewed; what is
// reviewed is the strategy below.
//
// **Every generated vector must be one both sides accept.** `curve_ref`, `settle_ref` and
// `claims_ref` all *refuse* malformed input rather than computing a number for it, which is correct
// and means the generator has to respect the same rules `validate_params` does. Where a constraint
// below looks arbitrary it is a spec rule, and the comment says which.

use proptest::prelude::*;

/// A vector the three references will accept, as §5's document.
///
/// Amounts stay well inside `i64` because the JSON readers on both sides go through it — a
/// generator that overflowed would fail the replay for a reason that has nothing to do with the
/// arithmetic under test.
fn arb_vector() -> impl Strategy<Value = Value> {
    (
        // Curve shape. §1: `0 < floor <= start`, and the floor's lower bound is load-bearing —
        // a floor of 0 makes the curve reject every bid with `ZeroPremium` at the end of the window.
        (1u32..900, 1u64..3_600),
        // `initial`: locked and shares both positive; `open_epoch` snapshots the offer from locked.
        (
            100_000_000i64..1_000_000_000_000,
            100_000_000i64..1_000_000_000_000,
        ),
        // Price scale, 1e7 fixed point. Strike above twap by construction (`strike_bps_otm > 0`).
        (1_000_000i64..100_000_000, 100u32..3_000),
        // Fee and bounty, inside §1's caps: fee <= 2 000 bps, bounty <= 100.
        (0u32..=2_000, 0u32..=100),
        // Up to four bids, and a burn.
        prop::collection::vec((0u64..3_600, 1i64..2_000_000_000_000, 0u32..=10_000), 0..4),
        0i64..100_000_000,
        0usize..4,
    )
        .prop_map(
            |(
                (start_span, auction_duration),
                (locked, shares),
                (twap, strike_bps_otm),
                (fee_bps, settle_bounty_bps),
                bids_raw,
                burn,
                outcome_pick,
            )| {
                let premium_start_bps = start_span + 10;
                let premium_floor_bps = 1 + start_span / 2;
                // §1: `auction_duration <= epoch_duration / 24`.
                let epoch_duration = auction_duration * 24 + 1;
                let opened_at = 1_800_000_000u64;
                let strike = twap * i64::from(10_000 + strike_bps_otm) / 10_000;

                // §5: a lapse *is* `notional_sold == 0`, so a lapsed vector carries no bids —
                // `settle_ref` refuses the contradiction, correctly.
                let outcome_kind = ["settled", "voided", "unresolved", "lapsed"][outcome_pick];
                let bids: StdVec<Value> = if outcome_kind == "lapsed" {
                    vec![]
                } else {
                    bids_raw
                        .iter()
                        .map(|(offset, requested, max_bps)| {
                            json!({
                                // Inside the window: `bid` requires `now < auction_end` strictly.
                                "at": opened_at + (offset % auction_duration),
                                "bidder": format!("B{}", offset % 3),
                                "requested": requested,
                                "max_premium_bps": max_bps,
                            })
                        })
                        .collect()
                };

                // `burned_this_round <= shares_snapshot`, which is what keeps
                // `wclaims <= assets_after` and stops `locked_after` underflowing (§5).
                let burn = burn.min(shares);
                let mut outcome = Map::new();
                outcome.insert("kind".to_string(), Value::String(outcome_kind.to_string()));
                if outcome_kind == "settled" {
                    // A non-positive aggregate classifies as `DeadAtExpiry` and never reaches the
                    // settle branch (04-ORACLE §4), so a settled vector carries a positive spot.
                    outcome.insert("spot".to_string(), json!(twap.max(1)));
                }

                json!({
                    "name": "generated",
                    "params": {
                        "epoch_duration": epoch_duration,
                        "auction_duration": auction_duration,
                        "min_idle_gap": (epoch_duration / 50).max(1),
                        "strike_bps_otm": strike_bps_otm,
                        "premium_start_bps": premium_start_bps,
                        "premium_floor_bps": premium_floor_bps,
                        "twap_window": 900,
                        "guard_window": 3_600,
                        "max_staleness": 600,
                        "max_deviation_bps": 100,
                        "oracle_dead_after": 43_200,
                        "settle_grace": 7_200,
                        "unresolved_after": 75_600,
                        "min_fill": 1_000_000,
                        "min_deposit": 10_000_000,
                        "settle_bounty_bps": settle_bounty_bps,
                        "fee_bps": fee_bps,
                    },
                    "initial": { "locked": locked, "shares": shares, "pps": 10_000_000 },
                    "open": { "at": opened_at, "twap": twap, "strike": strike },
                    "bids": bids,
                    "burns": if burn > 0 { json!([{ "shares": burn }]) } else { json!([]) },
                    "outcome": Value::Object(outcome),
                })
            },
        )
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 200, max_shrink_iters: 1, ..ProptestConfig::default() })]

    /// Export every generated case into `test-vectors/generated/` when asked.
    ///
    /// `max_shrink_iters: 1` on purpose: this test does not assert a property, so there is nothing
    /// to shrink toward and shrinking would only slow a corpus build. The assertion that matters is
    /// the **diff**, which runs afterwards over everything this wrote.
    #[test]
    fn generated_vectors_are_exported_for_the_differential_layer(vector in arb_vector()) {
        if let Ok(dir) = std::env::var("ANTARES_VECTOR_DUMP") {
            let dir = std::path::PathBuf::from(dir);
            let _ = fs::create_dir_all(&dir);
            // Content-addressed, so a rebuild of the corpus overwrites rather than accumulating,
            // and two runs that generate the same case produce one file rather than two.
            let text = serde_json::to_string_pretty(&vector).expect("serialize");
            let mut hash: u64 = 1469598103934665603;
            for byte in text.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(1099511628211);
            }
            let mut out = text;
            out.push('\n');
            fs::write(dir.join(format!("gen-{hash:016x}.json")), out).expect("write vector");
        }
    }
}
