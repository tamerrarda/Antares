/**
 * The vocabulary every gate in `deploy.ts` speaks: a comparison, its two sides, and why it exists.
 *
 * `09-DEPLOYMENT.md` §2 and `DEV3.md` §6.1 both describe the deploy the same way — *"the gates run
 * **in sequence, asserted by the script**, not by the operator's memory"*. A gate that prints a
 * number and leaves the judging to a human is not a gate; a gate that prints only PASS or FAIL
 * leaves the human unable to act on the failure. So every check carries **both sides and the
 * promise it enforces**, and the renderer shows them on failure.
 *
 * This module holds no policy. It is here so that step 0's toolchain gate, step 2's export-surface
 * assertion and step 5's post-deploy battery report identically — one shape, one renderer, and a
 * deploy record that can list check ids without each step having invented its own.
 */

export interface Check {
  /** Stable identifier, cited in the deployment record and in a failure report. */
  readonly id: string;
  /** The promise being enforced, in the words of the document that makes it. */
  readonly what: string;
  readonly ok: boolean;
  readonly expected: unknown;
  readonly actual: unknown;
  /** Shown only on failure: what the reader should do about it, or why the check exists. */
  readonly note?: string;
}

export function mkCheck(
  id: string,
  what: string,
  expected: unknown,
  actual: unknown,
  ok: boolean,
  note?: string,
): Check {
  return note === undefined ? { id, what, ok, expected, actual } : { id, what, ok, expected, actual, note };
}

export function allPassed(checks: readonly Check[]): boolean {
  return checks.every((c) => c.ok);
}

export function failedIds(checks: readonly Check[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => c.id);
}

/**
 * Structural equality over the shapes a decoded contract value can take — `bigint`, `number`,
 * `string`, `boolean`, `null`, arrays, plain objects.
 *
 * The `bigint`/`number` bridge is load-bearing rather than lenient. A `u32` field decodes as a
 * `number` and a `u64` beside it as a `bigint`, while an expectation written by hand is whichever
 * the author typed. Comparing `7` against `7n` with `===` is `false`, and a gate that fires on that
 * is a gate that refuses a healthy deploy — which is the expensive direction to be wrong in.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    const na = typeof a === "bigint" || typeof a === "number" ? BigInt(a) : null;
    const nb = typeof b === "bigint" || typeof b === "number" ? BigInt(b) : null;
    return na !== null && nb !== null && na === nb;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

export function show(v: unknown): string {
  if (typeof v === "bigint") return `${v}`;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}` : x)) ?? String(v);
}

/** One line per check; failures carry both sides and the note, because that is what acting on a failure needs. */
export function renderChecks(title: string, checks: readonly Check[]): string[] {
  const lines: string[] = [title];
  for (const c of checks) {
    lines.push(`  [ ${c.ok ? "ok" : "FAIL"} ] ${c.id.padEnd(34)} ${c.what}`);
    if (!c.ok) {
      lines.push(`           expected ${show(c.expected)}`);
      lines.push(`           actual   ${show(c.actual)}`);
      if (c.note !== undefined) lines.push(`           ${c.note}`);
    }
  }
  const failed = failedIds(checks).length;
  lines.push(
    failed === 0
      ? `  all ${checks.length} assertions hold.`
      : `  ${failed} of ${checks.length} assertions FAILED.`,
  );
  return lines;
}
