# Reference bidder

**This is a self-operated bidder.** It is run by the same people who run the vault. A premium
cleared against it on testnet is a mechanism test — evidence that an auction can open, fill and
settle — and **not** a market price. Nothing in this repository should be read as saying otherwise,
and the process prints that sentence at startup so an operator sees it every time.

## What it does, stated as narrowly as it deserves

It buys at or below a number a human put in an environment variable.

That is the whole strategy. It does **not** estimate volatility, does not price the option, and has
no opinion about whether the premium on offer is a good one. 08-OFFCHAIN §2 asks for a deliberately
naive v1 and says to disclose it in the open; this paragraph is that disclosure rather than a note
about future work.

Each pass:

1. reads `epoch()` — phase, the contract's own curve at `now`, what is offered, what is sold;
2. reads its own standing against the allowlist;
3. totals the notional it is already carrying;
4. decides, in one pure function (`strategy.ts`);
5. and, only if the decision is to bid, simulates → assembles → signs → sends → waits.

It bids when the descending curve reaches its target, sending `max_premium_bps = target` rather than
the rate it observed. The slippage guard is the bidder's **own** argument and is identical at
simulation and execution (D-84), so no price it did not name can be charged to it.

## The seam for someone who can actually price this

`Strategy` is one pure method, from the auction's public state to a number of basis points:

```ts
export interface Strategy {
  readonly name: string;
  targetBps(view: AuctionView): number;
}
```

An independent party plugging in real pricing replaces that method and nothing else. The risk caps
sit deliberately **outside** it: a strategy that could raise its own position limit is a strategy
that can lose more than its operator agreed to.

## Configuration

No defaults for the three numbers that decide what it pays and risks. A default position size is a
position size nobody chose.

| Variable | Meaning |
|---|---|
| `RPC_URL`, `NETWORK_PASSPHRASE` | the network |
| `VAULT_ID` | the vault to bid into |
| `BIDDER_SECRET` | the bidding key. It has no authority over the vault: it can bid, and it can claim what it bought |
| `TARGET_BPS` | the premium, in bps, at or below which it will buy |
| `MAX_NOTIONAL` | most notional to take in any one round, in stroops |
| `MAX_PORTFOLIO_NOTIONAL` | most notional to hold across rounds it has not claimed, in stroops |
| `LOG_LEVEL=debug` | prints the reason it is waiting on every pass |

```sh
RPC_URL=… NETWORK_PASSPHRASE=… VAULT_ID=C… BIDDER_SECRET=S… \
  TARGET_BPS=120 MAX_NOTIONAL=5000000000 MAX_PORTFOLIO_NOTIONAL=20000000000 \
  pnpm --filter @antares/bidder start
```

## Three things worth knowing before running it

**The total cap counts unclaimed rounds, not unsettled ones.** A settled round's option has expired
and carries no further market risk, so a pure risk reading would drop it. What it still carries is
capital the operator has not seen come back, and a bidder that keeps buying while its claims pile up
is the exact thing a total cap is for. The lookback is bounded, so a position older than the window
is invisible and the cap under-counts — the direction that fails toward bidding, which is why the
number appears in the log.

**A refusal is not automatically a retry.** `errors.ts` classifies by code, because a bidder that
treats every rejection as "try again later" is indistinguishable from one that is broken and keeps
paying fees to prove it. Losing a race is benign. An unreachable feed is transient and is **not**
absent demand — conflating the two would corrupt the one measurement the project's continuation
depends on. The allowlist refusing is `blocked`, and the loop stops rather than spend fees learning
the same thing.

**Two codes stop the process outright.** `decide()` claims to prevent `BelowMinFill` and
`ZeroPremium`. If either arrives, this package's copy of a contract rule has drifted from the rule,
and answering a logic bug with a retry would hide it for as long as the process runs.

## Tests

`node --test` over `test/`, all against a fake client — no network, no testnet round to reproduce.
Every rule in the decision and every disposition has one, and each was watched failing against a
deliberately broken implementation before being kept.
