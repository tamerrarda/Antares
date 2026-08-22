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

import { explain, knownCodes } from "../lib/errors.ts";

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
