# Antares — Documentation

Covered call vaults on Stellar. **Pre-alpha, testnet only, unaudited.**

Start with the document written for what you are trying to do.

## By reader

| You are… | Read | It answers |
|---|---|---|
| **Considering depositing XLM** | [DEPOSITOR.md](DEPOSITOR.md) | What the trade is, when you can get your money back, what can go wrong |
| **A potential counterparty (bidder)** | [BIDDER.md](BIDDER.md) | What you're buying, how to bid, how you get paid, every stated risk |
| **Evaluating whether to trust this** | [TRUST_MODEL.md](TRUST_MODEL.md) · [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Who can do what to your funds; what we know is wrong or unproven |
| **Auditing or reviewing the code** | [ARCHITECTURE.md](ARCHITECTURE.md) · [INVARIANTS.md](INVARIANTS.md) · [../SECURITY.md](../SECURITY.md) | The design, the properties that must hold, how to report a finding |
| **Integrating or building on it** | [ARCHITECTURE.md](ARCHITECTURE.md) | Contract surface, storage model, events |
| **New to the project** | [../README.md](../README.md) | Why this exists, the roadmap, and its limits |

## The documents

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the system works: contract surface, storage model,
  epoch accounting, settlement math, oracle handling, failure modes.
- **[INVARIANTS.md](INVARIANTS.md)** — the canonical list of properties that must hold in every
  reachable state, why each exists, and how each is verified. Other documents link here rather
  than restating them.
- **[TRUST_MODEL.md](TRUST_MODEL.md)** — every power that exists in the system and who holds it,
  including the ones we would rather didn't exist.
- **[DEPOSITOR.md](DEPOSITOR.md)** — the depositor's guide, written for someone who has never
  traded an option.
- **[BIDDER.md](BIDDER.md)** — the counterparty's guide. The buyer side of this market is the
  project's biggest open question, so it gets a document of its own.
- **[KNOWN_ISSUES.md](KNOWN_ISSUES.md)** — accepted risks, open questions, and a record of what
  design review already caught and fixed.
- **[../SECURITY.md](../SECURITY.md)** — how to report a vulnerability.

## Terms

| Term | Meaning |
|---|---|
| **Epoch / round** | One full cycle: the vault sells an option, it runs to expiry, and the result is recorded. |
| **Strike** | The price above which the buyer's option pays. Set when the epoch opens, a fixed percentage above the market price. |
| **Premium** | What the buyer pays up front for the option. It goes to depositors. |
| **Notional** | The amount of XLM the option is written against. |
| **Share / `pps`** | Your claim on the pool, and its value in XLM (`price per share`). Changes only when a round finishes. |
| **Pending deposit** | XLM deposited during a live round. Not yet shares, not backing the option, cancellable. |
| **Lapsed** | A round where no buyer appeared. No premium, no loss, share price unchanged. |
| **Voided / annulled** | A round cancelled because the price feed was unusable at expiry. Premiums refunded, share price unchanged. |
| **Unresolved** | A round nobody closed before its expiry moment aged out of the price feed's history. It can no longer be decided on evidence, so the premium stays with depositors and the payout is zero — the rule is chosen so that nobody who could cause the delay gains by it (the passive asymmetry that survives is disclosed in [KNOWN_ISSUES](KNOWN_ISSUES.md) A-10). |
| **Keeper** | A bot that opens epochs and closes rounds. A convenience — everything it does, anyone can do, and it cannot choose how a round ends. |
| **Cash settlement** | The option pays a difference in XLM rather than delivering the asset. No second leg, no delivery risk. |

## Reading the design as a whole

The contract is deliberately one contract, one asset, one strategy. (Five *instances* of it run
side by side during the counterparty phase, on different terms — see
[ARCHITECTURE.md](ARCHITECTURE.md) §12.) The properties it protects, in order of importance:

1. **Nobody's funds can be trapped** — not by the admin, not by a dead keeper, not by a dead
   oracle, not by pause. ([INVARIANTS.md](INVARIANTS.md) I8, [TRUST_MODEL.md](TRUST_MODEL.md))
2. **The vault cannot owe more than it holds** — payout is mathematically bounded by the
   collateral behind it, so there is no leverage, no margin call, and no bad debt.
   ([INVARIANTS.md](INVARIANTS.md) I1, I3)
3. **Capital earns only what it was at risk for** — epoch-gated share accounting, so late money
   cannot dilute the premium earned by money that took the risk.
   ([ARCHITECTURE.md](ARCHITECTURE.md) §4)
4. **Every failure mode has a defined behaviour** — including the ones that produce nothing: an
   auction with no buyer and a round annulled by a dead oracle are normal outcomes, not errors.
5. **Waiting is not an action that pays anyone who can choose it** — the settlement price is read
   as it stood at expiry, and every way a round can end is chosen so that nobody who could cause
   a delay profits by one; the single passive asymmetry that survives is disclosed rather than
   claimed away ([KNOWN_ISSUES.md](KNOWN_ISSUES.md) A-10). Closing a round is one permissionless
   call whose outcome the caller does not choose. ([INVARIANTS.md](INVARIANTS.md) I10)
