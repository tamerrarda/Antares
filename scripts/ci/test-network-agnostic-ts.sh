#!/usr/bin/env bash
#
# The rejecting half of `network-agnostic-ts.sh`.
#
# **A gate only ever verified in the passing direction is a gate nobody has tested** — DEV2's line
# after the outbound grep shipped green on a tree that had never contained the code it rejects. Every
# case below runs the *same script CI runs*, against a scratch git repository, and asserts the exit
# code in both directions.
#
# A scratch repository rather than a fixture directory, because the check reads `git ls-files`: an
# untracked file is deliberately invisible to it, so a fixture tree that was never `git add`ed would
# make every rejecting case pass for the wrong reason. That is the same shape as the defect this file
# exists to catch, one level up.
#
# Usage: test-network-agnostic-ts.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/network-agnostic-ts.sh"
[ -x "$CHECK" ] || { echo "not executable: $CHECK"; exit 2; }

pass=0
failed=0

# Real strkeys are 56 chars: a type letter plus 55 base32 characters. Built by repetition so that this
# file does not itself contain a hardcoded-looking address — and note it is under scripts/, which is
# in scope, so a literal here would make the check reject its own test.
CONTRACT_ID="C$(printf 'A%.0s' {1..55})"
ACCOUNT_ID="G$(printf 'B%.0s' {1..55})"
PASSPHRASE='Test SDF Network ; September 2015'

new_repo() {
  local dir
  dir="$(mktemp -d)"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name t
  mkdir -p "$dir/keeper" "$dir/packages/common" "$dir/deployments" "$dir/scripts"
  printf '%s\n' "export const ok = 1;" > "$dir/keeper/index.ts"
  printf '%s\n' "$dir" # return the path
}

commit_all() { git -C "$1" add -A && git -C "$1" commit -qm t; }

expect() {
  local want="$1" name="$2" dir="$3" got=0
  "$CHECK" "$dir" >"$dir/.out" 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then
    printf 'ok    %s (exit %d)\n' "$name" "$got"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s — wanted exit %d, got %d\n' "$name" "$want" "$got"
    sed 's/^/        /' "$dir/.out"
    failed=$((failed + 1))
  fi
  rm -rf "$dir"
}

# ---------------------------------------------------------------------------- passing direction ---

d=$(new_repo); commit_all "$d"
expect 0 "a clean tree passes" "$d"

# The exemption is the point of the rule: the same literal, in the one file allowed to hold it.
d=$(new_repo)
printf 'export const p = "%s";\nexport const id = "%s";\n' "$PASSPHRASE" "$CONTRACT_ID" \
  > "$d/packages/common/networks.ts"
commit_all "$d"
expect 0 "the passphrase AND an address inside packages/common/networks.ts pass — the exemption" "$d"

# The second exempt path.
d=$(new_repo)
printf '{"network":"testnet","vaultId":"%s","admin":"%s"}\n' "$CONTRACT_ID" "$ACCOUNT_ID" \
  > "$d/deployments/testnet.json"
commit_all "$d"
expect 0 "contract and account ids inside deployments/*.json pass — the second exemption" "$d"

# Prose is out of scope on purpose.
d=$(new_repo)
printf 'The vault is at %s on testnet.\n' "$CONTRACT_ID" > "$d/keeper/README.md"
commit_all "$d"
expect 0 "an address in a README is not a build behaviour, and is not scanned" "$d"

# Untracked files are invisible, and a local build legitimately produces one containing the passphrase.
d=$(new_repo); commit_all "$d"
mkdir -p "$d/packages/common/dist"
printf 'export const p = "%s";\n' "$PASSPHRASE" > "$d/packages/common/dist/networks.js"
expect 0 "an uncommitted packages/common/dist build artifact is not scanned" "$d"

# ------------------------------------------------------- comments are not build behaviour (DEV1) ---

d=$(new_repo)
printf '// The passphrase is "%s" and it lives in networks.ts.\nexport const ok = 1;\n' "$PASSPHRASE" \
  > "$d/keeper/note.ts"
commit_all "$d"
expect 0 "a passphrase inside a // comment line passes — a comment changes no behaviour" "$d"

d=$(new_repo)
printf '/**\n * Explaining that "%s" belongs in one place.\n */\nexport const ok = 1;\n' "$PASSPHRASE" \
  > "$d/keeper/doc.ts"
commit_all "$d"
expect 0 "a passphrase inside a block-comment continuation line passes" "$d"

d=$(new_repo)
printf '// The vault is %s.\nexport const ok = 1;\n' "$CONTRACT_ID" > "$d/keeper/note.ts"
commit_all "$d"
expect 0 "an address inside a comment line passes, for the same reason" "$d"

d=$(new_repo)
printf 'export const p = "%s"; // and this trailing comment does not save it\n' "$PASSPHRASE" \
  > "$d/keeper/net.ts"
commit_all "$d"
expect 1 "REJECT a passphrase in code that merely has a trailing comment — only WHOLE comment lines are dropped" "$d"

# The false-negative hole that inline `//`-stripping would have opened, driven deliberately: the line
# carries a URL (so it contains `//` inside a string) *before* the passphrase. Cutting from the first
# `//` would have removed the passphrase and passed.
d=$(new_repo)
printf 'export const u = "https://soroban-testnet.stellar.org"; export const p = "%s";\n' "$PASSPHRASE" \
  > "$d/keeper/both.ts"
commit_all "$d"
expect 1 "REJECT a passphrase on a line whose earlier string contains '//' — the inline-stripping hole, closed" "$d"

# Out-of-scope directory: the Rust scope is DEV1's job, and this one must not reach into it.
d=$(new_repo)
mkdir -p "$d/contracts/antares-vault/src"
printf 'let p = "%s";\n' "$PASSPHRASE" > "$d/contracts/antares-vault/src/lib.rs"
commit_all "$d"
expect 0 "the Rust tree is out of this check's scope (DEV1's static-rules job owns it)" "$d"

# ------------------------------------------------------------------------- rejecting direction ---

d=$(new_repo)
printf 'export const p = "%s";\n' "$PASSPHRASE" > "$d/keeper/net.ts"
commit_all "$d"
expect 1 "REJECT a passphrase in keeper/" "$d"

d=$(new_repo)
printf 'export const p = "Public Global Stellar Network ; September 2015";\n' > "$d/keeper/net.ts"
commit_all "$d"
expect 1 "REJECT the mainnet passphrase too" "$d"

d=$(new_repo)
printf 'export const p = "Some Invented Network ; September 2015";\n' > "$d/keeper/net.ts"
commit_all "$d"
expect 1 "REJECT an invented passphrase variant — matched on the shared suffix, not the two literals" "$d"

d=$(new_repo)
printf 'export const v = "%s";\n' "$CONTRACT_ID" > "$d/keeper/ids.ts"
commit_all "$d"
expect 1 "REJECT a hardcoded contract id in keeper/" "$d"

d=$(new_repo)
printf 'export const a = "%s";\n' "$ACCOUNT_ID" > "$d/keeper/ids.ts"
commit_all "$d"
expect 1 "REJECT a hardcoded account id — the admin banner reads it from the record, never compiled in" "$d"

# The exemption is one *path*, not the directory around it.
d=$(new_repo)
printf 'export const p = "%s";\n' "$PASSPHRASE" > "$d/packages/common/other.ts"
commit_all "$d"
expect 1 "REJECT the same literal one file over, inside packages/common/ — the exemption is a path" "$d"

# ...and not the filename anywhere it appears.
d=$(new_repo)
mkdir -p "$d/web/lib"
printf 'export const p = "%s";\n' "$PASSPHRASE" > "$d/web/lib/networks.ts"
commit_all "$d"
expect 1 "REJECT web/lib/networks.ts — the exemption is packages/common/networks.ts, not any networks.ts" "$d"

# A JSON config inside the scope is code for this purpose: it configures the build.
d=$(new_repo)
printf '{"vault":"%s"}\n' "$CONTRACT_ID" > "$d/keeper/config.json"
commit_all "$d"
expect 1 "REJECT an address in a JSON config inside the scope" "$d"

# The single-file case: DEV1 found `grep -n` drops the filename when handed exactly one file, so the
# parser read the match as the path. This drives the tree into that state deliberately.
d="$(mktemp -d)"
git -C "$d" init -q; git -C "$d" config user.email t@example.com; git -C "$d" config user.name t
mkdir -p "$d/keeper"
printf 'export const v = "%s";\n' "$CONTRACT_ID" > "$d/keeper/only.ts"
commit_all "$d"
expect 1 "REJECT with exactly ONE file in scope — the -H case DEV1 found latent" "$d"

# Every scope directory, one at a time: a scope silently dropped from the list is the failure that
# would make this whole check green on a tree it does not read.
for scope in keeper bidder web integration packages scripts; do
  d="$(mktemp -d)"
  git -C "$d" init -q; git -C "$d" config user.email t@example.com; git -C "$d" config user.name t
  mkdir -p "$d/$scope"
  printf 'export const v = "%s";\n' "$CONTRACT_ID" > "$d/$scope/x.ts"
  commit_all "$d"
  expect 1 "REJECT inside $scope/ — every scope in 06-TEST-PLAN §8's list is actually read" "$d"
done

# --------------------------------------------------------------------------------------- result ---

echo
echo "passed ${pass}, failed ${failed}"
[ "$failed" -eq 0 ] || exit 1
