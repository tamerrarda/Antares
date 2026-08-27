/**
 * Turning what somebody typed into stroops, in one place.
 *
 * This lived inside the deposit panel until the bid panel needed the same job. Two copies of a
 * parser is two parsers: the comment below records a measurement, and a second copy would either
 * lose it or drift from it. So it moved here rather than being written twice.
 */

const SCALE = 10_000_000n;
const DECIMALS = 7;

/** What the field currently holds, or why it cannot be used. */
export type Parsed = { readonly stroops: bigint } | { readonly problem: string } | null;

/**
 * An earlier version returned `null` for everything it could not parse, which disabled the button
 * and said nothing. Measured by typing into it: `-5`, `abc`, `1.2.3` and `1,5` all sat in the field
 * with a dead button and no explanation. The last one is the one that matters — a decimal **comma**
 * is how most of Europe writes a decimal, so the most likely "invalid" input is somebody typing the
 * number correctly for their own keyboard.
 *
 * So a comma is not an error, it is a separator: normalised and accepted. Everything genuinely
 * unusable gets a sentence, because a control that refuses without saying why is the same defect as
 * a transaction that fails without saying why.
 */
export function parseAmount(input: string): Parsed {
  const raw = input.trim();
  if (raw === "") return null;

  // A decimal comma is a spelling, not a mistake.
  const t = raw.replace(",", ".");

  if (t.startsWith("-")) return { problem: "An amount cannot be negative." };
  if (!/^\d*\.?\d*$/.test(t) || t === ".") {
    return { problem: "An amount is digits, with at most one decimal point — nothing else." };
  }

  const [whole = "0", frac = ""] = t.split(".");
  if (frac.length > DECIMALS) {
    return {
      problem: `XLM has ${DECIMALS} decimal places and that is more, so it could not be sent exactly.`,
    };
  }
  return { stroops: BigInt(whole || "0") * SCALE + BigInt(frac.padEnd(DECIMALS, "0")) };
}
