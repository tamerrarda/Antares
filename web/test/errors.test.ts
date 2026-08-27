/**
 * The error table has to stay in step with the contract, and only a test can enforce that.
 *
 * `08-OFFCHAIN §3` requires written text for **every reachable** error code. That requirement decays
 * silently: a contract upgrade adds a code, the bindings regenerate, and the UI keeps compiling
 * while quietly falling back to prose that says "this build has no text for it". Nobody notices
 * until a user meets the code.
 *
 * So the bindings' own `Errors` map is the source of truth and this test is the alarm. It fails in
 * both directions on purpose: a code with no text is the requirement being broken, and text for a
 * code that no longer exists is a claim about a contract that has moved on.
 */
import { Errors } from "@antares/bindings";
import assert from "node:assert/strict";
import { test } from "node:test";

import { explain, explainMessage, knownCodes } from "../lib/errors.ts";

const fromContract = Object.keys(Errors)
  .map(Number)
  .sort((a, b) => a - b);
const fromUi = [...knownCodes()].sort((a, b) => a - b);

test("every error the contract can return has user-facing text", () => {
  const missing = fromContract.filter((c) => !fromUi.includes(c));
  assert.deepEqual(
    missing,
    [],
    `No user-facing text for: ${missing.map((c) => `${c} (${Errors[c as keyof typeof Errors]?.message ?? "?"})`).join(", ")}. ` +
      "08-OFFCHAIN §3: a raw code or a bare 'transaction failed' is a defect, not a fallback.",
  );
});

test("no text describes an error the contract cannot return", () => {
  const stale = fromUi.filter((c) => !fromContract.includes(c));
  assert.deepEqual(stale, [], `Text exists for codes the contract no longer defines: ${stale.join(", ")}.`);
});

test("the table's names match the contract's names", () => {
  for (const code of fromContract) {
    const contractName = Errors[code as keyof typeof Errors]?.message;
    assert.equal(
      explain(code).name,
      contractName,
      `Error ${code} is called "${contractName}" on-chain but "${explain(code).name}" here.`,
    );
  }
});

test("an unrecognised code still produces something a person can read", () => {
  const out = explain(9999);
  assert.match(out.name, /9999/);
  assert.ok(out.title.length > 20 && out.body.length > 60, "the fallback has to say more than the number");
  // The one fact that is true of every refused Soroban transaction, and the one a user most needs.
  assert.match(out.body, /Nothing was taken/);
});

test("a refusal is recognised however the chain phrases it", () => {
  // Three shapes arrive in practice and all three are real: the bindings' own error name, a host
  // error string carrying the numeric code, and a name embedded in a longer message.
  assert.equal(explainMessage("BelowMinDeposit").name, "BelowMinDeposit");
  assert.equal(explainMessage("HostError: Error(Contract, #20)").name, "BelowMinDeposit");
  assert.equal(
    explainMessage("simulation failed: DepositCapExceeded at ledger 41").name,
    "DepositCapExceeded",
  );
});

test("one code means different things at different call sites, and says so", () => {
  // `WrongPhase` from a withdrawal is 08-OFFCHAIN §3's sharpest case — the path the product
  // RECOMMENDS, which works by reverting. From a close it means there is no round to close. A single
  // sentence cannot be true of both, and the table's generic one is true of neither in particular.
  const generic = explain(2);
  const withdrawing = explain(2, "withdraw");
  const closing = explain(2, "close");

  assert.equal(generic.name, withdrawing.name, "the contract's name never changes");
  assert.equal(generic.name, closing.name);
  assert.notEqual(withdrawing.title, closing.title, "but what it means where you are does");
  assert.match(withdrawing.title, /exit landed/);
  assert.match(closing.title, /no round running/);

  // And the routing survives the message forms too.
  assert.match(explainMessage("Error(Contract, #2)", "close").title, /no round running/);
});

test("NothingPending is about a deposit by default and about an exit when collecting one", () => {
  // Measured: `claim_withdraw` with nothing queued returns 22 — the same code `redeem_shares`
  // returns for an absent pending deposit.
  assert.match(explain(22).title, /pending deposit/);
  assert.match(explain(22, "collect").title, /queued exit/);
});

test("a call site with no override falls through to the table rather than inventing text", () => {
  assert.deepEqual(explain(20, "withdraw"), explain(20));
});

/**
 * `WrongPhase` reaches four call sites and means something different at each, and the difference is
 * not decoration: three of them are a clock and one is a guard. A bid that arrives after the auction
 * window shut has to read as timing rather than as the bidder's mistake — `Refusal` paints `kind`
 * `"blocked"` in the alarming register, and telling somebody their correct action was an error is
 * how a UI teaches people that the safe option is dangerous.
 *
 * The assertion that matters is the last one: without the override, the site falls back to the
 * generic sentence, which talks about phases in general and never mentions the window.
 */
test("a late bid is told it was the clock, not a mistake", () => {
  const late = explain(2, "bid");
  assert.equal(late.name, "WrongPhase");
  assert.equal(late.kind, "waiting", "a shut window is timing, never an alarm");
  assert.match(late.title, /auction window/i);
  assert.notEqual(late.title, explain(2).title, "the bid site must not fall through to the generic text");
});
