/**
 * Units, in one place, because every one of them is a chance to be off by seven decimal places.
 *
 * The contract speaks in stroops (7 dp, SEP-41 `decimals()`), basis points, and unix seconds. The
 * page speaks in XLM, percentages and durations. Nothing outside this module should do that
 * conversion inline — a stray `/ 1e7` is invisible in review and wrong by ten million.
 */

/** SEP-41 `decimals()` for this vault's share token and for XLM itself. */
export const DECIMALS = 7;
const SCALE = 10_000_000n;

/** Stroops to a number of XLM. Lossy by design — this is for display, never for arithmetic. */
export function toUnits(stroops: bigint): number {
  return Number(stroops) / Number(SCALE);
}

/** `12,345.6` — grouped, fixed precision, never in scientific notation. */
export function amount(stroops: bigint, dp = 1): string {
  return toUnits(stroops).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * A price, which the contract also carries at 7 dp.
 *
 * Four decimal places rather than seven: XLM trades near $0.2, so the seventh digit is noise the
 * eye has to step over on every read.
 */
export function price(fixed: bigint): string {
  return `$${toUnits(fixed).toFixed(4)}`;
}

/** Basis points as the percentage a person would say out loud. */
export function bps(v: number): string {
  return `${(v / 100).toFixed(2)}%`;
}

/**
 * A duration, largest two units, no padding fiction.
 *
 * Negative input returns `null` rather than a negative string: a countdown that has passed is not
 * "−3 m", it is a different sentence, and the caller has to choose which.
 */
export function duration(seconds: number): string | null {
  if (seconds < 0) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} m ${String(s).padStart(2, "0")} s`;
  return `${s} s`;
}

/**
 * A ledger timestamp in the reader's own timezone, in this interface's own language.
 *
 * The **zone** is the visitor's, because a window that opens at 16:37 opens at 16:37 on their
 * clock and translating that for them is the whole job. The **locale** is not: the copy around
 * every one of these is English, and a system locale of `tr` renders "21 Ağu" inside an English
 * sentence, which reads as a defect rather than as a courtesy. `en-GB` also puts the day first,
 * which is unambiguous where `en-US` is not.
 */
const LOCALE = "en-GB";

export function when(unixSeconds: bigint | number): string {
  const d = new Date(Number(unixSeconds) * 1000);
  const day = d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/**
 * The two halves separately, for a stat whose value column is too narrow to hold both.
 *
 * "21 Aug 16:37" set at 22px overflows a four-column stat row and wraps mid-timestamp, which reads
 * as an accident. Splitting it puts the date in the value and the time in the caption, which is a
 * decision rather than a wrap.
 */
export function whenParts(unixSeconds: bigint | number): { day: string; time: string } {
  const d = new Date(Number(unixSeconds) * 1000);
  return {
    day: d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" }),
    time: d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }),
  };
}

/** Just the clock, for labels that already carry the date. */
export function clockOf(unixSeconds: bigint | number): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
