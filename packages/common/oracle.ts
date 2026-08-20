/**
 * Facts about the feed's shape that more than one package needs, and the arithmetic derived from
 * them.
 *
 * # Why this file exists
 *
 * `RECORD_CAP_TICKS` was defined **three times** — `scripts/profile-adapter.ts`,
 * `scripts/verify-environment.ts` and `keeper/reflector.ts` — with the same value and three copies
 * of the same provenance comment. DEV2 found the third and made the placement argument: the
 * duplication spans two packages, so `scripts/lib/` cannot be the home because it would not serve
 * the keeper, and `packages/common` is where a fact about the deployed system belongs. Transferred
 * to DEV3 rather than moved by them, and this is that transfer.
 *
 * **The reason it is worth doing is D-69 itself.** That decision corrected this number once, from
 * 256 to 255, after a measurement. Three copies means the next correction has three places to find,
 * and `typescript_declarations_are_unique` cannot help — it only sees within a file.
 *
 * # The number, and the off-by-one that produced it
 *
 * **Measured 2026-08-19 and the gate fired: the cutoff is 255 ticks, not 256 (D-69).** The bar had
 * been `256 × resolution` and the live answer was 76 500 s against 76 800 s assumed. The bitmask
 * holds 256 records, which span **255 intervals**, and reach is a *depth* — so the multiplier is
 * 255. The off-by-one sat on the side that costs money: the adapter's oldest guard sample would have
 * landed one tick beyond the horizon, and a healthy feed would have produced `Unusable`, which is
 * the void path.
 *
 * It is a fact about a system nobody here controls, so a deploy re-checks it rather than trusting
 * this line — see `scripts/verify-environment.ts`, which measures the cutoff by a full sweep and
 * cross-checks it by bisection, and fails on a shortfall.
 */

/**
 * `price-source-api::RECORD_CAP_TICKS` — the reachable depth of the feed's history, in ticks.
 *
 * 255, not 256. See this file's header for the measurement and the off-by-one.
 */
export const RECORD_CAP_TICKS = 255;

/**
 * How many seconds of history the feed still holds, at a given tick resolution.
 *
 * `R` in the condition arithmetic. At the shipped 300 s resolution this is about 21 h 15 m, which is
 * why the keeper samples σ **as the epoch runs**: an epoch is 3 to 14 days, so by expiry the opening
 * ticks are gone from the feed and no amount of care afterwards brings them back.
 */
export function reachSeconds(resolution: number): number {
  return RECORD_CAP_TICKS * resolution;
}

/**
 * The oldest anchor an evidence-backed read can still reach: `R − guard_window`.
 *
 * Derived rather than restated, because the derivation was duplicated alongside the constant and
 * would drift the same way. `unresolved_after > reach_limit` is `supports_round`'s condition 3 — the
 * evidence-free fallback must fire strictly *after* the adapter gives up — and condition 6 caps the
 * same quantity from above.
 */
export function reachLimit(resolution: number, guardWindow: number): number {
  return reachSeconds(resolution) - guardWindow;
}
