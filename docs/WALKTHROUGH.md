# One option cycle, end to end

This is the evidence document for a single covered-call round on Antares: opened, sold, settled and
withdrawn from, with a transaction hash for every step that anyone can resolve on a public explorer
without asking us for anything.

It is written to be checked rather than believed. Every claim below is either a link to a
transaction, a number you can recompute from other numbers on this page, or a pointer to the
document that defines the rule — never a restatement of it.

> **Status: complete.** Round 1 opened 2026-08-24, expired 2026-08-27, and settled the same day.
> Every hash below comes from that round on the deployed instance — the one
> `deployments/testnet.json` records with `economicallyMeaningless: false`. Antares has closed full
> cycles at fast-test parameters against a price source we control, and the integration suite drives
> one against a live vault when it is run; none of those hashes are here, because they answer a
> different question from the one this document asks.
>
> **One path this round did not exercise.** The exit in §7 was taken while the vault was idle, which
> pays out in the same transaction that burns the shares. The *queued* exit — shares burned during a
> live round, priced by that round's settlement, claimed afterwards — is covered by the test suite
> and defined in [`ARCHITECTURE.md`](ARCHITECTURE.md) §4, but no hash on this page demonstrates it.
> Said here rather than left for a reader to notice.

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
| Vault | `aXLM-E` — [`CCYAHS4DJLGNDU7GTSDUJL4ZZ2X6VZI7IPHJM2W2SNVA6RDALEALBVEA`](https://stellar.expert/explorer/testnet/contract/CCYAHS4DJLGNDU7GTSDUJL4ZZ2X6VZI7IPHJM2W2SNVA6RDALEALBVEA) — one of three now running, and the only one this document follows |
| Oracle adapter | [`CBR3GSAZUOFGWP5IUSIJP5ESUZPDIO42WAZ5VIFSNYZURH2VVSBCEN5Z`](https://stellar.expert/explorer/testnet/contract/CBR3GSAZUOFGWP5IUSIJP5ESUZPDIO42WAZ5VIFSNYZURH2VVSBCEN5Z) — pinned at construction and **immutable**; there is no setter |
| Price source | Reflector's external CEX & DEX XLM/USD feed |
| Epoch | 3 days (259 200 s), 2026-08-24T14:48:28Z → 2026-08-27T14:48:28Z |
| Auction | 45 minutes, premium decaying linearly from a start rate to a floor — both in the `epoch_opened` event below |
| Strike | 3 % out of the money, fixed at open from the oracle's TWAP |
| Protocol fee | 0 bps |
| Settlement bounty | 25 bps of premium, paid to whoever closes the round |

The parameters are the shipped set, not a demonstration set. `deployments/testnet.json` records
them alongside the toolchain and the host that built the wasm.

**One vault, deliberately.** Two more — `aXLM-C` at 2 % out of the money and `aXLM-A` over seven
days — went live on 2026-08-28 running the same wasm against the same adapter, so that a
counterparty has terms to compare rather than one point to accept or refuse. This document follows
`aXLM-E` from end to end because a cycle is only evidence if it is one cycle: three interleaved
would be a longer page and a weaker proof. The others' rounds appear in the app's round history and
in the same deployment record.

## The cycle

### 1. Deposit

| | |
|---|---|
| Transaction | [`2ffbad70…6b37`](https://stellar.expert/explorer/testnet/tx/2ffbad70d905e236aef1031a0d3ea08a3b17dc1f036f00554f1b21ae39076b37) · 2026-08-24T14:47:18Z |
| Caller | [`GAM7T6J7…MYVL`](https://stellar.expert/explorer/testnet/account/GAM7T6J7LNKWH3R2OTVMCNJDFGT5ZEPZMEE5ZNALELLVVAPIJEMLMYVL) — a depositor, signing for themselves |
| In | 200 XLM → 2 000 000 000 shares, at a share price of 1.0000000 |

XLM in, shares out, at the current share price. Nothing about this step is special to the round: a
deposit while the vault is idle mints immediately, and a deposit during a live round waits for it to
end, because minting into a round whose outcome is unknown would price the new shares against a
result they did not take the risk for.

### 2. Open the round — and anyone could have

| | |
|---|---|
| Transaction | [`947c178d…d8ac`](https://stellar.expert/explorer/testnet/tx/947c178d3257c62a6301753825ca66bb2989a89908ddb6b9c734a8162c20d8ac) · 2026-08-24T14:48:28Z |
| Caller | [`GAM7T6J7…MYVL`](https://stellar.expert/explorer/testnet/account/GAM7T6J7LNKWH3R2OTVMCNJDFGT5ZEPZMEE5ZNALELLVVAPIJEMLMYVL) — **the depositor**, not the admin and not a keeper |

`open_epoch()` takes no admin. It reads the oracle live, sets the strike 3 % above the TWAP it
found, and offers the vault's assets as notional. If the feed is stale, deviating, or unable to
serve a round of this length, the call reverts and nothing has happened — no round opens on a price
we could not read.

**The number to check:** the strike in the `epoch_opened` event is the `open_twap` in the same event
times 1.03, floored. Both are in the event; you do not need us for either.

### 3. The auction, and the fill

| | |
|---|---|
| Transaction | [`4a71f3de…5aee`](https://stellar.expert/explorer/testnet/tx/4a71f3deedc4d7b92d38e5a284755d86add97eb4616e8114414d7557d9e35aee) · 2026-08-24T14:55:24Z |
| Bidder | [`GCTFTPSK…HDGH`](https://stellar.expert/explorer/testnet/account/GCTFTPSKIEAVSLVLYPPWKDPPXPD6TWZB7AP3GTFWSK4TXHUWUUU7HDGH) — self-operated, see above |
| Filled | 200.0001 XLM notional — the whole offer |
| Premium paid | 4.9200024 XLM, i.e. 246 bps |

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
| Transaction | [`2add1f5c…941c`](https://stellar.expert/explorer/testnet/tx/2add1f5c51628c42fe85f88a6c87c5f039a2a5ceab064bbc6fc9a873db8c941c) · 2026-08-27T15:22:10Z, 33 min after expiry |
| Caller | [`GDFPSLES…KBQQ`](https://stellar.expert/explorer/testnet/account/GDFPSLESDEPR2XSNASBK3464NLB7HYG6IS2SX2TYCJK7KUPIEWFEKBQQ) |
| Bounty paid | 0.0123 XLM |

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
| Settlement price | `1882978` — 0.1882978 USD/XLM, the 15-minute TWAP anchored at expiry |
| Strike | `2046447` — 0.2046447 USD/XLM |
| Payout to the bidder | **0** — the price finished 8.0 % below the strike |
| Share price before → after | `10000000` → `10245384`, i.e. 1.0000000 → 1.0245384 (+2.4538 %) |

If the price finished at or below the strike, the option expired worthless: the bidder paid for it
and got nothing, the premium stays with depositors, and the share price rises by exactly the premium
less the bounty. If it finished above, the bidder is owed
`notional × (price − strike) ÷ price`, floored — a fraction strictly under 1 for any positive
strike, which is why the payout can never exceed the notional sold no matter where the price goes.
That bound is invariant **I3** in [`INVARIANTS.md`](INVARIANTS.md), and it is the reason a
compromised oracle cannot drain the vault: it can move value between depositors and this round's
bidder, and it can do nothing else.

**The identity to check:** `assets_after = assets_before + premium − payout − fee − bounty`, and the
new share price is `assets_after × 10⁷ ÷ shares`, floored. **It takes two events, not one.**
`settled` carries `premium`, `payout_total`, `fee` and the resulting `pps`; the bounty is its own
event, `settle_bounty{round, to, amount}`, published by the same transaction — and *not published
at all* when the bounty floors to zero, which is the case a reconciliation should expect rather
than treat as a missing record. Checking the identity against `settled` alone leaves you short the
bounty term, so it is named here.

### 7. Withdrawal

| | |
|---|---|
| Request | [`3d5d8801…1826`](https://stellar.expert/explorer/testnet/tx/3d5d880129bad99a842115c855b6005cce7d3ceb4f1d125fc0d26f4029a21826) · 2026-08-27T15:29:10Z |
| Claim | the same transaction — the vault was idle, so the exit paid out at once |
| XLM out | 51.22692 XLM for 500 000 000 shares, a quarter of the position |

This exit took the instant path: the call passed `require_idle = true`, the vault was idle, and a
single transaction burned the shares and paid the XLM. Four events record it — `burn`, the SAC
`transfer`, `withdraw_requested` and `withdraw_claimed` — so the request and the claim stay
separable in the log even though they share a transaction.

The queued path is the same call in a different phase. Ask to exit during a live round and the
shares burn immediately while what they are worth is decided by that round's settlement and claimed
afterwards; `require_idle` is what lets a depositor refuse that, so an `open_epoch` landing first
can never silently convert an instant exit into a queued one (D-46).

**The number to check:** `⌊500 000 000 × 10 245 384 ÷ 10⁷⌋ = 512 269 200` stroops — the shares
burned times the share price §6 settled at. Total assets fell from `2 049 078 024` to
`1 536 808 824`, by exactly that amount, and the share price did not move: an exit prices itself at
`pps`, so it cannot dilute the depositors who stay. The vault's on-chain XLM balance equals its
accounted assets to the stroop — `1 536 808 824` read both ways. Of that, `1 536 807 600` is the
depositor's and `1 024` is attached to the 1 000 dead shares minted on the first deposit; the
remaining **200 stroops** are settlement dust that floored toward the vault, the direction every
rounding in this system takes.

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
   ordering. `buildHost` in the deployment record tells you which host produced the hash you are
   comparing against.
2. **The events are the record.** Every state change emits one. The numbers in this document come
   from them and can be re-derived from them.
3. **The invariants are testable claims, not adjectives.** [`INVARIANTS.md`](INVARIANTS.md) lists
   I1–I10 with how each is verified.
