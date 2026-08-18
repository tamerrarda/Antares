# What changed, and why

<!-- What this does and the reason for it — not which files were edited.
     If it repairs something, say what the defect was and re-derive what the
     repair implies downstream. This project's four worst bugs (D-36, D-38,
     D-40, D-66) were all in repairs, and every one was caught by re-deriving
     consequences rather than re-reading intent. -->

Spec this follows: <!-- e.g. 02-CONTRACT-SPEC §2.4, D-37 -->

---

# Author's checklist — 07-SECURITY §5

Ten lines, filled by the author, every pull request. Answer `no` or say what you
did; an unfilled line is an unreviewed change.

| # | Question | Answer |
|---|---|---|
| 1 | **Auth touched?** Any `require_auth`, any change to who may call what — including a function joining or leaving the permissionless set. | |
| 2 | **Storage keys touched?** New `DataKey` variant, changed shape, changed storage class. Instance vs persistent is a durability decision, and nothing value-bearing may be `temporary()`. | |
| 3 | **New division?** Which direction does it round, and is that the vault's favour (02-CONTRACT-SPEC §6, D-20)? A division that rounds the other way is a solvency bug wearing a rounding curiosity's clothes. | |
| 4 | **New external call?** It may target only `Config.asset` or `Config.oracle`, both fixed at construction. Anything else is the "arbitrary contract calls" class. | |
| 5 | **New loop?** Over what, and what bounds its length? No path in this protocol iterates over anything a caller can grow. | |
| 6 | **Paused-set changed?** Did anything join or leave I8's unpausable set? Pause may stop new risk entering; it may never trap what is inside. | |
| 7 | **Event added or changed?** §10 is a **frozen ABI**, not logging — a field left out cannot be added later. Do the four finalization events still carry `wclaims`, and does every rejecting test assert an *empty* log? | |
| 8 | **TTL bump present?** Every mutating call ends with one, clamped (`03-STORAGE-TTL` §2 rules 1–2). Rule 3: touching `PendingWithdraw(u)` or `Fill(r,b)` also bumps the referenced `Round(r)`. | |
| 9 | **Snapshot diff reviewed?** `test_snapshots/` is committed; a behaviour change shows up here or in nobody's memory. | |
| 10 | **Vector diff green?** Rust ↔ Python, and — if this PR touches a module whose reference is not yet authored — say so, because the merge waits on the reference and not the other way round (D-22, `DEV-PROTOCOL` §4). | |

---

# Gate — `DEV-PROTOCOL` §6

A section is not done until all five are true:

- [ ] Builds clean: `cargo build --target wasm32v1-none --release`, `clippy -D warnings`
- [ ] **Every guard has a test that drives it to REJECT.** A guard with only a happy-path test is untested.
- [ ] Its invariants are asserted by the named property or fuzz layer — not by inspection
- [ ] Full workspace test run green, not just this module
- [ ] Reviewed by one of the other two developers (never the author — `DEV-PROTOCOL` §7)

**Reviewer:** your job is not style. It is one question — *does this do what the
spec says, including in the cases the spec cares about and the author did not
test?* A finding gets written down even when it is fixed the same day.

---

# Keys — 07-SECURITY §6

- [ ] This PR adds **no CI secret with signing authority over the admin.** The
      workflow check enforces it; this line is here so the answer is also a
      person's, not only a grep's.
