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
import ast
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
    """No duplicate sibling key in any workflow file.

    This rule exists because it cost two CI runs. A second job keyed `static-rules`
    was added beside the existing one; GitHub rejects the file outright, but a plain
    `yaml.safe_load` **silently keeps the last of a duplicate pair**, so the local
    validation printed "yaml valid" both times and proved nothing.

    **It then cost a third run for the opposite reason, and that is why it is written
    this way.** The first version imported PyYAML. PyYAML is absent from the runner —
    `actions/setup-python` provides a clean interpreter, which is exactly the trap,
    since the system Python has it and local runs passed. The rule refused rather than
    skipping, which was correct and was still a failed job: `wasm` needs
    `static-rules` and `reproducible` needs `wasm`, so D-50's two-checkout evidence
    never ran.

    `reference/requirements.txt` had already written the principle down one directory
    over — *there is nothing to install*, because a dependency is a second
    implementation of something we would then be trusting rather than checking. This
    file broke that principle and got bitten at precisely the point where it broke it.
    **A local check is only as portable as its imports**, and a job named "runnable
    locally" is not, if it is runnable only for people who happened to run a pip
    install.

    **What this scan does and does not do, stated rather than implied.** It compares
    sibling keys at each indentation level, which is where duplicates are rejected by
    YAML and where both real failures lived. It understands block scalars (`|`, `>`
    and their chomping forms), comments and list items, because without those it would
    report duplicates that are not there — and a check that cries wolf is switched off
    within the week, which this repository has already recorded once. It does **not** parse
    flow mappings written on one line (`{a: 1, a: 2}`) — measured: a strict loader finds
    that duplicate and this scan does not. **So it refuses them rather than passing
    them.** No workflow here uses one, and this rule's whole contract is that it cannot
    silently pass; a construct it cannot check has to be a failure, or the gap becomes
    the next thing somebody finds the expensive way.
    """
    out = []
    key_re = re.compile(r"^(\s*)(-\s+)?((?:[A-Za-z0-9_.\-]+|\"[^\"]*\"|'[^']*')):(\s|$)")
    block_re = re.compile(r":\s*[|>][+-]?\d*\s*(#.*)?$")
    # `${{ ... }}` is GitHub expression syntax, not a YAML flow mapping — excluded, or
    # every workflow line carrying one would be refused.
    flow_re = re.compile(r"(?<![$\w])\{(?!\{)[^}]*:")

    for f in sorted((WORKFLOWS / "workflows").glob("*.yml")):
        stack = []            # [indent, {key: first_line}]
        block_indent = None
        for n, ln in enumerate(f.read_text().split("\n"), 1):
            if block_indent is not None:
                if not ln.strip():
                    continue
                if len(ln) - len(ln.lstrip()) > block_indent:
                    continue
                block_indent = None
            if not ln.strip() or ln.lstrip().startswith("#"):
                continue
            if flow_re.search(ln):
                out.append(
                    f"{rel(f)}:{n}  flow mapping — this rule scans block style only and "
                    f"cannot decide duplicates inside `{{...}}`. Rewrite it in block "
                    f"style or widen the rule; it will not pass what it cannot check"
                )
                continue
            m = key_re.match(ln)
            if not m:
                continue
            pad, dash, key = m.group(1), m.group(2), m.group(3)
            indent = len(pad) + (len(dash) if dash else 0)

            while stack and stack[-1][0] > indent:
                stack.pop()
            if dash:
                # A new list element is a new mapping, so its keys are not siblings of
                # the previous element's. Without this every step's `name:` collides.
                while stack and stack[-1][0] >= indent:
                    stack.pop()
                stack.append([indent, {}])
            if not stack or stack[-1][0] < indent:
                stack.append([indent, {}])

            seen = stack[-1][1]
            if key in seen:
                out.append(
                    f"{rel(f)}:{n}  duplicate key `{key}` (first seen at line {seen[key]}) "
                    f"— GitHub rejects the file, and yaml.safe_load would keep the last one"
                )
            else:
                seen[key] = n

            if block_re.search(ln):
                block_indent = indent
    return out, []


def python_is_stdlib_only():
    """Every Python file this project runs locally imports the standard library only.

    Written the day the audit was asked for, because doing the audit once is weaker
    than making it permanent — the next dependency arrives in somebody else's commit.

    `reference/requirements.txt` already stated the principle for the references: there
    is nothing to install, because a dependency is a second implementation of something
    we would then be trusting rather than checking, and numpy is barred there by name
    for wrapping silently on integer overflow. This extends the same rule to
    `scripts/ci/`, which broke it and lost a CI run — PyYAML is absent from the runner's
    clean interpreter, the rule that needed it refused rather than skipping, and `wasm`
    and `reproducible` were skipped beneath it, taking D-50's two-checkout evidence with
    them.

    `sys.stdlib_module_names` is itself standard library, so this rule cannot violate
    the rule it enforces.
    """
    out = []
    stdlib = set(sys.stdlib_module_names)
    for d in (ROOT / "scripts/ci", ROOT / "reference"):
        for f in sorted(d.glob("*.py")):
            tree = ast.parse(f.read_text())
            local = {q.stem for q in d.glob("*.py")}
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    names = [node.module.split(".")[0]]
                for name in names:
                    if name in stdlib or name in local:
                        continue
                    out.append(
                        f"{rel(f)}:{node.lineno}  imports `{name}`, which is neither "
                        f"standard library nor a sibling module — a local check is only "
                        f"as portable as its imports"
                    )
    return out, []


def typescript_declarations_are_unique():
    """No top-level identifier declared twice in one TypeScript file.

    Git merged two `asBool` implementations into `packages/common/events.ts` — DEV1
    and DEV2 wrote the same helper in different places, so neither side touched the
    other's lines and **the merge was clean.** The file then declared the identifier
    twice and nothing marked it. **A clean merge is not evidence of no collision**,
    and the only thing that would have caught it is a typecheck, which does not run
    on a branch push under the integration-point CI policy.

    Overload signatures are not duplicates: those end in `;` and carry no body, and
    flagging them would redden correct code — the failure mode this repository has
    already recorded once and will not repeat. Only implementations count, so a
    declaration is one whose line ends in `{` or `=`.
    """
    out = []
    decl = re.compile(
        r"^(?:export\s+)?(?:default\s+)?"
        r"(function|class|const|let)\s+([A-Za-z_$][\w$]*)\b(.*)$"
    )
    for f in sorted(ROOT.glob("packages/**/*.ts")) + sorted(ROOT.glob("scripts/**/*.ts")):
        if "node_modules" in f.parts:
            continue
        seen = {}
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            m = decl.match(ln)
            if not m:
                continue
            kind, name, rest = m.groups()
            if kind == "function" and rest.rstrip().endswith(";"):
                continue  # an overload signature, not an implementation
            if name in seen:
                out.append(
                    f"{rel(f)}:{i}  `{name}` is declared again (first at line {seen[name]}) "
                    f"— two people can add the same helper in different places and git "
                    f"will merge both without a conflict"
                )
            else:
                seen[name] = i
    return out, []


def oracle_calls_are_recoverable():
    """04-ORACLE §3b: the vault never calls the price source in a form that can trap it.

    A cross-contract call that panics propagates and kills the caller. A bare
    `client.reading(...)` therefore lets an adapter that traps — wrong interface,
    archived instance, its own internal panic — make **every** branch of
    `close_round` revert forever and permanently trap every depositor's collateral.
    That is the one failure this design promises cannot exist, and `oracle.rs`'s
    step 0 says so in those words.

    Five call sites obey it today and nothing was checking. The rule lived in the
    prose and in comments beside the code that already followed it, which is the
    weakest place a rule can live: a sixth site added later compiles, passes every
    test that does not happen to register a trapping adapter, and reintroduces the
    trap silently.

    **What a grep can decide here.** `PriceSource` has exactly three methods, and
    their names are distinctive enough to match on: any `.reading(`, `.spot_check(`
    or `.supports_round(` in the vault's non-test code must be spelled `try_`.
    The free `price_source_api::supports_round` helper is a local computation and
    is reached through `::`, so it is not matched — deliberately, and verified
    against the tree rather than assumed.
    """
    methods = ("reading", "spot_check", "supports_round")
    bare = re.compile(r"\.\s*(?!try_)(" + "|".join(methods) + r")\s*\(")
    recoverable = re.compile(r"\.\s*try_(" + "|".join(methods) + r")\s*\(")
    out, sites = [], 0
    for f in vault_sources():
        for i, ln in enumerate(f.read_text().split("\n"), 1):
            code = ln.split("//", 1)[0]
            if recoverable.search(code):
                sites += 1
            m = bare.search(code)
            if m:
                out.append(
                    f"{rel(f)}:{i}  `{m.group(1)}` called without the recoverable `try_` form "
                    f"— a trapping adapter would take the whole call down with it -> {code.strip()[:48]}"
                )
    notes = [f"{sites} price-source call site(s), all through the recoverable form"] if sites else [
        "the vault makes no price-source call yet — mandatory from the day it does"
    ]
    return out, notes


def landing_links_match_the_app():
    """The landing page's three outbound links agree with `web/lib/links.ts`.

    The app reads them from that module; the landing page is a static file and
    cannot, so the two can drift — and a docs link that is right in one surface and
    stale in the other is worse than no link, because a reader has no way to know
    which one is lying.

    The empty case is checked in both directions, and that is the half worth
    stating: while `FEEDBACK` is empty the landing page must render the control
    disabled rather than as an `href`, because a link that looks like a destination
    and goes nowhere is the defect this whole file exists to catch a class of.
    """
    links = ROOT / "web/lib/links.ts"
    landing = ROOT / "web/landing/index.html"
    if not links.exists() or not landing.exists():
        return [], ["web/lib/links.ts or web/landing/index.html absent — nothing to compare"]

    src = links.read_text()
    consts = dict(re.findall(r'export const (\w+) = "([^"]*)"', src))
    html = landing.read_text()
    foot = re.search(r'<footer class="foot">(.*?)</footer>', html, re.S)
    if not foot:
        return [f"{rel(landing)}  no <footer class=\"foot\"> to compare against"], []
    block = foot.group(1)

    out, notes = [], []
    for name in ("DOCS", "REPO"):
        url = consts.get(name)
        if not url:
            out.append(f"{rel(links)}  {name} is missing or empty; the landing page links to it")
        elif f'href="{url}"' not in block:
            out.append(
                f"{rel(landing)}  the {name.lower()} link does not match links.ts "
                f"-> expected {url}"
            )
        else:
            notes.append(f"{name} agrees: {url}")

    feedback = consts.get("FEEDBACK", "")
    has_link = re.search(r'<a[^>]*>\s*Feedback', block, re.I) is not None
    disabled = 'aria-disabled="true"' in block
    if feedback and not has_link:
        out.append(f"{rel(landing)}  FEEDBACK is set but the landing page still renders it disabled")
    if not feedback:
        if has_link:
            out.append(
                f"{rel(landing)}  FEEDBACK is empty and the landing page links it anyway "
                "— a destination that does not exist"
            )
        elif disabled:
            notes.append("FEEDBACK is empty and both surfaces render it disabled")
    return out, notes


RULES = (
    ("D-70 ABI doc budget", abi_doc_budget),
    ("D-63 write-once fields", write_once_fields),
    ("D-50 network-agnostic build", network_agnostic),
    ("03-STORAGE-TTL no temporary() storage", no_temporary_storage),
    ("07-SECURITY §3 outbound calls declared", outbound_calls),
    ("04-ORACLE §3b price-source calls are recoverable", oracle_calls_are_recoverable),
    ("07-SECURITY §6 no signing-capable secret", no_signing_secrets),
    ("workflow keys unique", workflow_keys_unique),
    ("python is standard-library only", python_is_stdlib_only),
    ("typescript declarations are unique", typescript_declarations_are_unique),
    ("landing links match the app", landing_links_match_the_app),
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
