# Security Policy

**Pre-alpha, testnet only, unaudited.** No mainnet deployment exists and no production funds are at
risk. Every invariant here is asserted by our own tests, which is necessary and not sufficient — so if
you find something, we would rather hear it than defend the design.

## Contact

**[Open a private security advisory.](https://github.com/tamerrarda/Antares/security/advisories/new)**
That channel is private to the maintainers and encrypted in transit; a regular issue is fine if the
finding is clearly not exploitable.

You will get an acknowledgement, then a verdict — whether we consider it valid, and **the reasoning
either way.** A finding we reject is rejected with an argument rather than with silence. Disclosure
timing is agreed with you rather than imposed.

**No fixed turnaround is promised**, and that is deliberate rather than evasive: this is an unfunded
pre-alpha project with no on-call rotation, and a deadline we might not honour is worth less than
none. What is promised is the shape of the answer, not the date on it.

There is no PGP key published for this project; the advisory channel above is private and encrypted
in transit, which is what there is.

## Scope

### Assets

| | |
|---|---|
| Vault (`aXLM-E`) | [`CCYAHS4D…LBVEA`](https://stellar.expert/explorer/testnet/contract/CCYAHS4DJLGNDU7GTSDUJL4ZZ2X6VZI7IPHJM2W2SNVA6RDALEALBVEA) · Stellar testnet |
| Price adapter | [`CBR3GSAZ…BCEN5Z`](https://stellar.expert/explorer/testnet/contract/CBR3GSAZUOFGWP5IUSIJP5ESUZPDIO42WAZ5VIFSNYZURH2VVSBCEN5Z) · ours, no admin, no upgrade path |

### Code

There are no tagged releases. Reports against `main` and against the deployed commit — recorded in
[`deployments/testnet.json`](deployments/testnet.json) — are both in scope, and so is everything in
this repository: the contracts, the deployment and verification scripts, the keeper, the reference
bidder, the web interface, the documentation site and the Python differential reference.

### Out of scope

The Stellar network itself, the third-party price feed the adapter reads, and the XLM Stellar Asset
Contract. See [Upstream](#upstream) for where those go.

## What we especially want

- **Anything that violates the [ten invariants](docs/INVARIANTS.md).** They are stated precisely, with
  what breaks without each one and how each is verified. A counterexample to any of them is the most
  valuable thing you can send us.
- **Any way to profit by causing or prolonging a delay.** This is the one we most want, and it counts
  **even when nothing moves incorrectly** — **I10**, that how a round ends is a function of history
  rather than of who calls or when, is the property this protocol's whole claim rests on.
- **Any path where user funds can be trapped**, via the admin, a dead keeper or a dead oracle.
- **Any admin capability beyond the enumerated ones.** There is an admin: one key on testnet. It can
  pause the three ways *in* (`deposit`, `bid`, `open_epoch`), set the deposit cap, the fee, the fee
  recipient, the round parameters (next round only), the expiring bidder allowlist and the rent
  thresholds, hand the role on in two steps, and replace the code. It **cannot** move funds, mint
  shares, rewrite a finalized round, choose a settlement price or outcome, block the exit path, or
  repoint the oracle or the asset — those two have no setter in the contract at all. Anything outside
  that list, or any way around one of those limits, is a finding.
  ([The full trust model.](docs/TRUST_MODEL.md))
- **Oracle handling**, including a guard that fires when it should *not*.
- **Anything in the documentation that contradicts the code.** The docs make claims about what the
  contract does; a claim that is not true of it *is* the finding.

## Known issues — please do not re-report

Recorded rather than hidden. A report that extends one of these into something an attacker can
*bring about* is very much wanted; a report that restates it is not a finding.

1. **A passive asymmetry under I10.** Depositors collectively keep more if an in-the-money round is
   never closed in time. Drift is an absence of action rather than an action, and closing is
   permissionless. Show a way to *make* it happen and that is a finding of the first order.
2. **One stated precondition in I10.** If the price feed lengthens its own tick past
   `(unresolved_after + guard_window) ÷ 255` mid-round — about 311 seconds against the 300 it runs
   today — the oracle-free fallback can fire while an anchored read would still have answered.
   Exposure is one round, because opening a round re-checks the live feed.
3. **The wasm hash is host-dependent.** The same commit builds to the same size and the same exported
   interface on macOS and Linux, and to two different SHA-256s.
4. **The generated differential corpus is red.** The four hand-written vectors agree byte for byte
   across all four replayed sections; a 204-vector generated corpus does not, and about 87 fail from a
   single categorised cause the repository records as a specification disagreement rather than a
   defect in either implementation.
5. **The mutation run is scoped.** It covers the single module nothing else grades, at a bar of zero
   survivors; two further modules have twenty-two unjudged timeouts recorded as an open item.

## Not vulnerabilities

The contract is upgradeable behind an admin key — disclosed and argued in the trust model, and chosen
over immutability because immutability before an audit is an unfixable bug waiting to happen. A round
can lapse and the premium can be zero; a guarantee of yield is explicitly not an invariant. A round
can settle against a depositor; capping the upside is the trade. XLM sent directly to the contract is
unrecoverable, because code that can move unattributed funds can move attributed ones. Testnet state
is wiped on a schedule.

## Testing

Test XLM is free and breaking things on testnet is welcome — adversarial call orderings, boundary
timing, oversell attempts, closing rounds out from under the keeper. That is the behaviour this design
claims to be safe against. Please try.

**Prohibited, and a report obtained this way will not be accepted:**

- Touching balances that are not yours. Unclaimed payouts, refunds and withdrawals belong to whoever
  earned them.
- Attacking the price feed, public RPC endpoints or the network — shared infrastructure other projects
  depend on, and out of scope here anyway.
- Automated scanning heavy enough to degrade a public endpoint.
- Social engineering, phishing, or targeting contributors, their accounts or their devices.
- Physical attacks against anyone or any infrastructure.
- Public disclosure before the coordinated window has run.

## Safe harbour

We have no interest in pursuing anyone who researches in good faith and within this policy, and we do
not intend to take or support action against such a report. Good faith means reporting promptly, not
accessing or modifying data that is not yours, not degrading the network for others, and giving us a
reasonable window before publishing.

This is a statement of intent rather than a legal grant — it is not written by a lawyer and it cannot
bind anyone else. If you are unsure whether something is in scope, open the advisory and ask; that is
exactly the right move.

## Rewards

**There is no bug bounty.** This is an unfunded pre-alpha project and we will not pretend otherwise.

What is on offer instead: credit in the advisory and in the published write-up unless you prefer
otherwise, and a finding published in full rather than quietly patched.

## Upstream

Bugs in Stellar itself — `stellar-core`, `soroban-sdk`, the CLI — belong to
[the network's own bug bounty programme](https://immunefi.com/bug-bounty/stellar/). Bugs in the
third-party price feed belong to whoever maintains it.

The price **adapter** in front of that feed is ours and is in scope: it has no admin and no upgrade
path, and every settlement number is computed inside it.
