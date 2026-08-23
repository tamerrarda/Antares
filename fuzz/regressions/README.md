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

## `fuzz_call_sequence/2026-08-23-i8-pause-injection.bin`

The first long run produced a finding, and it was **not** in the contract.

    I8 violated: CloseRound { bounty_to: 200 } at index 11 succeeded unpaused
    and failed with paused = true.

I8 is the property that makes holding a pause key safe, and `close_round` is named in its set
(`docs/INVARIANTS.md` §I8: *"pause blocks exactly three things: `deposit`, `bid`, `open_epoch`"*).
So the assertion is right to be loud. But `close_round` **cannot** return `Paused`: it does not go
through `enter()`, and the only pause gates in the tree are `bid`'s and `deposit`'s
`enter(&env, true)` and `epoch.rs`'s own check. Whatever failed in run B, it was not the pause
refusing it.

**The injection was assumed state-neutral and is not.** `set_paused` enters through `enter()`, which
runs `lazy_finalize` **before** the pause check and then commits the state it produced. Inject a
pause into a vault holding a due lapse and run B finalizes that lapse; run A, which never makes the
call, still has it to close. A later `close_round` then succeeds in A and fails in B for a state
reason — and the target's `diverged` guard never fires, because it compares the outcomes of the
sequence's own ops and the divergence came from the injected call.

The fix is one line and it restores the assumption the comparison rests on: run A calls
`set_paused(false)` at the same index, so both runs take the identical `enter` → `lazy_finalize` →
commit step and the only difference left between them is the flag. Verified both ways — this input
panics without the mirror and passes with it.

That the harness had already been wrong about this twice (below) and had a guard for it is the
reason this entry spells out *which* divergence the guard cannot see.

## `fuzz_call_sequence/2026-08-21-long-run.bin`

**Executed on 2026-08-23 against the current contract, and it does not crash.** The file stays
anyway — this directory's rule is that a file leaves when a test in the ordinary suite pins the
behaviour it found, and nothing pins this one.

What can be claimed, and what cannot. The input ran for 68 ms of real work; an **empty input** run
the same way finishes in 0 ms and is also clean, which is the control that says the binary is
executing inputs rather than dying before it reaches them — the exact failure that made the earlier
attempt uninformative. And `fuzz_call_sequence`'s `Input` type has not changed since the artifact
was written (`95951a1`, the only commit to that file since, altered assertions and no type), so the
same bytes still decode to the same call sequence rather than to a different one that happens not to
crash. What that adds up to is that **the sequence which once crashed no longer does** — not *why*.
Whether a fix between 2026-08-21 and now closed it, or it was never a contract crash at all, is not
something this run can distinguish.

### macOS does work, contrary to what this file said until 2026-08-23

The earlier note recorded three failures and concluded Linux CI was the only environment. Two of the
three were real and one was a wrong turn:

- **ASan is genuinely unusable.** Apple's linker rejects the instrumented objects with
  `initializer pointer has no target`. Run with `--sanitizer=none`. Nothing is lost that matters
  here: `contracts/` contains **no `unsafe` at all**, and what ASan finds — use-after-free, buffer
  overruns — is what safe Rust already prevents. These targets earn their keep through invariant
  assertions, which are panics, and libFuzzer catches those with or without a sanitizer.
- **The pinned `nightly-2025-08-07` is too old.** Plain `+nightly` is current enough for
  `soroban-sdk-macros`.
- **`-ld_classic` was the wrong fix** for what `-s none` leaves behind. The problem is that
  `antares-vault` and `mock-price-source` build a `cdylib`, and macOS resolves every symbol in a
  dylib at link time — including the `__sanitizer_cov_*` hooks that only the final fuzz binary
  carries. Defer that resolution instead:

```sh
RUSTFLAGS="-C link-arg=-Wl,-undefined,dynamic_lookup" \
  cargo +nightly fuzz run --sanitizer=none <target> -- -max_total_time=7200
```

libFuzzer prints three `Failed to find function "__sanitizer_*"` warnings at startup under this
configuration. They are the absent sanitizer runtime announcing itself and are expected; a crash is
still reported and still written to `fuzz/artifacts/`, only without a symbolized stack.
