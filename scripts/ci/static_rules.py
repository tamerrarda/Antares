#!/usr/bin/env python3
"""Every source rule that a grep can decide, in one runnable place.

Both halves of this file exist because a rule with no check decays, and because a
check nobody can run without pushing is a check that only fails after the push.

D-70 was written, applied to five modules, and then broken by its own author on the
first function added after it — eight sites had drifted past budget by the time
anyone measured, costing 1 453 bytes in a contract with four figures of headroom.
The greps below had the opposite problem: they were correct, and they lived inside
`ci.yml` where the only way to run them was to spend a CI run. Merging them here is
what makes the IP-only CI policy safe, because it leaves nothing that can only be
checked remotely.

Run locally with `python3 scripts/ci/static_rules.py`. Non-zero means a rule fired.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
VAULT_SRC = ROOT / "contracts/antares-vault/src"
CONTRACTS = ROOT / "contracts"
WORKFLOWS = ROOT / ".github"
DOC_BUDGET = 2

# `test.rs`, `tests.rs` and `test_*.rs`. Soroban's conventional `test.rs` was missed
# by an earlier draft that matched only `test_*.rs`, so all three shapes are named.
TEST_FILE = re.compile(r"^(test|tests|test_[a-z0-9_]+)\.rs$")


def rel(p):
    return p.relative_to(ROOT)


def rust_files(root):
    return sorted(root.rglob("*.rs"))


def vault_sources():
    """The vault's non-test code. Scope, not convenience — see `outbound_calls`."""
    return [f for f in rust_files(VAULT_SRC) if not TEST_FILE.match(f.name)]


# ---------------------------------------------------------------- D-70 ------
def abi_doc_budget():
    """`///` on an item the ABI can see is payload; `//` is free (D-70).

    Only items inside `#[contractimpl]` / `#[contracttype]` / `#[contracterror]`
    count. A long `///` on a private helper is free and is deliberately not
    flagged — `oracle.rs`'s `GuardOutcome` is a plain Rust enum and its nine-line
    doc costs nothing. A sweep that cut prose everywhere would have paid for the
    wrong thing.
    """
    out = []
    for f in vault_sources():
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
                    f"{rel(f)}:{start}  {run} `///` lines on an ABI item "
                    f"(budget {DOC_BUDGET}) -> {st[:48]}"
                )
            run = 0
    return out, []


# ---------------------------------------------------------------- D-63 ------
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
    for f in vault_sources():
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            if re.search(r"\.allowlist_expires_at\s*=[^=]", ln):
                out.append(
                    f"{rel(f)}:{i}  writes `allowlist_expires_at` outside "
                    f"`__constructor` -> {ln.strip()[:48]}  (D-63)"
                )
    return out, []


# ---------------------------------------------------------------- D-50 ------
def network_agnostic():
    """One wasm, two networks (D-50). 06-TEST-PLAN §8 owns the scope.

    A build that *can* behave differently on two networks has already lost the
    property the audit rests on, and this is D-50's only enforcer.

    `#[cfg(test)]` is allowed and everything else is not: a feature is selectable
    at build time, `#[cfg(test)]` cannot be selected into a release wasm by any
    invocation (06-TEST-PLAN §8, amended 2026-08-18 — the original text banned all
    conditional compilation and would have failed on the test suite itself).
    """
    out = []
    cfg = re.compile(r"#!?\[cfg(_attr)?\(")
    cfg_test = re.compile(r"#!?\[cfg(_attr)?\(test[,)]")
    for f in rust_files(CONTRACTS):
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            if cfg.search(ln) and not cfg_test.search(ln):
                out.append(f"{rel(f)}:{i}  conditional compilation -> {ln.strip()[:56]}")
    for f in sorted(CONTRACTS.rglob("Cargo.toml")):
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            if ln.startswith("[features]"):
                out.append(
                    f"{rel(f)}:{i}  a contract manifest declares features; with none "
                    f"declared there is nothing for #[cfg(feature=…)] to select"
                )
    net = re.compile(r'"[^"]*(testnet|mainnet)[^"]*"', re.I)
    for f in rust_files(CONTRACTS):
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            if net.search(ln):
                out.append(f"{rel(f)}:{i}  network name as a string literal -> {ln.strip()[:48]}")
    return out, []


# -------------------------------------------------------- 03-STORAGE-TTL ----
def no_temporary_storage():
    """03-STORAGE-TTL §1: the enforceable form is the *absence of any* call.

    A temporary entry that expires is a user who cannot reach their funds, and
    unlike persistent archival it is not recoverable.

    Comment lines are stripped first, and that is not a loosening. The plan
    explains this rule in prose in several places, and `test_storage.rs` explains
    why it never reaches for temporary storage — that sentence broke an earlier
    draft of this check. A check that reddens when somebody documents the rule is
    a check that gets switched off. The sentence stays where it is; it is now the
    fixture proving the fix.
    """
    out = []
    comment = re.compile(r"^[^\S\n]*(//|/\*|\*)")
    for f in rust_files(CONTRACTS):
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            if ".temporary()" in ln and not comment.match(ln):
                out.append(f"{rel(f)}:{i}  temporary() storage -> {ln.strip()[:56]}")
    return out, []


# ------------------------------------------------------------ 07-SECURITY ---
def outbound_calls():
    """07-SECURITY §3: the vault may not call an address it was not constructed with.

    SCOPE is the vault's non-test code, and that is the rule rather than a
    convenience. Run over `contracts/` as a whole this rejects two kinds of
    correct code — `reflector-adapter`'s own pinned client, which is the adapter's
    entire purpose, and every test that registers `MockPriceSource`. It rejected 12
    such sites on run 32194442229. A gate that fails on correct code is switched
    off within the week, and then nothing enforces this row at all. The adapter is
    covered instead by its no-setter surface assertion at deploy (09-DEPLOYMENT §2)
    and by 04-ORACLE §1's rule that no crate in its dependency graph carries a
    `#[contract]`.

    **A grep cannot follow data flow, and the fix is to stop implying that it
    does.** Every outbound client construction carries an `// outbound: config.asset`
    or `// outbound: config.oracle` marker. What this proves is not that the target
    is right — no regex can — but that no call site reached the default branch
    without a human naming which of the two it is, which is a claim a reviewer can
    actually check.
    """
    out, notes = [], []
    sources = vault_sources()
    if not sources:
        return ["the vault has no non-test sources — the scope is wrong, not the tree"], []

    # 1. Tests may not hide inside production files, or the file-based exclusion
    #    above is a guess rather than a rule. The one permitted use is a
    #    *declaration* — `#[cfg(test)] mod test_x;` — checked against the next
    #    non-blank line, because the two are conventionally written apart and a
    #    same-line check rejects every correct declaration in the repository.
    decl = re.compile(r"^\s*mod\s+[a-z0-9_]+\s*;")
    for f in sources:
        lines = f.read_text().split("\n")
        for i, ln in enumerate(lines):
            if re.search(r"#!?\[cfg\(test\)\]", ln):
                nxt = next((x for x in lines[i + 1:] if x.strip()), "")
                if not decl.match(nxt):
                    out.append(
                        f"{rel(f)}:{i + 1}  inline #[cfg(test)] module — vault tests live in "
                        f"test.rs, tests.rs or test_*.rs, and that separation is what makes "
                        f"the exclusion checkable"
                    )

    # 2. Every outbound client construction is declared, on its own line or the
    #    line above.
    ctor = re.compile(r"[A-Za-z_]*Client::new\(")
    marker = re.compile(r"//\s*outbound:\s*config\.(asset|oracle)\b")
    sites = 0
    for f in sources:
        lines = f.read_text().split("\n")
        for i, ln in enumerate(lines):
            if not ctor.search(ln):
                continue
            sites += 1
            above = lines[i - 1] if i else ""
            if not (marker.search(ln) or marker.search(above)):
                out.append(
                    f"{rel(f)}:{i + 1}  outbound client construction with no "
                    f"`// outbound: config.asset|oracle` marker -> {ln.strip()[:48]}"
                )
    if sites == 0:
        notes.append(
            "no cross-contract client construction in the vault yet — it gains its SAC "
            "and oracle clients in Phase 2; mandatory from there"
        )
    else:
        notes.append(f"{sites} outbound call site(s) inspected across {len(sources)} files")
    return out, notes


def no_signing_secrets():
    """07-SECURITY §6, the repository half — a claim about *this* repository.

    Checked here rather than promised in prose: no workflow may reference a secret
    that looks like it carries signing authority over the admin.
    """
    out = []
    pat = re.compile(
        r"secrets\.[A-Za-z0-9_]*(ADMIN|SECRET_KEY|SEED|SIGNER|MNEMONIC|PRIVATE)", re.I
    )
    for f in sorted(WORKFLOWS.rglob("*")):
        if not f.is_file():
            continue
        try:
            text = f.read_text()
        except UnicodeDecodeError:
            continue
        for i, ln in enumerate(text.split("\n"), 1):
            if pat.search(ln):
                out.append(f"{rel(f)}:{i}  workflow references a signing-capable secret")
    return out, []


def workflow_keys_unique():
    """No duplicate mapping key in any workflow file.

    This rule exists because it cost two CI runs. A second job keyed `static-rules`
    was added beside the existing one; GitHub rejects the file outright, but a
    plain `yaml.safe_load` **silently keeps the last of a duplicate pair**, so the
    local validation printed "yaml valid" both times and proved nothing. That is
    the same shape as every other defect this month: a check returning a benign
    value while nothing exercises it.

    A missing PyYAML fails this rule rather than skipping it. A dependency that
    disappears must not look like a pass.
    """
    out = []
    try:
        import yaml
    except ImportError:
        return ["PyYAML is not installed, so duplicate workflow keys cannot be checked "
                "— install it rather than treating this as a pass"], []

    class Strict(yaml.SafeLoader):
        pass

    def no_dupes(loader, node, deep=False):
        seen = {}
        for k, v in node.value:
            key = loader.construct_object(k, deep=deep)
            if key in seen:
                out.append(
                    f"duplicate key `{key}` at line {k.start_mark.line + 1} "
                    f"(first seen at line {seen[key] + 1}) — GitHub rejects the file, "
                    f"and yaml.safe_load would silently keep the last one"
                )
            seen[key] = k.start_mark.line
        return yaml.SafeLoader.construct_mapping(loader, node, deep)

    Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, no_dupes)

    for f in sorted((WORKFLOWS / "workflows").glob("*.yml")):
        before = len(out)
        try:
            yaml.load(f.read_text(), Loader=Strict)
        except yaml.YAMLError as e:
            out.append(f"{rel(f)}: does not parse — {str(e)[:80]}")
        for i in range(before, len(out)):
            out[i] = f"{rel(f)}: {out[i]}"
    return out, []


RULES = (
    ("D-70 ABI doc budget", abi_doc_budget),
    ("D-63 write-once fields", write_once_fields),
    ("D-50 network-agnostic build", network_agnostic),
    ("03-STORAGE-TTL no temporary() storage", no_temporary_storage),
    ("07-SECURITY §3 outbound calls declared", outbound_calls),
    ("07-SECURITY §6 no signing-capable secret", no_signing_secrets),
    ("workflow keys unique", workflow_keys_unique),
)


def main():
    failed = False
    for name, rule in RULES:
        hits, notes = rule()
        print(f"{'FAIL' if hits else 'ok  '}  {name}")
        for n in notes:
            print(f"        note: {n}")
        for h in hits:
            print(f"        {h}")
        failed |= bool(hits)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
