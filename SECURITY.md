# Security Policy

## Status

**Pre-alpha, testnet only, unaudited.** No mainnet deployment exists. No production funds are at
risk. Every invariant in this repository is asserted by our own tests, which is necessary and not
sufficient.

## Reporting a vulnerability

Please report privately — open a [GitHub security advisory](../../security/advisories/new) on
this repository, or open a regular issue if the finding is clearly not exploitable.

Please include: what breaks, the exact sequence that reaches it, and what an attacker gains.
A reproduction against the test suite is the most useful form; a clear paragraph is fine too.

We will acknowledge within a few days, tell you whether we consider it valid and why, and credit
you unless you prefer otherwise. There is no bug bounty — this is an unfunded pre-alpha project
and we will not pretend otherwise.

## What we consider in scope

- Anything that violates the [invariants](docs/INVARIANTS.md), especially I1 (solvency), I3
  (payout bounded by collateral), I8 (the exit path cannot be paused) and I10 (how a round ends
  is a function of history, not of who calls or when).
- **Any way a party profits by delaying a call.** I10 is the property the protocol's whole claim
  rests on: if you can find a state where waiting pays — for a bidder, a depositor, the keeper or
  the admin — that is a vulnerability even if no funds move incorrectly, and we would rather hear
  it than defend the design.
- Any path where user funds can be trapped, including via the admin, a dead keeper, or a dead
  oracle.
- Any admin capability beyond those enumerated in the [trust model](docs/TRUST_MODEL.md).
- Accounting errors in epoch share math, settlement, or claims.
- Oracle handling: staleness, manipulation, or a guard that fires when it should not (a breaker
  that annuls valid rounds is a real vulnerability — it confiscates earned payouts).

## What is already known

Documented and accepted risks are listed in [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md). A
report matching one of those entries is still welcome — especially if you think our assessment
of it is wrong.

## Upstream

Vulnerabilities in Stellar itself (stellar-core, soroban-sdk, the CLI) belong to the
[Stellar bug bounty on Immunefi](https://immunefi.com/bug-bounty/stellar/), not here.
Vulnerabilities in the Reflector oracle belong to the Reflector project.
