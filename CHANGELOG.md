# Changelog

Breaking changes to the contract's public interface, in the order they landed. Anything here
changes what a client compiled against an earlier build will do, so read it before regenerating
bindings.

The contract's interface is frozen as of 2026-08-20. Entries below that date describe the last
changes made before the freeze.

---

## 2026-08-20 — interface frozen

The contract surface is closed at 42 entry points. Two breaking changes landed shortly before the
freeze and are described below. **Regenerate bindings, and re-check any exhaustive `match` on the
error enum or on the config view.**

### Error 33 (`SoldOut`) is retired

`SoldOut` no longer exists. It joins error codes 5, 23, 28, 55 and 56 as retired, and **retired
codes are never reused** — a future release will not assign 33 to something else.

**What changes for a caller:** `bid` now returns `WrongPhase` in the situation that previously
returned `SoldOut`.

**Nothing became more permissive.** The refusal is still there; it was folded into the phase
rejection that already ran ahead of it. What was removed is a code an integrator had to handle and
could never actually be handed: the auction's phase moves to active the instant the offer is fully
subscribed, and the phase check runs before the fill is computed, so a zero fill was unreachable
through any transaction.

**Action:** an exhaustive `match` on the error enum will no longer compile against the retired
variant. Remove the arm; do not remap it to a new code.

### The config view gained `fee_claimable`

`config()` now returns an additional field, `fee_claimable` — the protocol fee accrued and not yet
withdrawn.

**This changes the shape of the returned struct rather than extending it.** These structs encode as
XDR maps, so a decoder built against the previous shape does not silently ignore the new field: it
decodes a different struct. A client that constructs the view by name will fail to compile; one
that decodes dynamically will see a difference at runtime.

**Why it could not wait for a later release.** The interface froze on this date. After the freeze,
a non-zero accrued fee would have been readable only from the `fee_accrued` event — and events
leave the RPC retention window in about seven days. A protocol whose accrued fee is unobservable a
week later is not publicly verifiable, which is the property this project is built to provide.

**Action:** regenerate bindings and add the field wherever the view is destructured.

---

## Before 2026-08-20

The interface was under active development and is not tracked here. Builds from before the freeze
should be regenerated against the current interface rather than diffed against it.
