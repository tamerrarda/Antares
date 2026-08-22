"use client";

import type { ErrorText } from "../lib/errors.ts";

/**
 * A refusal, shown in the register it belongs to.
 *
 * The plan's rule about LAPSED and VOIDED — *"both neutral grey, never red — they are not errors"*
 * — is really a rule about consequence, and it applies here too. `WrongPhase` on the recommended
 * exit is the guard doing its job; `DepositCapExceeded` is something the user can fix; `NotExpired`
 * is a clock. Painting all three the same colour teaches people that the safe option is dangerous.
 */
export function Refusal({ text, signed }: { text: ErrorText; signed?: boolean }) {
  const alarming = text.kind === "blocked" || text.kind === "operator";
  return (
    <div className={alarming ? "block" : "refusal"} role="status">
      <b>{text.title}</b>
      <p>
        {text.body}
        {signed === true &&
          " You were asked to sign, so the attempt is in your wallet history — but it changed nothing."}
      </p>
    </div>
  );
}
