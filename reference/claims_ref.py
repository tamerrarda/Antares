"""claims_ref.py — the independent reference for the three claim paths.

Covers: per-bidder payout, exact refund, and the withdraw claim (`06-TEST-PLAN.md` §5).

PROVENANCE, because this file is worth exactly as much as the discipline behind it
=================================================================================

Written by DEV2. The Rust is DEV3's (`claims.rs`) and DEV1's (`vault.rs`'s claim path) —
`DEV-PROTOCOL.md` §4. D-22's rule is that the Python author reads the **spec**, not `src/`, because
a reference ported from the implementation agrees with it by construction and catches nothing.

Derived **only** from:

  * `02-CONTRACT-SPEC.md` §5 — "Bidder claims" and the `claim_withdraw` bullet under
    "Deposits and withdrawals". These are the three formulas.
  * `02-CONTRACT-SPEC.md` §6 — the rounding table: which direction each division floors in and who
    the error favours. (**Not** §7. That is "Price units" and was cited for this module in error
    once already; `06-TEST-PLAN.md` §5 records the correction.)
  * `05-AUCTION-SETTLEMENT.md` §4 — the worked example, reproduced by hand at the bottom of this
    file. That reproduction is this module's section gate.
  * `06-TEST-PLAN.md` §5 — the vector schema and the invocation contract.

Not read, and this is the load-bearing half: **`claims.rs` and `vault.rs` do not exist.** Recorded
so the claim is checkable rather than believed — at commit `3663244` the whole of
`contracts/antares-vault/src/` is `lib.rs`, `types.rs`, `errors.rs` and `test_types.rs`. There is
no `claims.rs` and no `vault.rs` on any branch this worktree can see, and no branch of another
developer was fetched or read while writing this. The one slice where the *deadline* cannot hold is
named in `06-TEST-PLAN.md` §5 — `claim_withdraw` merges in Phase 2 while this file is written in
Phase 3 — so for that third the protection is the reading rule alone. It held: the file did not
exist to read.

If a vector disagrees later, the disagreement goes to the spec or to the integrator. Never to the
Rust — resolving a difference by reading the implementation is how this layer stops being evidence.

WHAT THIS MODULE IS NOT
=======================

It does not decide *whether* a claim is allowed — phase, pause, allowlist, double-claim and
`RoundNotFound` are state the vector does not carry, and they belong to unit tests. This computes
**amounts**, given an outcome and the round's recorded numbers.

Integer arithmetic only, no floats anywhere. Every division here is floor division; Python's `//`
and Rust's `/` agree on non-negative operands and disagree on negative ones, so every input that
could carry a sign is checked rather than assumed — a silent sign difference between the two
implementations is exactly the class of bug this layer exists to catch.
"""

from __future__ import annotations

# --------------------------------------------------------------------------------------------
# Constants (02-CONTRACT-SPEC §1)
# --------------------------------------------------------------------------------------------

PRECISION = 10_000_000  # pps scale, 1e7

#: The four terminal outcomes a round can record (02-CONTRACT-SPEC §5).
OUTCOMES = ("settled", "lapsed", "voided", "unresolved")


class VectorError(ValueError):
    """A vector that cannot be evaluated. Raised rather than defaulted, always.

    A reference that quietly substitutes a zero for a malformed input produces a number the Rust
    can agree with while both are wrong about the same thing.
    """


def _nonneg(name: str, value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise VectorError(f"{name} must be an integer, got {value!r}")
    if value < 0:
        raise VectorError(
            f"{name} must be non-negative, got {value}. Floor division is only agreed between "
            f"Python and Rust on non-negative operands, so a negative here is not a small "
            f"difference — it is two implementations rounding opposite ways."
        )
    return value


# --------------------------------------------------------------------------------------------
# 1. Per-bidder payout — 02-CONTRACT-SPEC §5, `claim_payout(round)`
# --------------------------------------------------------------------------------------------


def payout_for_fill(notional: int, spot: int, strike: int) -> int:
    """``⌊notional × (spot − strike) / spot⌋``, or 0 when the option expired worthless.

    **Multiply first, divide once.** The spec writes one pair of floor brackets around the whole
    expression, so this is ``floor(notional * (spot - strike) / spot)`` and never
    ``notional * floor((spot - strike) / spot)`` — which would be zero for every round, since the
    inner quotient is a proper fraction. Stating it because a differential layer diffs bytes, and
    an association difference here is invisible in prose and total in effect.

    §6: this floors **down**, so the error is less XLM out and the beneficiary is the vault. The
    same formula is recomputed per bidder from the round record, which is what makes
    ``Σ per-bidder ≤ payout_total`` hold: ``Σ⌊xᵢ⌋ ≤ ⌊Σxᵢ⌋``. The difference stays in the pool as
    dust and is deliberate (§6, "Aggregate dust").

    A zero here means the contract answers ``NothingToClaim`` — see :func:`per_bidder_amounts`.
    """
    _nonneg("fill.filled", notional)
    _nonneg("outcome.spot", spot)
    _nonneg("open.strike", strike)
    if spot <= 0:
        raise VectorError(
            "spot must be strictly positive: it is the divisor, and the guard ladder rejects a "
            "non-positive aggregate before any division precisely so this cannot be reached "
            "(04-ORACLE §3 step 3)"
        )
    if spot <= strike:
        # Out of the money. The option expired worthless; the contract rejects the call with
        # `NothingToClaim` rather than transferring zero.
        return 0
    return (notional * (spot - strike)) // spot


# --------------------------------------------------------------------------------------------
# 2. Exact refund — 02-CONTRACT-SPEC §5, `claim_refund(round)`
# --------------------------------------------------------------------------------------------


def refund_for_fill(premium_paid: int) -> int:
    """Each fill's **own** premium back, exactly. No division, so no rounding at all.

    This is a design commitment rather than an implementation convenience (D-51, 04-ORACLE §4).
    Every fill on a Dutch curve paid a *different* rate, so a pro-rata refund of the pooled premium
    would move value between bidders who agreed to different prices — and it would floor, so the
    aggregate would come up short of what was collected. Each fill's premium is recorded, which is
    what makes the exact answer available.

    It is also why a void pays **no bounty**: the premium is refunded in full, so there is nothing
    left to fund one from.
    """
    return _nonneg("fill.premium", premium_paid)


# --------------------------------------------------------------------------------------------
# 3. Withdraw claim — 02-CONTRACT-SPEC §5, `claim_withdraw`
# --------------------------------------------------------------------------------------------


def withdraw_claim(shares: int, pps: int) -> int:
    """``⌊shares × pps_r / PRECISION⌋`` — settled at the **round's recorded** pps.

    Not at ``last_pps``. The shares were burned during the round and the withdrawal is claimable
    after that round finalizes, at the price that round recorded; that is what makes the claim
    independent of when it is collected.

    ``pps`` arrives from ``settle_ref``'s output, not from anything computed here — this module
    consumes the price and never derives it, which is the seam that keeps the two independently
    diffable (`06-TEST-PLAN.md` §5's chain).

    §6: floors down, less XLM out, beneficiary the vault. ``pps == 0`` is admissible and must not
    be special-cased — D-66 removed the clamp that forced ``pps ≥ 1``, because forcing it in the
    degenerate state makes ``Σ claim_withdraw`` exceed what was credited, and where I6 and I1
    conflict solvency wins.
    """
    _nonneg("burn.shares", shares)
    _nonneg("pps", pps)
    return (shares * pps) // PRECISION


# --------------------------------------------------------------------------------------------
# The vector-facing surface
# --------------------------------------------------------------------------------------------


def per_bidder_amounts(outcome_kind: str, fills, spot, strike):
    """What each filled bidder can claim, by outcome. Returns ``[{"bidder", "amount"}]``.

    Every bidder holding a fill appears, and ``amount == 0`` is how "nothing is claimable" is
    expressed — the contract answers ``NothingToClaim`` there. Emitting the row rather than
    omitting it is deliberate: an absent bidder is indistinguishable from a bidder the
    implementation forgot, and a differential layer whose silence carries meaning cannot catch an
    omission. `06-TEST-PLAN.md` §5 carries the ruling.

    By outcome (02-CONTRACT-SPEC §5, 04-ORACLE §4):

    * ``settled``   — ``⌊notional × (spot − strike)/spot⌋``, zero when out of the money.
    * ``voided``    — each fill's own ``premium`` back, exactly.
    * ``unresolved``— nothing. The premium is **retained by depositors** and the payout is zero
      (D-59). This is the outcome that removes the free option: an out-of-the-money bidder ends in
      the same place as under a normal settle, and an in-the-money one strictly loses by drifting
      there, so waiting is worth nothing to anyone who could choose it.
    * ``lapsed``    — a lapse *is* ``notional_sold == 0``, so there are no fills to claim on. A
      lapse vector carrying fills is malformed, and saying so beats returning an empty list.
    """
    if outcome_kind not in OUTCOMES:
        raise VectorError(f"outcome.kind must be one of {OUTCOMES}, got {outcome_kind!r}")

    seen = set()
    out = []
    for fill in fills:
        bidder = fill["bidder"]
        if bidder in seen:
            raise VectorError(
                f"two fills for bidder {bidder!r} in one round. Storage keys a fill as "
                f"Fill(round, bidder) (03-STORAGE-TTL §1), so a second bid merges into the first "
                f"record — two entries means the vector or the curve reference is wrong, and "
                f"silently summing them here would hide which"
            )
        seen.add(bidder)

        if outcome_kind == "lapsed":
            raise VectorError(
                "a lapsed round has fills. A lapse is notional_sold == 0 by definition "
                "(05-AUCTION-SETTLEMENT §4), so this vector is malformed"
            )
        if outcome_kind == "settled":
            amount = payout_for_fill(fill["filled"], spot, strike)
        elif outcome_kind == "voided":
            amount = refund_for_fill(fill["premium"])
        else:  # unresolved
            amount = 0
        out.append({"amount": amount, "bidder": bidder})
    # Sorted by bidder, not left in fill order. Sorted *keys* settle objects and say nothing about
    # arrays, so an unpinned array order diffs as a failure on identical arithmetic — and the two
    # sides need not build this list the same way: one reads the vector, the other may iterate
    # contract storage. `06-TEST-PLAN.md` §5 carries the ruling.
    out.sort(key=lambda row: row["bidder"])
    return out


def withdraw_claims(burns, pps):
    """One claim per recorded burn, in vector order. Returns ``[{"shares", "amount"}]``."""
    return [
        {"amount": withdraw_claim(burn["shares"], pps), "shares": burn["shares"]}
        for burn in burns
    ]


def compute(vector, settle):
    """The module's entry point for ``run_vectors.py``.

    ``vector`` is the whole vector document; ``settle`` is ``settle_ref``'s output for it — which
    is where ``pps`` and ``payout_total`` come from. Keeping them as a separate argument is what
    makes the chain in `06-TEST-PLAN.md` §5 real rather than decorative: this module consumes the
    previous stage's product and derives none of it.

    Returns the two ``expected`` sections this module owns::

        {"per_bidder": [...], "withdraw_claims": [...]}
    """
    outcome = vector["outcome"]
    kind = outcome["kind"]
    fills = vector.get("expected", {}).get("fills", [])
    burns = vector.get("burns", [])
    strike = vector["open"]["strike"]
    spot = outcome.get("spot", 0)
    pps = settle["pps"]

    result = {
        "per_bidder": per_bidder_amounts(kind, fills, spot, strike),
        "withdraw_claims": withdraw_claims(burns, pps),
    }

    # Solvency, asserted rather than assumed. §6's aggregate-dust rule is an inequality in one
    # direction only, and a reference that lets it fail silently would agree with a Rust that
    # over-pays. Checked here because this module is the only place both sides of it are in scope.
    if kind == "settled":
        total = sum(row["amount"] for row in result["per_bidder"])
        if total > settle["payout_total"]:
            raise VectorError(
                f"Σ per-bidder payout {total} exceeds payout_total {settle['payout_total']}. "
                f"Σ⌊xᵢ⌋ ≤ ⌊Σxᵢ⌋ makes this impossible under floor division, so one of the two was "
                f"not computed by the formula §5 states"
            )
    claimed = sum(row["amount"] for row in result["withdraw_claims"])
    if "wclaims" in settle and claimed > settle["wclaims"]:
        raise VectorError(
            f"Σ withdraw claims {claimed} exceeds wclaims {settle['wclaims']} — the aggregate "
            f"credited at finalization. This is the subtraction D-32 and D-66 each broke once"
        )
    return result


# --------------------------------------------------------------------------------------------
# Section gate: 05-AUCTION-SETTLEMENT §4, reproduced by hand in stroops
# --------------------------------------------------------------------------------------------

_XLM = 10_000_000  # stroops per XLM


def _selftest() -> None:
    """`DEV2.md` §3.4's gate: the refund case reproduces §4's worked example, exactly.

    Every figure below is transcribed from the prose and converted to stroops here, not copied
    from any implementation. §4's own numbers are printed in XLM; a vector that floors in XLM gets
    a zero bounty and silently tests nothing (`06-TEST-PLAN.md` §5).
    """
    strike = 4_400_000  # 0.4400000 USD, 1e7 fixed point
    a_notional, a_premium = 6_000 * _XLM, 72 * _XLM  # 6 000 XLM at 120 bps
    b_notional, b_premium = 4_000 * _XLM, 16 * _XLM  # 4 000 XLM at  40 bps
    fills = [
        {"bidder": "A", "filled": a_notional, "premium": a_premium},
        {"bidder": "B", "filled": b_notional, "premium": b_premium},
    ]

    # --- settled, in the money: TWAP at expiry 0.5000000 -------------------------------------
    spot = 5_000_000
    rows = per_bidder_amounts("settled", fills, spot, strike)
    assert rows[0] == {"amount": 720 * _XLM, "bidder": "A"}, rows[0]
    assert rows[1] == {"amount": 480 * _XLM, "bidder": "B"}, rows[1]
    # §4 step 5: Σ = 1 200 = payout_total, exactly — no dust in this example.
    assert sum(r["amount"] for r in rows) == 1_200 * _XLM

    # --- settled, out of the money: the counter-case at 0.4200000 -----------------------------
    rows = per_bidder_amounts("settled", fills, 4_200_000, strike)
    assert [r["amount"] for r in rows] == [0, 0], rows

    # --- voided: the section gate proper -------------------------------------------------------
    # Two bidders filled at *different* curve points each get their own premium back, exactly.
    # Pro-rata over the 88 XLM pool would have paid A 52.8 and B 35.2 — money moved between two
    # counterparties who agreed to different prices.
    rows = per_bidder_amounts("voided", fills, spot, strike)
    assert rows[0] == {"amount": a_premium, "bidder": "A"}, rows[0]
    assert rows[1] == {"amount": b_premium, "bidder": "B"}, rows[1]
    assert sum(r["amount"] for r in rows) == 88 * _XLM

    # --- unresolved: the bidder gets nothing, the premium stays with depositors (D-59) --------
    rows = per_bidder_amounts("unresolved", fills, spot, strike)
    assert [r["amount"] for r in rows] == [0, 0], rows

    # --- withdraw claim at §4's settled pps ----------------------------------------------------
    # §4 step 4: assets_R = 8 887.78 over 10 000 shares → pps = 0.8887780.
    pps = 8_887_780
    # 100 shares × 0.8887780 = 88.8778 XLM = 888 778 000 stroops. Written 88_877_800 on the first
    # pass, which is 8.88778 XLM — a factor of ten, in a hand-transcribed expected value, in the
    # file whose whole purpose is to be arithmetic nobody ported. Caught by running it. Left
    # documented rather than tidied away, because it is the argument for the self-test existing.
    assert withdraw_claim(100 * _XLM, pps) == 888_778_000
    assert withdraw_claim(0, pps) == 0
    # D-66: pps == 0 is admissible and must not be special-cased.
    assert withdraw_claim(10 * _XLM, 0) == 0

    # --- the floors are where §6 says they are -------------------------------------------------
    # One stroop of notional at a 1-in-3 moneyness floors to zero, not up.
    assert payout_for_fill(1, 3, 2) == 0
    assert payout_for_fill(3, 3, 2) == 1
    # And I3: the payout is strictly below the notional for every positive strike.
    for notional, s, k in ((10**12, 10**9, 1), (7, 5, 4), (10**12, 10**9, 10**8)):
        assert payout_for_fill(notional, s, k) < notional, (notional, s, k)

    print("claims_ref: 05-AUCTION-SETTLEMENT §4 reproduced, all checks pass")


if __name__ == "__main__":
    _selftest()
