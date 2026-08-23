# Incident runbook

What to do when something is wrong, and — more importantly — what a depositor or a bidder can do
without waiting for us to do anything.

Every incident below has an operator response, and none of them has an operator *requirement*: the
way out of the vault does not pass through us. That is invariant **I8** in
[`INVARIANTS.md`](INVARIANTS.md), and it is why each incident here is answered twice — once for
whoever is on call, and once for everybody who is not and should not have to be.

## The nine calls that always work

Whatever else is broken, and whether or not the vault is paused, these nine succeed in every state
where they would succeed normally:

`close_round` · `request_withdraw` · `claim_withdraw` · `claim_payout` · `claim_refund` ·
`claim_fee` · `cancel_pending_deposit` · `redeem_shares` · `restore_position`

Pause blocks exactly three things — `deposit`, `bid` and `open_epoch` — and all three are ways *in*,
never ways out. Two of the nine are permissionless as well as unpausable: **anyone** can close a
round or open one, including a depositor who is tired of waiting for us.

## Incidents

### 1. Stale oracle — the feed stops answering

**Looks like.** `open_epoch` reverts with `OracleStale` or `OracleUnreachable`. No new round opens.
If a round is already live, `close_round` reverts with `OracleNotDeadYet` until the grace passes.

**What actually restores service.** Nothing an operator does. The feed recovers or it does not, and
the contract's ladder ([`ARCHITECTURE.md`](ARCHITECTURE.md)) is written to reach a defined end
either way: a round whose expiry anchor is unusable **voids** — the bidder's premium is refunded in
full and depositors keep their collateral — and a round nobody could close at all reaches
`Unresolved` at `expiry + unresolved_after`, on a path that **does not call the oracle**. Twenty-one
hours past expiry, at shipped values, is the longest a round can stay open. Nobody can extend it,
including us.

**What users can do meanwhile.** Everything, including depositing — there is simply no round for
new collateral to be sold against until the feed answers. Exits work; a queued one pays at its
round's settled price, and a pending deposit can be cancelled outright for the exact amount.

**Do not.** Do not pause. Pause blocks `open_epoch`, which is the thing already blocked, and blocks
`deposit`, which is working — it makes the incident worse in exchange for nothing. Do not upgrade to
"fix" a live feed problem; an upgrade is a code change and this is not a code fault.

### 2. Wedged deviation — the feed answers, and disagrees with itself

**Looks like.** `open_epoch` reverts with `OracleDeviation`, repeatedly, while `spot_check` still
returns a price. The short and long windows have diverged past the breaker's bound, which is what a
feed malfunction looks like from inside the contract (D-25).

**What actually restores service.** Waiting. The breaker fires **only at open**, deliberately: a
round already sold settles against the anchored read at expiry, where the medians already carry the
artifact resistance and a rejection could only turn a settleable round into a void. So a wedged
deviation stops new rounds and cannot harm a live one.

**What users can do meanwhile.** Everything. The vault sits idle with deposits open; this is the
least harmful of the four.

**Do not.** Do not widen `max_deviation_bps` to get a round open. It takes effect next epoch
(`set_epoch_params`), every change emits an event, and the parameter exists to refuse exactly the
price you would be forcing through. If the bound is genuinely wrong, that is a reviewed change with
a reason, not an incident response.

### 3. Keeper down — nobody is running the loop

**Looks like.** Rounds do not open when the idle gap elapses; rounds do not close when they expire.
Nothing reverts — nobody is calling.

**What actually restores service.** Restarting the keeper, or **anyone at all** calling
`open_epoch()` and `close_round(bounty_to)`. These take no admin and never have. Whoever closes a
round earns the settlement bounty — 25 bps of the premium — which is there precisely so that a
stalled vault is somebody's opportunity rather than everybody's problem.

**What users can do meanwhile.** Close the round themselves and be paid for it. The web app offers
both calls with a live simulation beside them, so a user can see what the call would do before
signing it. Both user-facing documents already say so, in the sections people read before they
deposit: [`DEPOSITOR.md`](DEPOSITOR.md) §3 — *"somebody still has to close it, and that somebody can
be you"* — and [`BIDDER.md`](BIDDER.md) §4 — *"if the keeper disappears you can close the round
yourself, get paid for doing it, and claim."*

**The keeper holds no authority.** It has one key, that key can call the two permissionless entry
points and receive a bounty, and losing it costs the bounties and nothing else.

### 4. Key loss — the admin key is gone

**Looks like.** No admin action can be taken again: no pause, no parameter change, no fee change, no
upgrade, no admin transfer. `transfer_admin` is two-step, so a *typo'd* address cannot brick the
role — but a lost key is lost.

**What actually restores service.** Nothing restores the admin role. What matters is that the vault
does not need it:

| Still works | Gone for good |
|---|---|
| Every one of the nine calls above | `set_paused`, `set_deposit_cap`, `set_fee_bps`, `set_fee_recipient` |
| `open_epoch` and `bid` — rounds keep running | `set_epoch_params`, `set_allowlist_enabled`, `set_allowed`, `set_rent_params` |
| `deposit` — the vault keeps taking money | `upgrade` and `migrate` — **no bug can ever be fixed** |

The last row is the real cost, and it is the one to say out loud: an unfixable contract is a worse
long-run position than a fixable one, which is the whole argument behind shipping upgradeable
([`TRUST_MODEL.md`](TRUST_MODEL.md)). A lost key converts Antares into an immutable contract with
whatever bugs it has at that moment.

**What users can do meanwhile.** Everything they could do before. This is the incident where the
design's refusal to route exits through the admin pays for itself.

**Do.** Announce it. A vault whose admin key is gone is a different risk profile from the one people
deposited into, and the disclosure belongs in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) and on the app.

## What to watch, and at what threshold

From 07-SECURITY §6. The keeper doubles as the watcher; none of these needs a third-party service.

| Alert | Threshold | Why this number |
|---|---|---|
| `close_round` failing | the same failure 3 times in a row | Once is a race with another caller, which is the design working. Three is a fault. |
| A round still `Active` past expiry | **1 hour** | The expiry anchor stays readable for about 20 h 15 m, so an hour is early enough to act and late enough not to fire on a slow keeper. |
| Feed sponsorship runway | under `epoch_duration + unresolved_after` **plus one epoch** — about 15 days at the mainnet-target settings | A fixed 7-day alarm fires *after* `supports_round`'s condition 7 has already started refusing to open rounds. The alarm has to lead the refusal, not follow it. |
| An admin transaction nobody initiated | **once** | There is no benign version of this. |

## Rehearsal

The pause drill and the upgrade drill were both executed live against testnet on 2026-08-21, with
real transactions rather than simulations: the pause drill confirmed that none of I8's nine refused
with `Paused` and that two of them **succeeded while paused**, and the upgrade drill spanned a round
so that new code closed a round old code had opened.

**Neither drill has a script in this repository.** They were run from the plan's own history, so the
results are recorded and the procedure is not reproducible from a clean checkout. That is a gap in
the evidence rather than in the design, and it is written here rather than left for a reader to
notice.
