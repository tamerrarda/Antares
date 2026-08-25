---
title: If something breaks
deck: Four things that can go wrong, and what you can do about each of them without waiting for anyone here.
---

# If something breaks

Every incident below has an operator response, and none of them has an operator *requirement*. **The
way out of the vault does not pass through us.** That is invariant
[I8](invariants.md#i8-the-exit-path-cannot-be-paused), and it is why each incident is answered
twice — once for whoever is on call, and once for everybody who is not and should not have to be.

## The nine calls that always work

Whatever else is broken, and whether or not the vault is paused, these succeed in every state where
they would succeed normally:

`close_round` · `request_withdraw` · `claim_withdraw` · `claim_payout` · `claim_refund` ·
`claim_fee` · `cancel_pending_deposit` · `redeem_shares` · `restore_position`

Pause blocks exactly three things — `deposit`, `bid`, `open_epoch` — and all three are ways *in*,
never ways out.

**Two of the nine are permissionless as well as unpausable.** Anyone can close a round or open one,
including a depositor who is tired of waiting.

---

## 1. The feed stops answering

**What it looks like.** `open_epoch` reverts with `OracleStale` or `OracleUnreachable`. No new round
opens. If a round is already live, `close_round` reverts with `OracleNotDeadYet` until the grace
period passes.

**What you can do.** Everything, including depositing — there is simply no round for new collateral
to be sold against until the feed answers. Exits work; a queued one pays at its round's settled
price, and a pending deposit can be cancelled outright for the exact amount.

**What actually restores service: nothing an operator does.** The feed recovers or it does not, and
the contract's ladder reaches a defined end either way. A round whose expiry anchor is unusable
**voids** — every bidder refunded in full, depositors keep their collateral. A round nobody can close
at all reaches **unresolved** at `expiry + 21 hours`, on a path that **does not call the feed**.
Twenty-one hours past expiry is the longest a round can stay open at the shipped values, and nobody
can extend it, including us.

**What the operator must not do.** Not pause: pause blocks `open_epoch`, which is the thing already
blocked, and blocks `deposit`, which is working. Not upgrade: this is not a code fault.

## 2. The feed answers, and disagrees with itself

**What it looks like.** `open_epoch` reverts with `OracleDeviation`, repeatedly, while a spot check
still returns a price. The short and long windows have diverged past the breaker's bound, which is
what a feed malfunction looks like from inside the contract.

**What you can do.** Everything. The vault sits idle with deposits open. This is the least harmful of
the four.

**What actually restores service: waiting.** The breaker fires **only at open**, deliberately. A
round already sold settles against the anchored read at expiry, where the medians already carry the
artifact resistance and a rejection could only turn a settleable round into a void. So a wedged
deviation stops new rounds and **cannot harm a live one**.

**What the operator must not do.** Not widen `max_deviation_bps` to force a round open. It takes
effect next round, every change emits an event, and the parameter exists to refuse exactly the price
you would be forcing through. If the bound is genuinely wrong, that is a reviewed change with a
reason, not an incident response.

## 3. The keeper is down

**What it looks like.** Rounds do not open when the idle gap elapses; rounds do not close when they
expire. Nothing reverts — nobody is calling.

**What you can do: close the round yourself, and be paid for it.** `open_epoch()` and
`close_round(bounty_to)` take no admin and never have. Whoever closes a round earns the settlement
bounty — 25 bps of the premium on the deployed vault — which is there precisely so that a stalled
vault is somebody's opportunity rather than everybody's problem. Neither call needs an interface:
both are ordinary contract invocations you can construct yourself. The web interface in this
repository puts a live simulation beside each of them, so you can see what a call would do before
signing it.

**The keeper holds no authority.** It has one key, that key can call two entry points anyone can
call, and losing it costs the bounties and nothing else.

## 4. The admin key is lost

**What it looks like.** No admin action can be taken again: no pause, no parameter change, no fee
change, no upgrade, no admin transfer. `transfer_admin` is two-step, so a *typo'd* address cannot
brick the role — but a lost key is lost.

**What you can do.** Everything you could do before. This is the incident where the design's refusal
to route exits through the admin pays for itself.

| Still works | Gone for good |
|---|---|
| Every one of the nine calls above | `set_paused`, `set_deposit_cap`, `set_fee_bps`, `set_fee_recipient` |
| `open_epoch` and `bid` — rounds keep running | `set_epoch_params`, `set_allowlist_enabled`, `set_allowed`, `set_rent_params` |
| `deposit` — the vault keeps taking money | `upgrade` and `migrate` — **no bug can ever be fixed** |

**The last row is the real cost**, and it is the one to say out loud: an unfixable contract is a
worse long-run position than a fixable one, which is the whole argument behind shipping upgradeable.
A lost key converts Antares into an immutable contract with whatever bugs it has at that moment.

**What the operator must do: announce it.** A vault whose admin key is gone is a different risk
profile from the one people deposited into.

---

## What is watched, and at what threshold

Published so that you can hold this project to it. The keeper doubles as the watcher; none of these
needs a third-party service.

| Alert | Threshold | Why this number |
|---|---|---|
| `close_round` failing | the same failure **3 times in a row** | Once is a race with another caller, which is the design working. Three is a fault |
| A round still active past expiry | **1 hour** | The expiry anchor stays readable for about 20 h 15 m, so an hour is early enough to act and late enough not to fire on a slow keeper |
| Feed sponsorship runway | under `epoch_duration + unresolved_after` **plus one round** — about 15 days at the mainnet-target settings | A fixed alarm fires *after* the feed's own condition has already started refusing to open rounds. The alarm has to lead the refusal, not follow it |
| An admin transaction nobody initiated | **once** | There is no benign version of this |

## Rehearsals

The pause drill and the upgrade drill were both executed live against testnet on **2026-08-21**, with
real transactions rather than simulations. The pause drill confirmed that none of the nine refused
with `Paused` and that two of them succeeded while paused. The upgrade drill spanned a round, so that
new code closed a round old code had opened.

**Neither drill has a script in the repository.** They were driven by hand rather than by a
committed script, so the results are recorded and the procedure is not reproducible from a clean
checkout. That is a gap in the evidence rather than in the design, and it is written here rather
than left for a reader to notice.
