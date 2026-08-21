# Crashing inputs, kept because the corpus cannot keep them

`fuzz/corpus/` is gitignored — it is machine-local and grows without bound — so a crashing
input found on one machine exists nowhere the next run can reach. That is not hypothetical:
`2026-08-21-long-run.bin` was produced by a long `fuzz_call_sequence` run, sat unreported in a
worktree, and was found only while deleting that worktree. This directory is the fix, and the
CI job feeds every file here to its target before the timed smoke begins.

One file per crash, named `<date>-<what-produced-it>.bin`, under a directory named for its
target. A file leaves only when the behaviour it found is pinned by a test in the ordinary
suite — 06-TEST-PLAN §4: *"every crash becomes a permanent regression unit test"* — and the
commit that removes it says which test replaced it.

## `fuzz_call_sequence/2026-08-21-long-run.bin`

Unreproduced, and the reason is worth recording because it is not the contract. On macOS the
fuzz build fails three ways: ASan hits the `ctor` initializer incompatibility with Xcode's
linker, the pinned nightly is too old for `soroban-sdk-macros`' use of `floor_char_boundary`,
and `-s none` leaves cargo-fuzz's sancov flags with no runtime to satisfy them. Forcing
`-ld_classic` links, and the resulting binary then SEGVs in libFuzzer's own `Printf` before
running anything — **an empty input crashes identically**, which is how we know the artifact
was never actually executed here. Linux CI is the environment that works.
