/**
 * Does the interface name the refusals the live contract actually returns?
 *
 * Run by hand, against a network. `test/errors.test.ts` proves the table covers every code the
 * *bindings* declare, which is a different and weaker claim: it cannot tell whether the code ever
 * reaches `explainMessage` in a form it recognises. This script closes that gap by provoking real
 * refusals and printing the name each one resolves to.
 *
 * It found the bug it exists to find. Matching on the parsed `Result`'s message — the obvious
 * approach, and the first one here — named almost nothing: measured 2026-08-22, most codes arrive
 * as `{ message: "" }` and `close_round` arrived carrying a Rust doc comment for a *different*
 * error than the one the simulation reported. The numeric code appears in exactly one place,
 * `simulation.error`, and `lib/tx.ts` reads it there because of this run.
 *
 *     NETWORK=testnet node --experimental-strip-types web/scripts/probe-refusals.ts
 *
 * Nothing is signed and nothing is submitted. The signer below throws on contact, so a call that
 * reaches it reports "reached signing" rather than quietly sending a transaction — which is also
 * how the one clean simulation in the list proves the guard order is right way round.
 */
import type { AssembledTransaction, Result } from "@stellar/stellar-sdk/contract";

import { explain } from "../lib/errors.ts";
import { submit } from "../lib/tx.ts";
import { writeClient } from "../lib/vault.ts";

/** The deployer, which is public record in `deployments/testnet.json`. No key is used. */
const WHO = "GDFPSLESDEPR2XSNASBK3464NLB7HYG6IS2SX2TYCJK7KUPIEWFEKBQQ";

const client = writeClient(WHO, process.env);
const refuses: Parameters<typeof submit>[1] = {
  address: WHO,
  // A rejected promise rather than a throw: same effect, and it matches the signer's async shape
  // without an `async` function that never awaits anything.
  signTransaction: () => Promise.reject(new Error("probe-refusals must never sign")),
};

/** Each case returns a differently-parameterised `Result`; the probe only looks at whether it failed. */
type Call = () => Promise<AssembledTransaction<Result<unknown>>>;

const CASES: ReadonlyArray<readonly [string, Call, number | null]> = [
  ["deposit, a sane amount", () => client.deposit({ from: WHO, amount: 50_000_000n }), null],
  ["deposit, below the minimum", () => client.deposit({ from: WHO, amount: 100_000n }), 20],
  ["deposit, past the cap", () => client.deposit({ from: WHO, amount: 20_000_000_000_000n }), 21],
  ["redeem with nothing pending", () => client.redeem_shares({ from: WHO }), 22],
  ["close a round that is not running", () => client.close_round({ bounty_to: WHO }), 2],
];

let bad = 0;
for (const [label, build, expected] of CASES) {
  const out = await submit(build(), refuses);
  if (out.status === "refused" && out.signed) {
    const verdict = expected === null ? "  ok" : "MISS";
    if (expected !== null) bad += 1;
    console.log(`${verdict}  ${label.padEnd(34)} simulation was clean, reached signing`);
    continue;
  }
  if (out.status === "refused") {
    const want = expected === null ? "a clean simulation" : explain(expected).name;
    const got = out.refusal.name;
    const verdict = got === want ? "  ok" : "MISS";
    if (got !== want) bad += 1;
    console.log(`${verdict}  ${label.padEnd(34)} ${got}${got === want ? "" : `  (expected ${want})`}`);
    console.log(`      ${out.refusal.title}`);
  }
}

console.log(bad === 0 ? "\nEvery refusal resolved to the name it should." : `\n${bad} case(s) did not.`);
process.exit(bad === 0 ? 0 : 1);
