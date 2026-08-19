#!/usr/bin/env bash
#
# The network-agnostic check — TypeScript scope (D-50).
#
# `06-TEST-PLAN.md` §8 is the single home for this check's scope and its exemptions; read them
# there, not from this file. The short form, so a reader of a failure knows what was applied:
#
#   scope   keeper/ bidder/ web/ integration/ packages/ scripts/
#   rules   no hardcoded network passphrases; no hardcoded contract addresses
#   exempt  packages/common/networks.ts, deployments/*.json
#
# **The exemption is the point of the rule rather than a hole in it.** The values have to live
# somewhere; the check exists to prove they live *only* there.
#
# ------------------------------------------------------------------------------------------------
# Why this is a script and not inline YAML
#
# DEV1's repair of the outbound-call grep recorded the failure mode: their first harness ran a
# *hand-copied paraphrase* of the workflow step, so the harness and CI could disagree, and they fixed
# it by extracting the step's script out of the YAML at test time. A shared file removes the same
# failure by construction instead — `ci.yml` calls this, `test-network-agnostic-ts.sh` calls this, and
# there is no second copy for the two to drift apart in. It is also runnable locally, which is what
# makes "verified locally" mean something: DEV1 measured that their zsh/ugrep box and the runner's
# bash/GNU grep disagreed, and one script invoked the same way from both is the only fix for that
# which does not depend on remembering.
#
# Usage:  network-agnostic-ts.sh [repo-root]
# Exit:   0 clean, 1 a rule was violated, 2 the check could not run
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

# 06-TEST-PLAN §8's TypeScript scope, verbatim.
SCOPES=(keeper bidder web integration packages scripts)

# 06-TEST-PLAN §8's two exempt paths.
EXEMPT=(packages/common/networks.ts)
EXEMPT_GLOB='^deployments/[^/]*\.json$'

# Code, not prose. The rule is about what a build can *do* on two networks, and a README that names
# an address changes no behaviour — while a check that rejects documentation is one somebody switches
# off, which is how this project has already lost a gate three times.
CODE_EXT='\.(ts|tsx|js|jsx|mjs|cjs|json)$'

fail=0
scanned=0
absent=()

# One function, one array, nothing word-split — DEV1 measured a check whose result depended on which
# shell ran it, because the file list was passed by bare word-splitting. Tracked files only, via
# `git ls-files`: it can never reach `node_modules/`, and it can never reach an uncommitted
# `packages/common/dist/`, which *does* legitimately contain the passphrase after a local build. A
# recursive grep would flag that build output and be wrong about it.
collect_files() {
  local dir tracked
  for dir in "${SCOPES[@]}"; do
    if [ ! -d "$dir" ]; then
      absent+=("$dir")
      continue
    fi
    while IFS= read -r tracked; do
      [ -n "$tracked" ] || continue
      printf '%s\n' "$tracked"
    done < <(git ls-files -- "$dir")
  done
}

is_exempt() {
  local f="$1" e
  for e in "${EXEMPT[@]}"; do
    [ "$f" = "$e" ] && return 0
  done
  [[ "$f" =~ $EXEMPT_GLOB ]] && return 0
  return 1
}

FILES=()
while IFS= read -r f; do
  [[ "$f" =~ $CODE_EXT ]] || continue
  is_exempt "$f" && continue
  FILES+=("$f")
done < <(collect_files)

scanned=${#FILES[@]}

echo "--- scope ---"
echo "scanned ${scanned} tracked code file(s) across: ${SCOPES[*]}"
if [ ${#absent[@]} -gt 0 ]; then
  # Named rather than skipped silently. A check that goes green because its subject does not exist
  # has proved nothing, and this file refuses to imply otherwise (the convention `ci.yml` already
  # follows for the Rust jobs whose inputs are unwritten).
  echo "::notice::not present yet, so not scanned: ${absent[*]} — each becomes mandatory when its phase lands (DEV3.md)"
fi
for e in "${EXEMPT[@]}"; do
  if [ -f "$e" ]; then
    echo "exempt, and required to exist: $e"
  else
    echo "::notice::exempt path $e does not exist yet — the rule has no valid target until it does (06-TEST-PLAN §8)"
  fi
done

# Whole-line comments are not build behaviour.
#
# DEV1 hit this exact shape on 2026-08-19: the `temporary()` grep matched a *comment* in
# `test_storage.rs` explaining why that file never reaches for temporary storage. Their reading is the
# right one and it transfers unchanged — 03-STORAGE-TTL §1's rule is the absence of a temporary
# *call*, and D-50's is that a build must not be able to behave differently on two networks. **A
# comment does neither.** Third instance this week of a gate failing on correct code, which is the
# pattern, not three accidents.
#
# **Only whole comment lines are dropped, and inline stripping is deliberately not attempted.**
# Cutting from the first `//` to end of line looks equivalent and is not: `const u = "http://x"`
# contains `//` inside a string, so a line carrying both a URL and a passphrase would be truncated
# *before* the passphrase and the rule would silently stop firing. A false negative in a security
# check is strictly worse than being over-strict, so a passphrase sitting after code on the same line
# is still rejected — and the fix for that is to put the prose on its own line.
strip_comment_lines() {
  sed -E 's/^[[:space:]]*(\/\/|\*\/|\/\*|\*)([[:space:]].*|.*)?$//'
}

run_rule() {
  local title="$1" pattern="$2" message="$3" hits="" f=""
  echo "--- ${title} ---"
  if [ "$scanned" -eq 0 ]; then
    echo "no files in scope"
    return 0
  fi
  # -H so the filename is printed even when exactly one file is passed. DEV1 found `grep -n` omits
  # it in that case and the parser then reads the match as the path — latent until the tree happens
  # to have one file in scope, which is a state this repository has been in twice this week.
  #
  # Piped per file rather than passing the whole list to one grep, because the comment stripping has
  # to happen before the match and a pipeline loses which file a line came from. `grep -Hn` with the
  # filename supplied via a label keeps the report identical to the un-stripped form.
  for f in "${FILES[@]}"; do
    hits+=$(strip_comment_lines <"$f" | grep -HnE --label="$f" "$pattern" || true)
    [ -n "$hits" ] && hits+=$'\n'
  done
  hits=$(printf '%s' "$hits" | sed '/^$/d')
  if [ -n "$hits" ]; then
    echo "::error::${message}"
    echo "$hits"
    fail=1
  else
    echo "none"
  fi
}

# Rule 1 — network passphrases. Matched on the shared suffix rather than the two full strings, so a
# mistyped or invented variant is caught too: anything claiming to be a Stellar network passphrase
# carries it, and nothing else in a codebase does.
run_rule "hardcoded network passphrases" \
  '; September 2015' \
  "A network passphrase is hardcoded. It belongs in packages/common/networks.ts, which is the single home for it (08-OFFCHAIN §1, 06-TEST-PLAN §8) — and note there is deliberately no passphrase override: signing for the wrong network is the failure this rule exists to prevent."

# Rule 2 — contract addresses. A strkey is 56 characters of base32 after its type byte; `C` is a
# contract and `G` an account. Accounts are included on purpose: the admin address the testnet banner
# displays (07-SECURITY §2) and the fee recipient are read from the deployment record, never compiled
# in, and a check that caught only `C` would let the operator's own identity be hardcoded.
run_rule "hardcoded contract or account addresses" \
  '\b[CG][A-Z2-7]{55}\b' \
  "A Stellar address is hardcoded. Contract ids live in deployments/<network>.json and are read through packages/common/deployments.ts (09-DEPLOYMENT §1/§2 step 6); nothing else may carry one (06-TEST-PLAN §8)."

if [ "$fail" -ne 0 ]; then
  echo "::error::network-agnostic check (TypeScript scope) failed"
  exit 1
fi
echo "network-agnostic check (TypeScript scope): clean"
