#!/usr/bin/env bash
# Replay the shared vectors against both implementations (D-22).
#
# Lives here rather than inside ci.yml for the same reason static_rules.py does:
# a rule nobody can run locally is a rule that only fails after a push. The
# section-close checklist calls this, and so does CI, so the two cannot drift.
#
# Exit 0 with a notice is a real answer here, not a skip. D-22 authors each
# reference *before* the Rust it mirrors merges, so "Python present, Rust absent"
# is the required order and not a gap — and the asymmetry is directional on
# purpose: the reverse is an error, because a reference written after the Rust is
# one nobody can trust.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  note() { echo "::notice::$*"; }; err() { echo "::error::$*"; }
else
  note() { echo "note: $*"; }; err() { echo "error: $*" >&2; }
fi

py=reference/run_vectors.py
rs=contracts/antares-vault/src/test_vectors.rs

if [ ! -f "$py" ] && [ ! -f "$rs" ]; then
  note "Neither side of the differential layer exists yet."
  note "settle_ref.py is authored in Phase 2; curve_ref.py and claims_ref.py in"
  note "Phase 3; the Rust replay and this diff are a Phase-4 gate."
  note "run_vectors.py is the aggregator that feeds this diff — it does not exist"
  note "yet, and that is on schedule rather than missing."
  exit 0
fi

if [ ! -f "$py" ]; then
  err "The Rust replay exists and the Python reference does not."
  err "D-22's deadline runs the other way: a reference is authored BEFORE the"
  err "Rust it mirrors merges, and where the two collide the merge waits."
  err "A reference written after the Rust exists is one nobody can trust."
  exit 1
fi

if [ ! -f "$rs" ]; then
  note "Python reference present, Rust replay not written yet — which is the"
  note "order D-22 requires, not a gap. The diff becomes mandatory at the"
  note "Phase-4 gate; until then this proves the reference at least parses."
  python3 -c "import ast,sys; ast.parse(open('$py').read())"
  echo "reference parses; nothing to diff against yet"
  exit 0
fi

mkdir -p target/vector-diff
python3 "$py" --out target/vector-diff/python.json
ANTARES_VECTOR_OUT="$PWD/target/vector-diff/rust.json" \
  cargo test -p antares-vault test_vectors -- --nocapture

for side in python rust; do
  if [ ! -s "target/vector-diff/$side.json" ]; then
    err "the $side side produced no output; a missing document is not a match"
    exit 1
  fi
done

diff -u target/vector-diff/python.json target/vector-diff/rust.json
echo "vector diff: byte-identical"
