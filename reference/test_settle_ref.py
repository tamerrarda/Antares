"""``settle_ref.py`` against ``05-AUCTION-SETTLEMENT.md`` §4's worked example.

Run: ``python3 -m unittest discover -s reference -p 'test_*.py'``

This is not the differential diff. That is Rust-replay-versus-Python-replay and it needs
``run_vectors.py`` plus a Rust side that does not exist yet — the CI job named for it currently
runs one side, so landing ``run_vectors.py`` into it would turn a harmless notice into a green lie
(Tamer's ruling, 2026-08-19). What this file does instead is pin the Python reference against
**numbers a human derived from the specification and printed in the document**, which is a real and
independent check: if this module and §4 disagree, one of them is wrong today, before any Rust
exists to blame.

Every figure below was re-derived by hand in integer stroops from §4's prose, then compared with
what the module computes. §4's own numbers are in XLM; the conversions are shown so a reader can
check the arithmetic rather than trust the constant.
"""

from __future__ import annotations

import unittest

from settle_ref import (
    BPS,
    PRECISION,
    Outcome,
    RoundInputs,
    SettleResult,
    SettlementError,
    bounty_of,
    fee_of,
    finalize_round,
    payout_total_of,
    resolve,
)

XLM = 10_000_000  # one XLM in stroops, and one share in share-stroops (7 decimals both)

# --- §4's setup, in stroops -------------------------------------------------------------------
#
#   "pps = 1.0, 10 000 XLM locked, 10 000 shares. Params: strike 10 % OTM, start 300 bps,
#    floor 10 bps, fee 0, auction_duration = 2 700 (45 min), min_fill 100 XLM,
#    settle_bounty_bps = 25. TWAP at open = 0.4000000 USD -> strike 0.4400000."
LOCKED_AT_OPEN = 10_000 * XLM  # 100_000_000_000
SHARES_SNAPSHOT = 10_000 * XLM  # 100_000_000_000
LAST_PPS = PRECISION  # 1.0
OPEN_TWAP = 4_000_000  # 0.4000000 at 1e7 fixed point
STRIKE = 4_400_000  # 0.4400000 — twap x (10_000 + 1_000) / 10_000
FEE_BPS = 0
BOUNTY_BPS = 25

# "1. Bidder A fills 6 000 XLM at t where curve = 120 bps -> premium 72 XLM.
#  2. Bidder B fills 4 000 XLM at curve = 40 bps -> premium 16 XLM. Fully sold -> Active."
A_FILLED, A_BPS = 6_000 * XLM, 120
B_FILLED, B_BPS = 4_000 * XLM, 40
NOTIONAL_SOLD = A_FILLED + B_FILLED  # 100_000_000_000 — the whole offer
PREMIUM_COLLECTED = 88 * XLM  # 880_000_000, asserted from the fills below


def settled(spot: int, *, burned: int = 0) -> SettleResult:
    return resolve(
        RoundInputs(
            locked_at_open=LOCKED_AT_OPEN,
            shares_snapshot=SHARES_SNAPSHOT,
            last_pps=LAST_PPS,
            notional_sold=NOTIONAL_SOLD,
            premium_collected=PREMIUM_COLLECTED,
            burned_this_round=burned,
            strike=STRIKE,
            fee_bps_snapshot=FEE_BPS,
            settle_bounty_bps=BOUNTY_BPS,
            outcome=Outcome.SETTLED,
            spot=spot,
        )
    )


class WorkedExample(unittest.TestCase):
    """§4, both cases, to the stroop."""

    def test_the_premiums_are_what_the_document_says(self) -> None:
        # premium = floor(filled x p / BPS) — §5 step 4. Not this module's arithmetic (it is
        # curve_ref's), but the sum feeding every number below, so it is checked rather than
        # assumed: a wrong premium_collected would move pps, fee and bounty together and look
        # like a settlement bug.
        self.assertEqual(A_FILLED * A_BPS // BPS, 72 * XLM)
        self.assertEqual(B_FILLED * B_BPS // BPS, 16 * XLM)
        self.assertEqual(A_FILLED * A_BPS // BPS + B_FILLED * B_BPS // BPS, PREMIUM_COLLECTED)
        self.assertEqual(STRIKE, OPEN_TWAP * (BPS + 1_000) // BPS)

    def test_in_the_money_case(self) -> None:
        # "3. At expiry TWAP = 0.5000000 (> strike).
        #     payout_total = floor(10 000 x (0.5 - 0.44)/0.5) = 1 200 XLM.
        #  4. fee = 0; bounty = floor(88 x 25 / 10 000) = 0.22 XLM.
        #     assets_R = 10 000 + 88 - 1 200 - 0 - 0.22 = 8 887.78 -> pps = 0.8887780"
        r = settled(5_000_000)
        self.assertEqual(r.payout_total, 1_200 * XLM)
        self.assertEqual(r.fee, 0)
        self.assertEqual(r.bounty, 2_200_000, "0.22 XLM — a vector flooring in XLM would get 0")
        self.assertEqual(r.assets_R, 88_877_800_000)  # 8 887.78 XLM
        self.assertEqual(r.pps, 8_887_780)  # 0.8887780
        # No burns in §4's main case, so the queue accounting is a no-op here — which is exactly
        # why the document insists a separate vector carries a burn (see below).
        self.assertEqual(r.wclaims, 0)
        self.assertEqual(r.locked_after, r.assets_R)

    def test_out_of_the_money_counter_case(self) -> None:
        # "Counter-case: TWAP at expiry = 0.4200000 (<= strike) -> payout 0,
        #  assets_R = 10 087.78, pps = 1.0087780; bidders' options expired worthless."
        r = settled(4_200_000)
        self.assertEqual(r.payout_total, 0)
        self.assertEqual(r.assets_R, 100_877_800_000)  # 10 087.78 XLM
        self.assertEqual(r.pps, 10_087_780)  # 1.0087780
        self.assertGreater(r.pps, LAST_PPS, "depositors keep the premium when the option expires OTM")

    def test_spot_exactly_at_strike_pays_nothing(self) -> None:
        # "spot <= strike: payout_total = 0" — the boundary is inclusive, so a round settling
        # exactly at the strike is out of the money. Worth pinning: the ITM *bid* guard uses the
        # same boundary in the other direction (spot >= strike rejects), and the pair only makes
        # sense if both are inclusive at the same point.
        self.assertEqual(settled(STRIKE).payout_total, 0)
        self.assertEqual(settled(STRIKE + 1).payout_total, 22_727)

    def test_the_bounty_lands_on_depositors_not_on_the_bidders_payouts(self) -> None:
        # §4 step 5's parenthesis: "The bounty comes out of the pool before pps, so it lands on
        # depositors, not on the bidders' payouts — exactly like the fee."
        with_bounty = settled(5_000_000)
        no_bounty = resolve(
            RoundInputs(
                locked_at_open=LOCKED_AT_OPEN,
                shares_snapshot=SHARES_SNAPSHOT,
                last_pps=LAST_PPS,
                notional_sold=NOTIONAL_SOLD,
                premium_collected=PREMIUM_COLLECTED,
                burned_this_round=0,
                strike=STRIKE,
                fee_bps_snapshot=FEE_BPS,
                settle_bounty_bps=0,
                outcome=Outcome.SETTLED,
                spot=5_000_000,
            )
        )
        self.assertEqual(with_bounty.payout_total, no_bounty.payout_total, "payout is untouched")
        self.assertEqual(no_bounty.assets_R - with_bounty.assets_R, 2_200_000, "depositors pay it")
        self.assertLess(with_bounty.pps, no_bounty.pps)


class LapseCarriesABurn(unittest.TestCase):
    """§4: *"The lapse vector carries a burn, and that is not decoration."*

    The exact shape of D-32's regression — ``request_withdraw`` during the auction, no bids, lapse
    — so that ``wclaims`` and the ``locked_assets`` subtraction after it are actually exercised.
    Without it all four hand-written vectors run at ``wclaims = 0`` and the differential layer never
    diffs the arithmetic that underflowed in D-32 and again in D-66.
    """

    def lapsed(self, burned: int) -> SettleResult:
        # "The lapse necessarily carries bids: [] — a lapse *is* notional_sold == 0."
        return resolve(
            RoundInputs(
                locked_at_open=LOCKED_AT_OPEN,
                shares_snapshot=SHARES_SNAPSHOT,
                last_pps=LAST_PPS,
                notional_sold=0,
                premium_collected=0,
                burned_this_round=burned,
                strike=STRIKE,
                fee_bps_snapshot=FEE_BPS,
                settle_bounty_bps=BOUNTY_BPS,
                outcome=Outcome.LAPSED,
                spot=None,
            )
        )

    def test_a_lapse_costs_depositors_nothing_and_moves_no_price(self) -> None:
        r = self.lapsed(0)
        self.assertEqual(r.pps, LAST_PPS, "pps unchanged — no premium, no payout")
        self.assertEqual(r.assets_R, LOCKED_AT_OPEN, "collateral untouched")
        self.assertEqual((r.fee, r.bounty, r.payout_total), (0, 0, 0))
        self.assertEqual(r.locked_after, LOCKED_AT_OPEN)

    def test_the_burn_exits_at_the_unchanged_price_and_leaves_the_pool_short_by_exactly_that(self) -> None:
        burned = 1_000 * XLM  # 1 000 shares requested out during the auction
        r = self.lapsed(burned)
        # wclaims = floor(burned x pps / PRECISION) = 1 000 XLM at pps 1.0
        self.assertEqual(r.wclaims, 1_000 * XLM)
        self.assertEqual(r.locked_after, LOCKED_AT_OPEN - r.wclaims)
        self.assertEqual(r.locked_after, 9_000 * XLM)

    def test_the_whole_supply_exiting_on_a_lapse_does_not_underflow(self) -> None:
        # The boundary of the chain in finalize_round's docstring: burned == S is the largest
        # admissible burn, and at pps == last_pps == PRECISION it claims the entire pool. One
        # stroop more would have to underflow, and RoundInputs refuses it instead.
        r = self.lapsed(SHARES_SNAPSHOT)
        self.assertEqual(r.wclaims, LOCKED_AT_OPEN)
        self.assertEqual(r.locked_after, 0, "exactly empty, never negative")
        with self.assertRaises(SettlementError):
            self.lapsed(SHARES_SNAPSHOT + 1)

    def test_a_settled_round_with_a_burn_exits_at_the_rounds_own_price(self) -> None:
        # The other half of D-32: burns during a *settled* round exit at that round's pps, not at
        # last_pps — the price they were at risk under.
        burned = 1_000 * XLM
        r = settled(5_000_000, burned=burned)
        self.assertEqual(r.pps, 8_887_780)
        self.assertEqual(r.wclaims, burned * r.pps // PRECISION)
        # 1 000 shares x 0.8887780 = 888.778 XLM. Had they exited at the unchanged last_pps they
        # would have taken 1 000 XLM — the 111.222 XLM difference is this round's capped upside,
        # borne by the shares that were actually at risk. That is what "exit at the round's own
        # price" means, and getting it wrong in either direction is D-32's shape.
        self.assertEqual(r.wclaims, 8_887_780_000)
        self.assertLess(r.wclaims, burned, "below what last_pps would have paid, since pps fell")
        self.assertEqual(r.locked_after, r.assets_R - r.wclaims)


class VoidAndUnresolved(unittest.TestCase):
    """The two branches §4 asks for alongside the settle pair: *"a void from the same bids"*."""

    def inputs(self, outcome: Outcome) -> RoundInputs:
        return RoundInputs(
            locked_at_open=LOCKED_AT_OPEN,
            shares_snapshot=SHARES_SNAPSHOT,
            last_pps=LAST_PPS,
            notional_sold=NOTIONAL_SOLD,
            premium_collected=PREMIUM_COLLECTED,
            burned_this_round=0,
            strike=STRIKE,
            fee_bps_snapshot=FEE_BPS,
            settle_bounty_bps=BOUNTY_BPS,
            outcome=outcome,
            spot=None,
        )

    def test_a_void_costs_depositors_nothing_and_pays_no_bounty(self) -> None:
        r = resolve(self.inputs(Outcome.VOIDED))
        self.assertEqual(r.pps, LAST_PPS, "premiums refunded, so pps is untouched")
        self.assertEqual(r.assets_R, LOCKED_AT_OPEN)
        self.assertEqual(r.bounty, 0, "D-51: a void bounty has no source")
        self.assertEqual(r.fee, 0, "nothing to take a fee on when the premium is refunded")
        self.assertEqual(r.payout_total, 0)

    def test_unresolved_is_the_settle_shape_with_payout_pinned_to_zero(self) -> None:
        r = resolve(self.inputs(Outcome.UNRESOLVED))
        otm = settled(4_200_000)  # a settle that paid nothing
        self.assertEqual(r.payout_total, 0)
        self.assertEqual(r.fee, otm.fee)
        self.assertEqual(r.bounty, otm.bounty, "it pays one, because the premium is retained")
        self.assertEqual(r.assets_R, otm.assets_R, "byte-identical to an out-of-the-money settle")
        self.assertEqual(r.pps, otm.pps)

    def test_waiting_is_worth_nothing_to_an_out_of_the_money_bidder(self) -> None:
        # D-59's whole point: a refund is what paid the bidder to wait. Retaining the premium makes
        # the unresolved outcome strictly better for depositors than a void, so letting the clock
        # run out gains the bidder nothing.
        void = resolve(self.inputs(Outcome.VOIDED))
        unresolved = resolve(self.inputs(Outcome.UNRESOLVED))
        self.assertGreater(unresolved.pps, void.pps)
        self.assertGreater(unresolved.assets_R, void.assets_R)


class RefusesWhereTheContractReverts(unittest.TestCase):
    """Every guard driven to fire — ``DEV-PROTOCOL.md`` §6.

    The reference must refuse wherever the contract reverts. Returning a plausible number where the
    Rust traps makes the diff green on an unreachable case, which is the same defect as a gate that
    only ever passes.
    """

    def base(self, **over: object) -> RoundInputs:
        kw: dict[str, object] = dict(
            locked_at_open=LOCKED_AT_OPEN,
            shares_snapshot=SHARES_SNAPSHOT,
            last_pps=LAST_PPS,
            notional_sold=NOTIONAL_SOLD,
            premium_collected=PREMIUM_COLLECTED,
            burned_this_round=0,
            strike=STRIKE,
            fee_bps_snapshot=FEE_BPS,
            settle_bounty_bps=BOUNTY_BPS,
            outcome=Outcome.SETTLED,
            spot=5_000_000,
        )
        kw.update(over)
        return RoundInputs(**kw)  # type: ignore[arg-type]

    def test_zero_shares_snapshot(self) -> None:
        # open_epoch rejects NoShares before such a round can exist, so the division is unreachable.
        with self.assertRaises(SettlementError):
            self.base(shares_snapshot=0)

    def test_negative_inputs(self) -> None:
        for field in ("locked_at_open", "premium_collected", "notional_sold", "burned_this_round"):
            with self.assertRaises(SettlementError, msg=field):
                self.base(**{field: -1})

    def test_a_non_positive_spot_never_reaches_the_settle_branch(self) -> None:
        # It classifies as DeadAtExpiry and takes the void branch (04-ORACLE §4).
        for spot in (0, -1):
            with self.assertRaises(SettlementError):
                self.base(spot=spot)

    def test_a_settle_with_no_spot(self) -> None:
        with self.assertRaises(SettlementError):
            self.base(spot=None)

    def test_a_lapse_with_fills_is_unreachable(self) -> None:
        with self.assertRaises(SettlementError):
            self.base(outcome=Outcome.LAPSED, spot=None, notional_sold=1)

    def test_a_fee_large_enough_to_drive_assets_R_negative_refuses(self) -> None:
        # §5: "a large enough value drove assets_R negative and wedged settle() on a checked
        # subtraction ... assets_R is asserted non-negative regardless." Validation caps fee_bps at
        # 2 000, so this needs an out-of-range rate — the point is that the reference refuses in the
        # same place rather than reporting a negative price.
        with self.assertRaises(SettlementError):
            resolve(
                self.base(
                    locked_at_open=0,
                    notional_sold=1,
                    premium_collected=1_000,
                    fee_bps_snapshot=100_000,
                    spot=5_000_000,
                    strike=1,
                )
            )

    def test_pps_of_zero_is_accepted_and_never_clamped(self) -> None:
        # D-66/§16: a pool worth less than one stroop per PRECISION share-units settles at pps 0,
        # and every holder must still be able to exit. Clamping to 1 would break the
        # wclaims <= assets_after chain and underflow locked_after.
        r = resolve(
            self.base(
                locked_at_open=0,
                premium_collected=0,
                notional_sold=1,
                strike=1,
                spot=2,
                settle_bounty_bps=0,
            )
        )
        self.assertEqual(r.assets_R, 0)
        self.assertEqual(r.pps, 0)
        self.assertEqual(r.wclaims, 0)
        self.assertEqual(r.locked_after, 0)


class TermsInIsolation(unittest.TestCase):
    """The three closed-form terms, and I3 over a spread of inputs."""

    def test_floor_direction_is_the_vaults_way_on_every_outbound_amount(self) -> None:
        # §6's table: payout_total, fee and pps all floor in the vault's favour.
        self.assertEqual(payout_total_of(1_000, 1, 3), 666)  # 1000 x 2/3 = 666.67 -> floors down
        self.assertEqual(payout_total_of(1_000, 100, 3), 0)  # spot below strike: out of the money
        self.assertEqual(fee_of(999, 1), 0)  # 0.0999 -> 0
        self.assertEqual(bounty_of(999, 1), 0)

    def test_I3_payout_is_strictly_below_notional_for_every_spot(self) -> None:
        # 05 §2: "payout_total < notional_sold for all spot", the property that makes bad debt
        # structurally impossible. 05 §4 records it holding over 200 000 randomised triples; this
        # is a deterministic sweep of the same claim across the extremes.
        for notional in (1, 100, 100_000 * XLM):
            for strike in (1, 4_400_000, 10**12):
                for spot in (strike, strike + 1, strike * 2, strike * 1_000, 10**18):
                    if spot < strike:
                        continue
                    self.assertLess(payout_total_of(notional, strike, spot), notional)

    def test_finalize_round_is_the_same_function_for_every_outcome(self) -> None:
        # The structural claim §5 makes: four call sites, identical bookkeeping. Same (pps,
        # assets_after, burned) must give the same (wclaims, locked_after) whatever the outcome
        # label is — if it did not, one branch would be able to forget the queue accounting, which
        # is the solvency bug found in review on 2026-08-16.
        args = dict(pps=PRECISION, assets_after=1_000 * XLM, burned_this_round=7 * XLM)
        results = {o: finalize_round(outcome=o, **args) for o in Outcome}  # type: ignore[arg-type]
        self.assertEqual(len(set(results.values())), 1, results)


if __name__ == "__main__":
    unittest.main()
