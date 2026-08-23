# One option cycle, end to end

This is the evidence document for a single covered-call round on Antares: opened, sold, settled and
withdrawn from, with a transaction hash for every step that anyone can resolve on a public explorer
without asking us for anything.

It is written to be checked rather than believed. Every claim below is either a link to a
transaction, a number you can recompute from other numbers on this page, or a pointer to the
document that defines the rule — never a restatement of it.

> **Status: drafted, awaiting its round.** The narration, the arithmetic and the two approval
> conditions below are final. The transaction hashes are not yet filled in: they come from the
> real-parameter round, and a hash from anywhere else does not belong here. Every field marked
> `TBD` is one of those, and the document is not delivered until none remain.
>
> Read that as a constraint we accepted rather than a delay we are explaining. Antares has closed
> full cycles on testnet already, and the integration suite drives one against a live vault when it
> is run — but those are at fast-test parameters against a price source we control, and the
> deployment record labels such an instance `economicallyMeaningless: true` in its own words.
> Putting those hashes here would answer a different question from the one this document asks.

## What this proves, and what it does not

**Proves.** That the mechanism closes: a depositor's XLM becomes shares, an option over it is sold
at a price a descending auction discovered, the round settles against an oracle nobody in this
project controls, and the depositor leaves with a share price that moved by exactly the premium and
payout the chain recorded. And that no step in that chain needed us: opening and closing are
callable by anyone, and this round's were.

**Does not prove.** That the strategy is profitable, that the premium is a market price, or that
anything here survives real volatility. One round is one sample. The bidder is disclosed as
self-operated wherever its fills appear — see `bidder/README.md`, which says so in its first line
and prints it at startup.

## The instance

| | |
|---|---|
| Network | Stellar testnet |
| Vault | `TBD` |
| Oracle adapter | `TBD` — pinned at construction and **immutable**; there is no setter |
| Price source | Reflector's external CEX & DEX XLM/USD feed |
| Epoch | `TBD` |
| Auction | 45 minutes, premium decaying linearly from a start rate to a floor — both in the `epoch_opened` event below |
| Strike | 3 % out of the money, fixed at open from the oracle's TWAP |
| Protocol fee | 0 bps |
| Settlement bounty | 25 bps of premium, paid to whoever closes the round |

The parameters are the shipped set, not a demonstration set. `deployments/testnet.json` records
them alongside the toolchain and the host that built the wasm.

## The cycle

### 1. Deposit

| | |
|---|---|
| Transaction | `TBD` |
| Caller | a depositor, signing for themselves |

XLM in, shares out, at the current share price. Nothing about this step is special to the round: a
deposit while the vault is idle mints immediately, and a deposit during a live round waits for it to
end, because minting into a round whose outcome is unknown would price the new shares against a
result they did not take the risk for.

### 2. Open the round — and anyone could have

| | |
|---|---|
| Transaction | `TBD` |
| Caller | `TBD` |

`open_epoch()` takes no admin. It reads the oracle live, sets the strike 3 % above the TWAP it
found, and offers the vault's assets as notional. If the feed is stale, deviating, or unable to
serve a round of this length, the call reverts and nothing has happened — no round opens on a price
we could not read.

**The number to check:** the strike in the `epoch_opened` event is the `open_twap` in the same event
times 1.03, floored. Both are in the event; you do not need us for either.

### 3. The auction, and the fill

| | |
|---|---|
| Transaction | `TBD` |
| Bidder | `TBD` — self-operated, see above |
| Filled | `TBD` |
| Premium paid | `TBD` |

The premium starts at `premium_start_bps` of notional and falls linearly to `premium_floor_bps`
over the 45-minute window; both bounds are in the `epoch_opened` event, so the curve is public
before anyone bids. A bidder who thinks the option is cheap bids early and pays more; one who waits
pays less and risks somebody else taking the notional first. That race is the price discovery, such
as it is with one bidder.

**The number to check:** premium ÷ filled notional gives the rate in basis points, and the rate
tells you how far into the 45 minutes the fill landed, because the curve is a straight line between
those two published bounds. The bidder names its own ceiling in the transaction, so no price it did
not agree to can be charged to it.

### 4. The wait

Nothing happens on chain, and nothing needs to. The option is live until expiry.

### 5. Close the round — and again, anyone could have

| | |
|---|---|
| Transaction | `TBD` |
| Caller | `TBD` |
| Bounty paid | `TBD` |

`close_round(bounty_to)` is one entry point with no outcome argument. The caller cannot choose
whether the round settles, voids or resolves unpaid — the contract reads the oracle at the moment of
expiry and dispatches on what it finds. This is deliberate: an operator who could pick the outcome
would be an operator you have to trust, and the whole design is arranged so you do not.

Whoever makes the call earns 25 bps of the premium. That is why the caller above may not be us.

**The number to check:** the bounty is the premium times 25 ÷ 10 000, floored — floored toward the
vault, like every other rounding in the system.

### 6. Settlement, in numbers you can redo

| | |
|---|---|
| Settlement price | `TBD` |
| Strike | `TBD` |
| Payout to the bidder | `TBD` |
| Share price before → after | `TBD` |

If the price finished at or below the strike, the option expired worthless: the bidder paid for it
and got nothing, the premium stays with depositors, and the share price rises by exactly the premium
less the bounty. If it finished above, the bidder is owed
`notional × (price − strike) ÷ price`, floored — a fraction strictly under 1 for any positive
strike, which is why the payout can never exceed the notional sold no matter where the price goes.
That bound is invariant **I3** in [`INVARIANTS.md`](INVARIANTS.md), and it is the reason a
compromised oracle cannot drain the vault: it can move value between depositors and this round's
bidder, and it can do nothing else.

**The identity to check:** `assets_after = assets_before + premium − payout − fee − bounty`, and the
new share price is `assets_after × 10⁷ ÷ shares`, floored. Every term is in the `settled` event.

### 7. Withdrawal

| | |
|---|---|
| Request | `TBD` |
| Claim | `TBD` |
| XLM out | `TBD` |

The shares are burned when the exit is requested; what they are worth is decided by the round's
settlement, and claimed afterwards. A depositor asking for an immediate exit can require the vault
to be idle, so an `open_epoch` landing first can never silently convert an instant exit into a
queued one (D-46).

## The reviewer's two conditions, answered

These were raised in the approval feedback. Both were already true of the design when they were
asked; what was missing was a document that said so.

### "Admin controls cannot be abused to freeze user funds indefinitely — pause should have a timeout or an emergency withdrawal path"

Antares does something stronger than either. **The entire exit path is unpausable.** Pause blocks
exactly three things — `deposit`, `bid` and `open_epoch` — and every way out keeps working while
paused: `close_round`, `request_withdraw`, `claim_withdraw`, `claim_payout`, `claim_refund`,
`claim_fee`, `cancel_pending_deposit`, `redeem_shares` and `restore_position` — nine entries, named
here in the same words [`INVARIANTS.md`](INVARIANTS.md) uses, because an earlier answer to this
condition listed the set from memory and got two of them wrong.

A timeout is therefore unnecessary rather than omitted: pause stops new risk entering and cannot
hold anything already inside. That is invariant **I8** in [`INVARIANTS.md`](INVARIANTS.md), and the
call-sequence fuzzer proves it by replaying every generated sequence with a pause injected at a
random point and asserting the exit set still succeeds.

The worst case a depositor faces is therefore not a pause at all but a late settlement, and it is
bounded: a round reaches a terminal state at **`expiry + unresolved_after`** whatever the feed does,
and that path does not call the oracle at all (D-64). Nobody can extend it, including us.

### "The oracle integration must include fallback mechanisms for dead feeds"

There is an escalation ladder rather than a single fallback, and every rung is permissionless:

1. **Retry.** A stale or self-inconsistent read at open reverts. No round opens on a price we could
   not read, and anyone can try again a moment later.
2. **Void and refund.** A feed that had nothing usable at expiry voids the round: the bidder's
   premium is returned in full and depositors keep what they started with. Nobody profits from a
   dead feed — which is the point, because a rule that paid either side would give somebody a reason
   to want one.
3. **Resolve without the oracle.** Past `expiry + unresolved_after` the round finalizes with no
   oracle call whatsoever: the premium stays with depositors and the payout is zero. This is the rung
   that makes the bound above real. An earlier version of this answer promised the bound while the
   design still let an uncallable adapter revert `close_round` forever; D-64 closed that, and the
   correction is recorded rather than quietly fixed.

The ladder is drawn in [`ARCHITECTURE.md`](ARCHITECTURE.md) and its failure modes are enumerated in
[`TRUST_MODEL.md`](TRUST_MODEL.md) §4, which also states the bound on what a fully compromised feed
could do: one epoch's sold notional, because there is no leverage anywhere in the system.

## Verifying this yourself

1. **The contract is the source.** Build it from this commit and compare the hash against the
   deployed one. One caveat, and it is ours rather than yours: the same commit compiles to different
   bytes on macOS and on Linux — same size, same exports, same interface, different internal
   ordering. It is measured, explained and open as **O-7** in
   [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md), and `buildHost` in the deployment record tells you which
   host produced the hash you are comparing against.
2. **The events are the record.** Every state change emits one. The numbers in this document come
   from them and can be re-derived from them.
3. **The invariants are testable claims, not adjectives.** [`INVARIANTS.md`](INVARIANTS.md) lists
   I1–I10 with how each is verified; [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) records what the
   internal review walked and what it found.
4. **What we know is wrong is written down.** [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) is the list,
   including the ones with no fix yet.
