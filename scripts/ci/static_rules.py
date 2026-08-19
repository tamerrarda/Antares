#!/usr/bin/env python3
"""Two source rules that are cheap to state, easy to break, and invisible in review.

Both exist because a rule with no check decays. D-70 was written, applied to five
modules, and then broken by its own author on the first function added after it —
eight sites had drifted past budget by the time anyone measured, costing 1 453
bytes in a contract whose remaining headroom is four figures. That is the argument
for this file: not that the rules are subtle, but that nobody re-reads a rule.

Run locally with `python3 scripts/ci/static_rules.py`. Non-zero means a rule fired.
"""
import pathlib
import re
import sys

SRC = pathlib.Path("contracts/antares-vault/src")
DOC_BUDGET = 2


def sources():
    return [f for f in sorted(SRC.glob("*.rs")) if "test" not in f.name]


def abi_doc_budget():
    """`///` on an item the ABI can see is payload; `//` is free (D-70).

    Only items inside `#[contractimpl]` / `#[contracttype]` / `#[contracterror]`
    count. A long `///` on a private helper is free and is deliberately not
    flagged — `oracle.rs`'s `GuardOutcome` is a plain Rust enum and its nine-line
    doc costs nothing.
    """
    out = []
    for f in sources():
        lines = f.read_text().split("\n")
        inside = armed = False
        depth = run = start = 0
        for i, ln in enumerate(lines, 1):
            st = ln.strip()
            if st in ("#[contractimpl]", "#[contracttype]", "#[contracterror]"):
                armed = True
            if armed and re.match(r"(pub )?(impl |enum |struct )", st):
                inside, armed, depth = True, False, 0
            if inside:
                depth += ln.count("{") - ln.count("}")
                if depth <= 0 and "}" in ln and not re.match(
                    r"(pub )?(impl |enum |struct )", st
                ):
                    inside = False
            if st.startswith("///"):
                if run == 0:
                    start = i
                run += 1
                continue
            if run > DOC_BUDGET and inside:
                out.append(
                    f"{f}:{start}  {run} `///` lines on an ABI item "
                    f"(budget {DOC_BUDGET}) -> {st[:48]}"
                )
            run = 0
    return out


def write_once_fields():
    """`allowlist_expires_at` is written once, in `__constructor`, and never again.

    D-63 is that absence: the permissionless fallback is a property of the code's
    shape rather than an operational promise, and it stops being one the moment an
    admin can move the deadline. Every setter in `admin.rs` writes through
    `ctx.config.<field> = value`, so a setter for this field cannot exist without
    tripping this rule.

    The limit, stated rather than left for someone to discover: this catches the
    assignment form. A rebuild of the whole `Config` literal elsewhere would slip
    past, which is why `test_admin.rs` also asserts the behaviour.
    """
    out = []
    for f in sources():
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            if re.search(r"\.allowlist_expires_at\s*=[^=]", ln):
                out.append(
                    f"{f}:{i}  writes `allowlist_expires_at` outside "
                    f"`__constructor` -> {ln.strip()[:48]}  (D-63)"
                )
    return out


def main():
    failed = False
    for name, rule in (
        ("D-70 ABI doc budget", abi_doc_budget),
        ("D-63 write-once fields", write_once_fields),
    ):
        hits = rule()
        print(f"{'FAIL' if hits else 'ok  '}  {name}")
        for h in hits:
            print(f"        {h}")
        failed |= bool(hits)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
