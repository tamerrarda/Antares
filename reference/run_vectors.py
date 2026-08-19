#!/usr/bin/env python3
"""run_vectors.py — the vector replay harness. **No protocol math lives here.**

``06-TEST-PLAN.md`` §5 defines the vector schema, the module chain and the invocation contract;
this implements them and restates neither. The chain::

    bids --curve_ref--> fills --settle_ref--> pps/assets_R/payout/fee/bounty/wclaims/locked_after
                                          --claims_ref--> per_bidder / withdraw_claims

Each module is authored by whoever does **not** write its Rust (`DEV-PROTOCOL.md` §4), which is
the whole reason the layer is worth running: three independent derivations of one specification,
diffed against one implementation.

Usage
=====

``run_vectors.py --out <path>``
    Replay every vector and write one canonical document. This is the form the CI job's Python
    side uses.

``run_vectors.py`` (no arguments)
    Replay every vector and diff each module's output against that vector's own ``expected``
    block, which for the hand-written vectors carries numbers **a human derived from
    05-AUCTION-SETTLEMENT §4 and printed in the document**. Exits non-zero on any mismatch.

    That is a real check and not a placeholder: it pins three independent Python derivations
    against the specification's own worked example, before any Rust is involved. It is *not* the
    Rust-versus-Python diff — that needs the Rust replay and is a Phase-4 gate — and this file
    does not claim otherwise anywhere it is invoked.

Canonical form
==============

JSON, keys sorted, integers as JSON numbers, no floats anywhere, ``\\n``-terminated. Two
implementations have to be able to emit the same bytes without agreeing on a formatter, which is
what makes a byte-for-byte diff meaningful rather than a formatting comparison.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import claims_ref
import curve_ref
import settle_ref

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
HAND_WRITTEN = REPO / "test-vectors"
GENERATED = HAND_WRITTEN / "generated"
COVERAGE = HAND_WRITTEN / "coverage.json"


def diffable_sections() -> list[str]:
    """The sections both sides can produce, from `test-vectors/coverage.json`.

    Read rather than hardcoded, and read by the Rust side too — which asserts that what it emits is
    exactly this list. So the scope of the diff is one committed fact that neither side can drift
    from silently, and it widens by one line in the same commit as the replay that earns it.
    """
    import json as _json

    return list(_json.loads(COVERAGE.read_text())["sections"])


class VectorError(ValueError):
    """A malformed vector — distinct from a disagreement, which is a finding rather than a bug."""


def load_vectors() -> list[tuple[str, dict]]:
    """Every vector, hand-written first, then generated. An empty ``generated/`` is not a failure.

    Sorted by name so the canonical document is stable across filesystems — a diff that depends on
    directory order is a diff that fails for the wrong reason on someone else's machine.
    """
    out: list[tuple[str, dict]] = []
    for directory in (HAND_WRITTEN, GENERATED):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.json")):
            # `coverage.json` lives here because both sides read it and this is the shared home for
            # the vectors; it is not one. Skipped by name on both sides rather than moved, so the
            # scope declaration sits next to what it scopes.
            if path.name == COVERAGE.name:
                continue
            out.append((path.name, json.loads(path.read_text())))
    if not out:
        raise VectorError(f"no vectors found under {HAND_WRITTEN}")
    return out


def curve_inputs(vector: dict) -> dict:
    """Flatten §5's document into the shape ``curve_ref.compute`` reads.

    **This shim should not be necessary and is flagged as a finding rather than absorbed.**
    ``06-TEST-PLAN.md`` §5's schema is nested — ``params``/``initial``/``open``, and
    ``bids: [{at, bidder, requested, max_premium_bps}]``. ``claims_ref.compute`` reads that
    document directly. ``curve_ref.compute`` reads a *flat* dict with ``notional_offered`` at the
    top level and per-bid ``now``/``notional``, so the two references disagree with **each other**
    about what a module's entry point receives, and §5 does not say which is right.

    A harness can adapt to either; what it cannot do is tell the next module's author which one to
    write against. So the mapping is written out explicitly here, one line per field, so a reviewer
    can check it — and §5 needs an entry-point contract so this shim can be deleted.

    ``notional_offered`` is not a schema field at all and does not need to be: ``open_epoch`` sets
    it from ``locked_assets`` (02-CONTRACT-SPEC §5 step 3), and mints happen only in Idle, so
    ``initial.locked`` *is* the offer.
    """
    params = vector["params"]
    return {
        "notional_offered": vector["initial"]["locked"],
        "notional_sold": 0,
        "min_fill": params["min_fill"],
        "premium_start_bps": params["premium_start_bps"],
        "premium_floor_bps": params["premium_floor_bps"],
        "auction_duration": params["auction_duration"],
        "opened_at": vector["open"]["at"],
        "auction_end": vector["open"]["at"] + params["auction_duration"],
        "bids": [
            {
                "bidder": bid["bidder"],
                "now": bid["at"],
                "notional": bid["requested"],
                "max_premium_bps": bid["max_premium_bps"],
            }
            for bid in vector["bids"]
        ],
    }


def replay(name: str, vector: dict) -> dict:
    """Run one vector through all three modules and return the three output sections.

    No arithmetic — every number below is produced by a reference module. If this function ever
    computes one, the layer has quietly acquired a fourth derivation that nothing diffs.
    """
    curve = curve_ref.compute(curve_inputs(vector))
    settle = settle_ref.compute(vector, curve)

    # **The chain is made real here, and that it has to be is a finding.**
    #
    # `claims_ref.compute` reads its fills from `vector["expected"]["fills"]` — the hand-written
    # answer — rather than from the previous stage's product. It chains `settle` correctly and not
    # `fills`. 06-TEST-PLAN §5 is explicit that the schema "runs as a chain, each module's output
    # feeding the next's input", and its own note gives the reason: "a reference module whose
    # product is handed to it as a given has nothing to diff". Left alone, a wrong `curve_ref`
    # would not move `claims_ref` by a stroop, because `claims_ref` never sees it.
    #
    # So the harness substitutes curve_ref's *computed* fills for the expected ones before
    # handing the vector on. The field names are curve_ref's per-bid results mapped to the names
    # claims_ref reads (`filled`, `premium`, `bidder`), which are §5's schema names.
    # **Chained from curve_ref's `fills`, which are per-bidder and accumulated — not from `bids`,
    # which are per-bid.** The generated corpus found this: with `bids` a bidder who bid twice gets
    # two entries and `claims_ref` computes two payouts for them, while `claim_payout` pays once
    # against the accumulated `Fill`. Four hand-written vectors, none with a re-bid, could not show
    # it. The field names are the ones `claims_ref` reads.
    chained = dict(vector)
    chained["expected"] = dict(vector.get("expected", {}))
    chained["expected"]["fills"] = [
        {"bidder": f["bidder"], "filled": f["notional"], "premium": f["premium_paid"]}
        for f in curve["fills"]
    ]
    claims = claims_ref.compute(chained, settle)

    return {
        "vector": name,
        # Both halves of curve_ref's product, because they are different things and §5's schema
        # conflates them (see the finding in `curve_inputs`): `bids` is the per-bid outcome,
        # `fills` the accumulated per-bidder record that re-bids sum into.
        "curve_ref": {
            "bids": curve["bids"],
            "fills": curve["fills"],
            "notional_sold": curve["notional_sold"],
            "premium_collected": curve["premium_collected"],
            "sold_out": curve["sold_out"],
        },
        "settle_ref": settle,
        "claims_ref": claims,
    }


def project(result: dict, paths: list[str]) -> dict:
    """Keep exactly the declared paths, which may name a key inside a section.

    Path granularity rather than whole sections, because `claims_ref` splits across two owners:
    `per_bidder` is `claim_payout`/`claim_refund` and exists in Rust, while `withdraw_claims` is
    `claim_withdraw` and needs a settle replay for `pps`. Emitting the whole section would claim
    coverage of a half nobody replayed.
    """
    out: dict = {"vector": result["vector"]}
    for path in paths:
        head, _, tail = path.partition(".")
        if head not in result:
            continue
        if tail:
            out.setdefault(head, {})[tail] = result[head][tail]
        else:
            out[head] = result[head]
    return out


def canonical(document: object) -> str:
    """JSON that two implementations can emit identically without sharing a formatter."""
    return json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n"


def compare_to_expected(result: dict, vector: dict) -> list[str]:
    """Diff one replay against the vector's own ``expected`` block.

    Returns a list of human-readable disagreements, empty when they agree. **A disagreement is a
    finding, not a bug to be patched here** — 06-TEST-PLAN §5 and the reading rule both say it goes
    back to the specification, never to the other side's source.
    """
    expected = vector.get("expected")
    if not expected:
        return []

    problems: list[str] = []

    def check(section: str, field: str, got: object, want: object) -> None:
        if got != want:
            problems.append(f"  {section}.{field}: replay {got!r} != vector {want!r}")

    for field in ("payout_total", "fee", "bounty", "assets_R", "pps", "wclaims", "locked_after"):
        if field in expected:
            check("settle_ref", field, result["settle_ref"][field], expected[field])

    if "fills" in expected:
        # §5's `expected.fills` is the **per-bid** shape (`filled`, `premium_bps_at`, `premium`),
        # so it compares against curve_ref's `bids`, not its accumulated `fills`.
        got = result["curve_ref"]["bids"]
        want = expected["fills"]
        if len(got) != len(want):
            problems.append(f"  curve_ref.bids: {len(got)} fills, vector expects {len(want)}")
        else:
            for i, (g, w) in enumerate(zip(got, want)):
                check(f"curve_ref.bids[{i}]", "bidder", g.get("bidder"), w["bidder"])
                check(f"curve_ref.bids[{i}]", "filled", g.get("filled"), w["filled"])
                check(f"curve_ref.bids[{i}]", "premium", g.get("premium"), w["premium"])
                # §5 calls it `premium_bps_at`; curve_ref emits `premium_bps`. A name difference,
                # recorded rather than silently normalized — see the finding in `curve_inputs`.
                check(f"curve_ref.bids[{i}]", "premium_bps", g.get("premium_bps"), w["premium_bps_at"])

    for section, key in (("claims_ref", "per_bidder"), ("claims_ref", "withdraw_claims")):
        if key in expected:
            check(section, key, result[section].get(key), expected[key])

    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        help="write the canonical replay document here (the CI job's Python side)",
    )
    parser.add_argument(
        "--only",
        choices=("curve",),
        help=(
            "emit only the named section. **The Rust side does not yet replay settle or claims** "
            "-- those need `finalize_round` and the claim paths driven from Rust, which are DEV1's "
            "and DEV2's halves. A diff over a subset is honest only if it names the subset, so "
            "this is an explicit flag rather than an intersection computed silently."
        ),
    )
    args = parser.parse_args(argv)

    vectors = load_vectors()
    results = [replay(name, vector) for name, vector in vectors]

    # `--out` emits exactly the sections the Rust side can also produce, so the two documents are
    # comparable byte for byte. `--only` narrows further, for a targeted local run.
    sections = diffable_sections()
    if args.only is not None:
        sections = [s for s in sections if s == f"{args.only}_ref"] or [f"{args.only}_ref"]

    if args.out is not None:
        results = [project(r, sections) for r in results]
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(canonical(results))
        print(f"replayed {len(results)} vector(s) -> {args.out}")
        print(f"sections in this document: {', '.join(sections)}  (test-vectors/coverage.json)")
        not_yet = json.loads(COVERAGE.read_text()).get("not_yet_replayed_in_rust", {})
        for name, why in not_yet.items():
            print(f"  NOT diffed: {name} — {why}")
        return 0

    # No `--out`: pin the three Python derivations against the specification's own worked example.
    failures = 0
    for result, (name, vector) in zip(results, vectors):
        problems = compare_to_expected(result, vector)
        if problems:
            failures += 1
            print(f"DISAGREES  {name}", file=sys.stderr)
            for line in problems:
                print(line, file=sys.stderr)
        else:
            print(f"ok         {name}")

    print(f"\n{len(results) - failures}/{len(results)} vectors match their expected block")
    if failures:
        print(
            "\nA disagreement here is the layer working. Take it to 02-CONTRACT-SPEC §5-§6 and\n"
            "05-AUCTION-SETTLEMENT §1/§4 — never to the other side's source (06-TEST-PLAN §5).",
            file=sys.stderr,
        )
        return 1

    print(
        "\nNote: this is the Python side against the vectors' own numbers, not the Rust-versus-\n"
        "Python diff. The diff is runnable today for the curve section, whose two halves both\n"
        "exist -- curve_ref.py (DEV1) and auction.rs (DEV3):\n"
        "\n"
        "  python3 reference/run_vectors.py --only curve --out target/vector-diff/python.json\n"
        "  ANTARES_VECTOR_OUT=$PWD/target/vector-diff/rust.json \\\n"
        "    cargo test -p antares-vault vector_replay\n"
        "  diff -u target/vector-diff/python.json target/vector-diff/rust.json\n"
        "\n"
        "settle and claims need finalize_round and the claim paths replayed from Rust, which are\n"
        "DEV1's and DEV2's halves. Phase-4 gate (06-TEST-PLAN §5's invocation contract)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
