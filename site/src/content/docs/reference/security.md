---
title: Reporting a vulnerability
deck: What is in scope, how to report it, and what this project can and cannot offer in return.
---

**Pre-alpha, testnet only, unaudited.** No mainnet deployment exists and no production funds are at
risk. Every invariant in this system is asserted by this project's own tests, which is necessary and
not sufficient.

## How to report

Report privately — open a GitHub security advisory on
[the repository](https://github.com/tamerrarda/Antares), or a regular issue if the finding is clearly
not exploitable.

Please include **what breaks, the exact sequence that reaches it, and what an attacker gains.** A
reproduction against the test suite is the most useful form; a clear paragraph is fine too.

You will get an acknowledgement within a few days, a decision on whether we consider it valid and
why, and credit unless you prefer otherwise.

**There is no bug bounty.** This is an unfunded pre-alpha project and pretending otherwise would be
worse than saying so.

## In scope

- **Anything that violates the [invariants](../trust/invariants.md)** — especially I1 (solvency), I3
  (payout bounded by collateral), I8 (the exit path cannot be paused) and I10 (how a round ends is a
  function of history, not of who calls or when).
- **Any way a party profits by *causing or prolonging* delay.** I10 is the property this protocol's
  whole claim rests on. If you can find a state where a bidder, a depositor, the keeper or the admin
  can profitably bring a delay about — or keep one alive — **that is a vulnerability even if no funds
  move incorrectly**, and we would rather hear it than defend the design.

  One passive asymmetry is already known and not hidden: depositors keep more if an in-the-money
  round is never closed in time. It qualifies here the moment you can show a way to *make* that
  happen.
- **Any path where user funds can be trapped**, including via the admin, a dead keeper, or a dead
  oracle.
- **Any admin capability beyond those enumerated** in
  [the trust model](../trust/trust-model.md).
- **Accounting errors** in round share math, settlement, or claims.
- **Oracle handling** — staleness, manipulation, or **a guard that fires when it should not.** A
  breaker that annuls valid rounds is a real vulnerability: it confiscates payouts a bidder earned.

## A finding this project treats as first-class

**If you find something on this site that contradicts the code, that contradiction *is* the
vulnerability.** Please report it as one. The documentation makes claims about what the code does; a
claim that is not true of the code is exactly the failure this project's whole approach is trying to
prevent.

## Upstream

Vulnerabilities in Stellar itself — `stellar-core`, `soroban-sdk`, the CLI — belong to Stellar's own
bug bounty programme, not here. Vulnerabilities in the oracle this vault reads belong to whoever
maintains that oracle.

## Not a vulnerability

Stated so nobody wastes their time:

- **The contract is upgradeable behind an admin key.** Disclosed, deliberate, and explained in
  [the trust model](../trust/trust-model.md#3-upgradeability-the-honest-part).
- **The premium can be zero, and rounds can lapse.** A guarantee of yield is explicitly not an
  invariant.
- **A round can settle against you.** Capping your upside is the trade, not a malfunction.
- **XLM sent directly to the contract address is unrecoverable.** There is no sweep function, on
  purpose: code that can move unattributed funds can move attributed ones.
