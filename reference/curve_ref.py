"""curve_ref.py — the independent reference for the auction curve and fill splitting.

Covers: `premium_bps(t)`, fill splitting, and the `min_fill` sliver rule
(`DEV-PROTOCOL.md` §4).

PROVENANCE, because this file is worth exactly as much as the discipline behind it
=================================================================================

Written by DEV1. The Rust is DEV3's (`auction.rs`) — `DEV-PROTOCOL.md` §4. D-22's rule is that the
Python author reads the **spec**, not `src/`, because a reference ported from the implementation
agrees with it by construction and catches nothing.

Derived **only** from:

  * `05-AUCTION-SETTLEMENT.md` §1 — the linear decay, the slippage guard, partial fills, the dust
    guard and its sliver exception, and the early transition on full subscription.
  * `02-CONTRACT-SPEC.md` §5 — `bid`'s numbered steps, which are where the integer forms of the
    two divisions are written.
  * `02-CONTRACT-SPEC.md` §6 — the rounding table: both divisions floor, and both floor in the
    vault's favour.
  * `02-CONTRACT-SPEC.md` §3 — the error names carried in `rejects`.
  * `02-CONTRACT-SPEC.md` §16 — the canonical order, which decides *which* rejection a call
    produces when more than one guard would fire.

Not read, and this is the load-bearing half: **`auction.rs` does not exist.** Recorded so the claim
is checkable rather than believed — at commit `a6ace99` the whole of `contracts/antares-vault/src/`
is `lib.rs`, `types.rs`, `errors.rs`, `storage.rs`, `events.rs`, `vault.rs`, `token.rs`, `admin.rs`,
`views.rs`, `epoch.rs`, `oracle.rs` and their tests. There is **no `auction.rs` and no `curve.rs` on
any branch** — `origin/dev1`, `origin/dev2`, `origin/dev3` and `origin/main` were all checked, and
none carries either file. Unlike the `claim_withdraw` slice, this module's deadline holds
completely: DEV3 begins `auction.rs` after this lands, so the Rust it mirrors could not have been
read by anybody, not merely was not read by me.

If a vector disagrees later, the disagreement goes to the spec or to the integrator. Never to the
Rust — resolving a difference by reading the implementation is how this layer stops being evidence.

WHAT THIS MODULE IS NOT
=======================

It does not decide *whether* a bid is allowed on grounds the vector cannot carry. `Paused`,
`AllowlistForbidden`, `InTheMoney` and `OracleUnreachable` all read state or the oracle, and they
are pinned by unit tests instead (`06-TEST-PLAN.md` §2). What is here is the arithmetic and the
guards that follow from it — the ones a vector *can* decide, and therefore the ones a diff can
catch: `InvalidAmount`, `WrongPhase`, `PremiumAboveMax`, `SoldOut`, `BelowMinFill`, `ZeroPremium`.

Integer arithmetic only, no floats anywhere. Every division floors. Python's `//` and Rust's `/`
agree on non-negative operands and disagree on negative ones, so every input that could carry a
sign is checked rather than assumed — a silent sign difference between the two implementations is
exactly the class of bug this layer exists to catch.
"""

BPS = 10_000


class VectorError(ValueError):
    """A malformed vector.

    Raised rather than defaulted, deliberately. A reference that substitutes a
    zero produces a number the Rust can agree with while both are wrong about the
    same thing, which is the one failure this layer cannot detect from inside.
    """


def _nonneg(name: str, value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise VectorError(f"{name} must be an integer, got {value!r}")
    if value < 0:
        raise VectorError(
            f"{name} must be non-negative, got {value}; floor division disagrees "
            "between Python and Rust on negative operands, so a signed input here "
            "would make the two implementations differ for a reason that is not "
            "the protocol's"
        )
    return value


def _positive(name: str, value: int) -> int:
    _nonneg(name, value)
    if value == 0:
        raise VectorError(f"{name} must be positive, got 0")
    return value


# =====================================================================================
# The curve
# =====================================================================================


def premium_bps(
    now: int,
    opened_at: int,
    auction_duration: int,
    premium_start_bps: int,
    premium_floor_bps: int,
) -> int:
    """`start − (start − floor) × (now − opened_at) / auction_duration`, floored.

    Linear decay (D-03), in integer arithmetic. Three properties the spec states
    and this reproduces rather than assumes:

      * monotonically non-increasing in `now`;
      * exactly `premium_start_bps` at `opened_at`;
      * exactly `premium_floor_bps` at `opened_at + auction_duration` — the
        numerator is then `(start − floor) × auction_duration`, which the division
        returns whole, so the floor introduces no error at the boundary.

    `bid` requires `now < auction_end` strictly, so the last admissible instant is
    one second short of the floor. That is *why* an uncontested auction never
    literally reaches the reserve price, which is the arithmetic behind the
    tautology D-62 had to remove from the Phase-2 clearing gate.
    """
    _nonneg("now", now)
    _nonneg("opened_at", opened_at)
    _positive("auction_duration", auction_duration)
    _nonneg("premium_start_bps", premium_start_bps)
    _nonneg("premium_floor_bps", premium_floor_bps)

    if premium_floor_bps == 0:
        raise VectorError(
            "premium_floor_bps must be positive (§1): a floor of 0 satisfies every "
            "other rule and then makes the curve reject every bid with ZeroPremium "
            "once it arrives there"
        )
    if premium_floor_bps > premium_start_bps:
        raise VectorError(
            f"premium_floor_bps {premium_floor_bps} exceeds premium_start_bps "
            f"{premium_start_bps}"
        )
    if now < opened_at:
        raise VectorError(f"now {now} precedes opened_at {opened_at}")

    elapsed = now - opened_at
    if elapsed > auction_duration:
        # Past the window the curve is not defined for a bid; `bid`'s own time
        # check rejects first. Clamping here would invent a value the contract
        # never computes.
        raise VectorError(
            f"now is {elapsed - auction_duration}s past auction_end; the curve is "
            "only evaluated inside the window"
        )

    span = premium_start_bps - premium_floor_bps
    return premium_start_bps - (span * elapsed) // auction_duration


# =====================================================================================
# Fill splitting
# =====================================================================================


def fill_amount(notional: int, notional_offered: int, notional_sold: int) -> int:
    """`min(requested, remaining)` — partial fills are the expected case (D-10)."""
    _positive("notional", notional)
    _nonneg("notional_offered", notional_offered)
    _nonneg("notional_sold", notional_sold)
    if notional_sold > notional_offered:
        raise VectorError(
            f"notional_sold {notional_sold} exceeds notional_offered "
            f"{notional_offered}; I2 forbids that state"
        )
    remaining = notional_offered - notional_sold
    return notional if notional < remaining else remaining


def premium_for_fill(filled: int, bps: int) -> int:
    """`filled × p / BPS`, floored — the error favours the bidder on the way in.

    §6 lists premium as the one inbound flow whose rounding favours the payer;
    solvency is unaffected because the vault's obligations are unchanged by
    collecting a stroop less.
    """
    _nonneg("filled", filled)
    _nonneg("bps", bps)
    return (filled * bps) // BPS


# =====================================================================================
# One bid, end to end
# =====================================================================================

#: The rejections this module can decide from a vector alone. Everything else in
#: §3's auction block reads state the vector does not carry.
REJECTS = (
    "InvalidAmount",
    "WrongPhase",
    "PremiumAboveMax",
    "BelowMinFill",
    "ZeroPremium",
)
#: `SoldOut` is deliberately absent, ruled 2026-08-19 (02-CONTRACT-SPEC §16). The phase
#: check preempts it: `filled == 0` needs `remaining == 0`, which is the state §5 step 6
#: has already left `Auction` for. Listing a reject this module cannot emit would claim
#: coverage of a guard nothing exercises — the silent-subset defect the coverage manifest
#: exists to prevent, one level down. Error 33 itself is still in the ABI and its
#: retirement is Tamer's call, not this module's.


def evaluate_bid(vector: dict) -> dict:
    """Evaluate one bid against the curve and the offer.

    Returns `{"filled": int, "premium_bps": int, "premium": int}` on acceptance, or
    `{"reject": "<Error name>"}`.

    **The order of the checks is §16's canonical order, not a convenient one**, and
    the difference is observable: more than one guard fires on some inputs, and two
    orders would disagree about which rejection the call produces. A vector that
    pins the wrong one is a vector that would make a correct implementation look
    wrong.
    """
    required = (
        "now",
        "opened_at",
        "auction_end",
        "auction_duration",
        "premium_start_bps",
        "premium_floor_bps",
        "notional",
        "max_premium_bps",
        "notional_offered",
        "notional_sold",
        "min_fill",
    )
    missing = [k for k in required if k not in vector]
    if missing:
        raise VectorError(f"vector is missing {', '.join(missing)}")

    now = vector["now"]
    notional = vector["notional"]

    # 1. `notional > 0` — before the phase and time checks, per §16.
    if not isinstance(notional, int) or isinstance(notional, bool) or notional <= 0:
        return {"reject": "InvalidAmount"}

    # 2. **The phase — which is not only the window, and that was the defect.**
    #
    #    §16's canonical order puts phase/time here, ahead of the curve and ahead of
    #    the `filled` computation. An auction leaves `Auction` two ways:
    #
    #      * **time** — `bid` requires `now < auction_end` strictly (§4), so a bid at
    #        exactly `auction_end` is late; the same instant at which lazy
    #        finalization would lapse an empty auction.
    #      * **full subscription** — §5 step 6 sets `phase = Active` *immediately* when
    #        `notional_sold == notional_offered`, inside the bid that fills the last
    #        sliver rather than at the next call.
    #
    #    This module modelled only the first, and DEV3's generated corpus found it on
    #    its first run: past full subscription the reference kept walking its own guard
    #    order and answered `SoldOut` on 107 vectors and `PremiumAboveMax` on one,
    #    where the vault answers `WrongPhase`.
    #
    #    **The single `PremiumAboveMax` is what names the bug.** Mapping `SoldOut` to
    #    `WrongPhase` would have turned 107 of 108 green and left the fault in place,
    #    because the fault is not which code the fill check returns — it is that after
    #    full subscription the phase check **preempts every later guard**, including a
    #    slippage check two steps earlier that has nothing to do with the fill.
    _nonneg("now", now)
    _nonneg("auction_end", vector["auction_end"])
    offered = _nonneg("notional_offered", vector["notional_offered"])
    sold = _nonneg("notional_sold", vector["notional_sold"])
    if now >= vector["auction_end"] or sold >= offered:
        return {"reject": "WrongPhase"}

    # 3. The curve, and the bidder's own slippage guard. Checked before anything
    #    about the offer's size, so a bidder learns the price was wrong for them
    #    before learning there was nothing left.
    bps = premium_bps(
        now,
        vector["opened_at"],
        vector["auction_duration"],
        vector["premium_start_bps"],
        vector["premium_floor_bps"],
    )
    max_premium_bps = _nonneg("max_premium_bps", vector["max_premium_bps"])
    if bps > max_premium_bps:
        return {"reject": "PremiumAboveMax"}

    # (The ITM guard sits here in §16's order. It reads the oracle, so it is a unit
    #  test's job and not a vector's — noted rather than skipped silently.)

    # 4. Fill splitting.
    filled = fill_amount(notional, vector["notional_offered"], vector["notional_sold"])
    if filled == 0:
        # **Unreachable, and raising rather than returning is the point.** Step 2 now
        # rejects `sold >= offered`, so `remaining > 0` here; `notional > 0` came from
        # step 1; therefore `min(notional, remaining) > 0`. Nothing can produce a zero
        # fill any more.
        #
        # `SoldOut` stays in `REJECTS` because §16 still lists it among the guards this
        # layer diffs, and removing it here would be this module deciding a question
        # that belongs to the spec. **Raised as an open point instead** (02-CONTRACT-SPEC
        # §16): either the vault has a reachable `SoldOut` path this module cannot see
        # from the spec, or the code is dead in both implementations. A comment claiming
        # unreachability is the shape this project keeps finding as a bug — so this is a
        # check that fails loudly if the claim is wrong, not a note asserting it is right.
        raise VectorError(
            "SoldOut is unreachable once the phase check covers full subscription "
            "(§5 step 6, §16) — reaching it means this module's own guard order is "
            "inconsistent, not that the vector is unusual"
        )

    # 5. The dust guard, and its one exception. The final sliver may be smaller
    #    than `min_fill`, because otherwise an offer whose remainder dropped below
    #    `min_fill` could never fully fill. Not a griefing vector: creating a
    #    sub-`min_fill` remainder requires a real fill of at least `min_fill`,
    #    paid for in real premium.
    min_fill = _nonneg("min_fill", vector["min_fill"])
    remaining = vector["notional_offered"] - vector["notional_sold"]
    if filled < min_fill and filled != remaining:
        return {"reject": "BelowMinFill"}

    # 6. And the sliver's own edge: a fill so small the premium floors to zero is a
    #    free option. Confirmed reachable — a one-stroop sliver at the floor.
    premium = premium_for_fill(filled, bps)
    if premium == 0:
        return {"reject": "ZeroPremium"}

    return {"filled": filled, "premium_bps": bps, "premium": premium}


def compute(vector: dict) -> dict:
    """The entry point `run_vectors.py` calls.

    One argument, unlike `claims_ref.compute(vector, settle)`: the curve consumes
    nothing another reference produces. Bids are evaluated in order against a
    running offer, because re-bids accumulate and each fill moves the remainder the
    next one sees.
    """
    if "bids" not in vector:
        raise VectorError("vector is missing bids")

    offered = _nonneg("notional_offered", vector["notional_offered"])
    sold = _nonneg("notional_sold", vector.get("notional_sold", 0))
    premium_collected = 0
    results = []
    fills: dict = {}

    for i, bid in enumerate(vector["bids"]):
        if "bidder" not in bid:
            raise VectorError(f"bids[{i}] is missing bidder")
        state = dict(bid)
        state["notional_offered"] = offered
        state["notional_sold"] = sold
        for key in (
            "opened_at",
            "auction_end",
            "auction_duration",
            "premium_start_bps",
            "premium_floor_bps",
            "min_fill",
        ):
            state.setdefault(key, vector[key])

        outcome = evaluate_bid(state)
        results.append({"bidder": bid["bidder"], **outcome})

        if "reject" in outcome:
            continue

        # Re-bids accumulate into one record per bidder — bounded per-bidder state,
        # no per-bid growth.
        prior = fills.get(bid["bidder"], {"notional": 0, "premium_paid": 0})
        fills[bid["bidder"]] = {
            "notional": prior["notional"] + outcome["filled"],
            "premium_paid": prior["premium_paid"] + outcome["premium"],
        }
        sold += outcome["filled"]
        premium_collected += outcome["premium"]

    return {
        "bids": results,
        "notional_sold": sold,
        "premium_collected": premium_collected,
        "fills": [
            {"bidder": b, **f} for b, f in sorted(fills.items(), key=lambda kv: kv[0])
        ],
        # Full subscription ends the auction early; the curve stops mattering at
        # that instant.
        "sold_out": sold == offered,
    }


# =====================================================================================
# Section gate: 05-AUCTION-SETTLEMENT §4's worked example, reproduced
# =====================================================================================
#
# The example states the two curve values and the two premiums, and — because it
# is also the first differential vector — the *time windows* those curve values
# correspond to. Reproducing the windows rather than only the premiums is what
# makes this a check on the curve rather than on two multiplications: the windows
# are where the integer floor actually bites.


def _self_check() -> None:
    XLM = 10_000_000
    setup = dict(
        opened_at=0,
        auction_duration=2_700,
        premium_start_bps=300,
        premium_floor_bps=10,
    )

    # Both endpoints are exact, and the second is the one the floor could have
    # spoiled: the numerator is (start − floor) × auction_duration, which divides
    # whole.
    assert premium_bps(now=0, **setup) == 300
    assert premium_bps(now=2_700, **setup) == 10

    # Monotonically non-increasing across the whole window.
    prev = 301
    for t in range(0, 2_701):
        p = premium_bps(now=t, **setup)
        assert p <= prev, f"curve rose at t={t}"
        prev = p

    # §4's stated windows, derived here rather than copied: the set of instants at
    # which the curve reads 120 and 40.
    window_120 = [t for t in range(0, 2_701) if premium_bps(now=t, **setup) == 120]
    window_40 = [t for t in range(0, 2_701) if premium_bps(now=t, **setup) == 40]
    assert (window_120[0], window_120[-1]) == (1_676, 1_685), window_120[:1]
    assert (window_40[0], window_40[-1]) == (2_421, 2_429), window_40[:1]

    # And the two premiums, in stroops.
    assert premium_for_fill(6_000 * XLM, 120) == 72 * XLM
    assert premium_for_fill(4_000 * XLM, 40) == 16 * XLM

    # The whole auction, through the public entry point: A then B, fully sold.
    result = compute(
        {
            **setup,
            "auction_end": 2_700,
            "min_fill": 100 * XLM,
            "notional_offered": 10_000 * XLM,
            "notional_sold": 0,
            "bids": [
                {
                    "bidder": "A",
                    "now": 1_676,
                    "notional": 6_000 * XLM,
                    "max_premium_bps": 300,
                },
                {
                    "bidder": "B",
                    "now": 2_421,
                    "notional": 4_000 * XLM,
                    "max_premium_bps": 300,
                },
            ],
        }
    )
    assert result["notional_sold"] == 10_000 * XLM
    assert result["premium_collected"] == 88 * XLM, result["premium_collected"]
    assert result["sold_out"] is True
    assert result["fills"] == [
        {"bidder": "A", "notional": 6_000 * XLM, "premium_paid": 72 * XLM},
        {"bidder": "B", "notional": 4_000 * XLM, "premium_paid": 16 * XLM},
    ]

    # The sliver rule, both ways. A remainder below min_fill is fillable only by a
    # bid that takes all of it.
    sliver = dict(
        **setup,
        auction_end=2_700,
        min_fill=100 * XLM,
        notional_offered=10_000 * XLM,
        notional_sold=9_950 * XLM,
    )
    assert compute({**sliver, "bids": [{"bidder": "C", "now": 0, "notional": 10 * XLM,
                                        "max_premium_bps": 300}]})["bids"][0]["reject"] == "BelowMinFill"
    assert "reject" not in compute({**sliver, "bids": [{"bidder": "C", "now": 0,
                                                       "notional": 50 * XLM,
                                                       "max_premium_bps": 300}]})["bids"][0]

    # ZeroPremium is reachable, which §1 asserts and this confirms: a one-stroop
    # sliver at the floor.
    dust = dict(
        **setup,
        auction_end=2_700,
        min_fill=100 * XLM,
        notional_offered=10_000 * XLM,
        notional_sold=10_000 * XLM - 1,
    )
    assert compute({**dust, "bids": [{"bidder": "D", "now": 2_699, "notional": 1,
                                      "max_premium_bps": 300}]})["bids"][0]["reject"] == "ZeroPremium"

    print("curve_ref: §4's worked example reproduced, and the sliver rule holds both ways")


if __name__ == "__main__":
    _self_check()
