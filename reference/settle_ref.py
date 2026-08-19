"""Settlement arithmetic, derived from the specification — never from ``src/``.

Covers ``payout_total``, ``fee``, ``bounty``, ``assets_R``, ``pps``, ``wclaims`` and
``locked_after`` for all four round outcomes.

PROVENANCE
==========

Written from ``02-CONTRACT-SPEC.md`` §5 (``finalize_round``, ``close_round`` and its three
branches), §6 (rounding, normative) and §8, cross-read against ``05-AUCTION-SETTLEMENT.md`` §2
and §4's worked example. **Not from the Rust**, per ``DEV-PROTOCOL.md`` §4 and
``06-TEST-PLAN.md`` §5.

At the time this file was written, ``contracts/antares-vault/src/`` contained exactly
``lib.rs``, ``types.rs``, ``errors.rs`` and ``test_types.rs`` — **``settle.rs`` and ``vault.rs``
did not exist**, on this branch or on ``origin/dev1`` or ``origin/dev2``. Authored at ``45ae0e8``
on 2026-08-19. That is recorded so the claim can be checked against history rather than believed:
the Rust this mirrors was not available to read, by anyone, on that commit.

Why the separation is the whole point, and not ceremony: the differential layer's value is that
two people derived the same integer arithmetic independently from one specification. A Python file
ported from the Rust agrees with it perfectly and proves nothing. If a vector disagrees later,
the disagreement **is** the layer working — it goes back to §5/§6 or to the integrator, never to
the Rust.

WHAT THIS FILE IS NOT
=====================

It is not the whole reference. ``curve_ref.py`` (DEV1) turns ``bids`` into ``fills``;
``claims_ref.py`` (DEV2) turns this module's outputs into per-bidder and per-depositor amounts.
This module sits in the middle of that chain and consumes ``fills`` as given
(``06-TEST-PLAN.md`` §5).

It also computes no *price*. ``spot`` arrives as an input because settlement reads the feed
**anchored at ``expiry``**, not at call time — §8 is explicit that a reference settling on the
call-time price "will disagree with a correct implementation on every round where settlement is
not instantaneous, and the diff will look like a Rust bug". The vector carries the anchored value;
deriving it is the oracle's arithmetic, and no reference module owns it.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

# ``02-CONTRACT-SPEC.md`` §2's constants. Repeated here because a reference that imports the
# Rust's constants is not independent of it; these are read from the specification.
PRECISION = 10_000_000
BPS = 10_000

__all__ = [
    "BPS",
    "PRECISION",
    "Outcome",
    "RoundInputs",
    "SettleResult",
    "SettlementError",
    "bounty_of",
    "fee_of",
    "finalize_round",
    "payout_total_of",
    "resolve",
]


class SettlementError(Exception):
    """A state the contract rejects rather than computing a number for.

    The reference must *refuse* wherever the contract reverts. Returning a plausible value where
    the Rust traps would make the diff green on a case that cannot occur, which is the same class
    of defect as a gate that only passes.
    """


class Outcome(str, Enum):
    """``RoundOutcome`` — §2. Four outcomes, one exit (``finalize_round``)."""

    SETTLED = "Settled"
    LAPSED = "Lapsed"
    VOIDED = "Voided"
    UNRESOLVED = "Unresolved"


def _floor_div(numerator: int, denominator: int) -> int:
    """Floor division over non-negative integers, with the operands checked.

    **Python's ``//`` floors toward negative infinity; Rust's ``/`` truncates toward zero.** They
    agree on non-negative operands and disagree on every negative one, so this refuses a negative
    operand rather than silently producing the answer the other language would not. §6 makes every
    division in §5 a floor and every quantity entering one is non-negative by construction — so a
    negative here means an earlier step is wrong, and that is worth an exception rather than a
    number that happens to differ from the Rust by one.
    """
    if denominator <= 0:
        raise SettlementError(f"division by a non-positive denominator ({denominator})")
    if numerator < 0:
        raise SettlementError(
            f"negative numerator ({numerator}) — Python floors and Rust truncates, so this would "
            f"disagree with a correct implementation rather than reproduce it"
        )
    return numerator // denominator


@dataclass(frozen=True)
class RoundInputs:
    """Everything §5's four branches read, and nothing they do not.

    ``locked_at_open``, ``shares_snapshot`` and ``last_pps`` come from the vector's ``initial``
    block: §5's ``open_epoch`` step 3 sets ``notional_offered = locked_assets``,
    ``locked_at_open = locked_assets`` and ``shares_snapshot = shares_outstanding``, and mints
    happen only in Idle (D-06/D-18), so the pre-open values *are* the snapshots.

    ``notional_sold`` and ``premium_collected`` are sums over ``curve_ref``'s ``fills`` — this
    module does not resolve bids.
    """

    locked_at_open: int
    shares_snapshot: int
    last_pps: int
    notional_sold: int
    premium_collected: int
    burned_this_round: int
    strike: int
    fee_bps_snapshot: int
    settle_bounty_bps: int
    outcome: Outcome
    spot: int | None = None

    def __post_init__(self) -> None:
        for name in (
            "locked_at_open",
            "shares_snapshot",
            "last_pps",
            "notional_sold",
            "premium_collected",
            "burned_this_round",
            "strike",
            "fee_bps_snapshot",
            "settle_bounty_bps",
        ):
            if getattr(self, name) < 0:
                raise SettlementError(f"{name} must be non-negative")

        # §5: division by ``shares_snapshot`` is protected by an explicit ``shares_outstanding > 0``
        # check in ``open_epoch`` (``NoShares``), and after genesis by the ``DEAD_SHARES`` floor.
        # A round with a zero snapshot is unopenable, so a vector carrying one is malformed.
        if self.shares_snapshot <= 0:
            raise SettlementError(
                "shares_snapshot must be > 0 — open_epoch rejects NoShares before a round exists"
            )

        # The chain §5 spells out in ``finalize_round``'s comment rests on this: ``wclaims ≤
        # assets_after`` because ``burned ≤ S``. More burned than the supply at open is not a
        # reachable state, and admitting it here would let the reference produce a negative
        # ``locked_after`` — the very underflow D-32 and D-66 both turned on.
        if self.burned_this_round > self.shares_snapshot:
            raise SettlementError(
                f"burned_this_round ({self.burned_this_round}) exceeds shares_snapshot "
                f"({self.shares_snapshot}); wclaims <= assets_after depends on it not doing so"
            )

        if self.outcome is Outcome.SETTLED:
            if self.spot is None:
                raise SettlementError("the settle branch needs an anchored spot")
            if self.spot <= 0:
                # §5's void branch is reached on a non-positive or absurd aggregate — such a read
                # classifies as DeadAtExpiry and never reaches settle (04-ORACLE §4).
                raise SettlementError(
                    "a non-positive spot classifies as DeadAtExpiry and takes the void branch, "
                    "never the settle branch"
                )
        # A lapse *is* ``notional_sold == 0`` (§5's lazy-finalization step), so a vector that
        # lapses with fills is describing something unreachable.
        if self.outcome is Outcome.LAPSED and self.notional_sold != 0:
            raise SettlementError("a lapse is notional_sold == 0; fills contradict it")


@dataclass(frozen=True)
class SettleResult:
    """The seven quantities ``DEV3.md`` §2.2 puts in this module's scope."""

    outcome: Outcome
    payout_total: int
    fee: int
    bounty: int
    assets_R: int
    pps: int
    wclaims: int
    locked_after: int


# --------------------------------------------------------------------------------------------
# The three closed-form terms — §5's settle path
# --------------------------------------------------------------------------------------------


def payout_total_of(notional_sold: int, strike: int, spot: int) -> int:
    """``0`` if ``spot <= strike``, else ``⌊notional_sold × (spot − strike) / spot⌋``.

    §5 and 05 §2. The strict inequality ``payout_total < notional_sold`` holds for every
    representable input because ``(spot − strike)/spot`` approaches 1 only from below — which is
    what makes the vault unable to owe more than the collateral behind the position: no margin
    call, no bad debt. Asserted below rather than trusted, since it is I3.
    """
    if spot <= strike:
        return 0
    payout = _floor_div(notional_sold * (spot - strike), spot)
    # I3, and it is cheap to check on every vector rather than only in the property suite.
    assert payout < notional_sold or notional_sold == 0, (
        f"I3 violated: payout_total {payout} >= notional_sold {notional_sold}"
    )
    return payout


def fee_of(premium_collected: int, fee_bps_snapshot: int) -> int:
    """``⌊premium_collected × fee_bps_snapshot / BPS⌋`` — §5, D-39.

    The rate is the value snapshotted at ``open_epoch``, never the live one: read live it let an
    admin apply a fee retroactively to a round auctioned under a different one. Ships at 0 and
    lives in the formula from round 1, because retrofitting it into ``pps`` would change every
    historical round's meaning.
    """
    return _floor_div(premium_collected * fee_bps_snapshot, BPS)


def bounty_of(premium_collected: int, settle_bounty_bps: int) -> int:
    """``⌊premium_collected × settle_bounty_bps / BPS⌋`` — §5, D-44/D-51.

    Out of premium, never out of collateral, and taken before ``pps`` — so it lands on depositors
    exactly like the fee rather than on the bidders' payouts. ``params`` is the open-time snapshot;
    there is deliberately no ``bounty_bps_snapshot`` field (D-64) because ``State.params`` already
    *is* that snapshot.
    """
    return _floor_div(premium_collected * settle_bounty_bps, BPS)


# --------------------------------------------------------------------------------------------
# The single exit — §5's ``finalize_round``
# --------------------------------------------------------------------------------------------


def finalize_round(*, outcome: Outcome, pps: int, assets_after: int, burned_this_round: int) -> tuple[int, int]:
    """The bookkeeping every outcome shares. Returns ``(wclaims, locked_after)``.

    ``wclaims = ⌊burned_this_round × pps / PRECISION⌋``; ``locked_after = assets_after − wclaims``.

    **This is one function called by four branches because the specification is emphatic that it
    must be.** §5: *"identical bookkeeping — because the withdrawal-queue accounting below is easy
    to forget in one branch and that omission is a solvency bug, not a style issue (found in
    review, 2026-08-16: the Lapsed branch originally skipped it)."* A reference with the
    subtraction inlined per branch could reproduce that same omission in the same branch and the
    diff would agree with the bug. D-32 and D-66 both turned on this subtraction, which is why
    ``wclaims`` and ``locked_after`` are in this module's scope at all.

    ``locked_after`` cannot go negative, and it is worth writing down why rather than guarding it:
    ``pps = ⌊assets_R·P/S⌋`` gives ``S·pps ≤ assets_R·P``, so
    ``wclaims ≤ burned·pps/P ≤ S·pps/P ≤ assets_after``. The chain needs ``burned ≤ S``
    (checked in ``RoundInputs``) and it is exactly why §16 removed the ``pps ≥ 1`` clamp: any rule
    raising ``pps`` above the computed value breaks the middle step and makes this line underflow.
    """
    wclaims = _floor_div(burned_this_round * pps, PRECISION)
    locked_after = assets_after - wclaims
    if locked_after < 0:
        raise SettlementError(
            f"locked_after underflowed ({assets_after} - {wclaims}) on the {outcome.value} branch — "
            f"the wclaims <= assets_after chain in 02-CONTRACT-SPEC §5 was broken upstream"
        )
    return wclaims, locked_after


# --------------------------------------------------------------------------------------------
# The four branches — §5's dispatch table
# --------------------------------------------------------------------------------------------


def resolve(inputs: RoundInputs) -> SettleResult:
    """Compute the seven outputs for whichever outcome the vector names.

    The four rows are §5's ``finalize_round`` call-site table, transcribed:

    ==============  ==========================================  ==============================================
    call site       ``pps``                                     ``assets_after``
    ==============  ==========================================  ==============================================
    settle          ``⌊assets_R × PRECISION / shares_snapshot⌋``  ``locked_at_open + premium − payout − fee − bounty``
    lazy lapse      ``last_pps`` (unchanged)                    ``locked_at_open``
    void            ``last_pps`` (unchanged)                    ``locked_at_open``
    unresolved      ``⌊assets_R × PRECISION / shares_snapshot⌋``  ``locked_at_open + premium − 0 − fee − bounty``
    ==============  ==========================================  ==============================================

    Note what the caller does **not** supply: the outcome is a function of frozen history, not a
    choice (D-61). The vector names it because the vector *is* the history — it encodes what the
    feed said — not because a caller could elect it.
    """
    if inputs.outcome is Outcome.SETTLED:
        assert inputs.spot is not None  # guaranteed by RoundInputs.__post_init__
        payout_total = payout_total_of(inputs.notional_sold, inputs.strike, inputs.spot)
        fee = fee_of(inputs.premium_collected, inputs.fee_bps_snapshot)
        bounty = bounty_of(inputs.premium_collected, inputs.settle_bounty_bps)
        assets_R = inputs.locked_at_open + inputs.premium_collected - payout_total - fee - bounty
        pps = _pps_of(assets_R, inputs.shares_snapshot, "settle")

    elif inputs.outcome is Outcome.UNRESOLVED:
        # D-59/D-64: the settle shape with ``payout_total`` pinned to 0 — premium retained by
        # depositors, payout zero. It pays a bounty *because* the premium is retained, which is
        # the source settle draws on; the void branch has no such source and pays none.
        #
        # Both entrances to this branch — step 2's oracle-free clock fallback and an ``OutOfReach``
        # answer — must produce byte-identical accounting (D-64), so there is deliberately one code
        # path here and no flag reaching any computation. ``oracle_answered`` is diagnostic only.
        payout_total = 0
        fee = fee_of(inputs.premium_collected, inputs.fee_bps_snapshot)
        bounty = bounty_of(inputs.premium_collected, inputs.settle_bounty_bps)
        assets_R = inputs.locked_at_open + inputs.premium_collected - fee - bounty
        pps = _pps_of(assets_R, inputs.shares_snapshot, "unresolved")

    elif inputs.outcome in (Outcome.LAPSED, Outcome.VOIDED):
        # Neither takes a fee or a bounty, and both leave ``pps`` untouched. Lapse has no premium
        # at all; void refunds it in full, so there is nothing to take a fee on and a bounty could
        # only come out of the refund (breaking "a refund is exact") or out of collateral
        # (breaking "a void costs depositors nothing") — D-51.
        payout_total = 0
        fee = 0
        bounty = 0
        assets_R = inputs.locked_at_open
        pps = inputs.last_pps

    else:  # pragma: no cover — Outcome is closed
        raise SettlementError(f"unknown outcome {inputs.outcome!r}")

    wclaims, locked_after = finalize_round(
        outcome=inputs.outcome,
        pps=pps,
        assets_after=assets_R,
        burned_this_round=inputs.burned_this_round,
    )

    return SettleResult(
        outcome=inputs.outcome,
        payout_total=payout_total,
        fee=fee,
        bounty=bounty,
        assets_R=assets_R,
        pps=pps,
        wclaims=wclaims,
        locked_after=locked_after,
    )


def _pps_of(assets_R: int, shares_snapshot: int, branch: str) -> int:
    """``⌊assets_R × PRECISION / shares_snapshot⌋``, with §5's non-negativity assertion.

    §5: *"``assets_R`` is asserted non-negative regardless"* — the guard exists because a large
    enough ``fee_bps`` drove it negative and wedged ``settle()`` on a checked subtraction. The
    reference refuses in the same place rather than producing a negative ``pps``.

    ``pps == 0`` is **accepted and never clamped** (D-66, §16). Forcing ``pps >= 1`` in the
    degenerate state breaks the implication that bounds every downstream amount, and solvency wins
    where the two conflict: a vault worth less than one stroop per ``PRECISION`` share-units still
    has to let every holder exit.
    """
    if assets_R < 0:
        raise SettlementError(
            f"assets_R is negative ({assets_R}) on the {branch} branch — 02-CONTRACT-SPEC §5 "
            f"asserts it non-negative, so a correct implementation reverts here rather than "
            f"computing a price"
        )
    return _floor_div(assets_R * PRECISION, shares_snapshot)
