/**
 * `σ_realized` — D-67's estimator, and nothing else.
 *
 * > *annualized standard deviation of 5-minute log returns of the same Reflector CEX & DEX feed
 * > the round settled against, over `[open_epoch, expiry]`, population form, annualized by
 * > `√(365·24·12)`.*
 *
 * Every choice in that sentence is forced and D-67 gives the reasons; they are not re-derived here.
 * Two are worth restating because they are the ones an implementation can quietly get wrong:
 *
 * - **Population form**, so the divisor is `n`, not `n − 1`. A sample-form estimator disagrees by
 *   `√(n/(n−1))`. Measured on a real 254-return series off the live feed: **71.8579 % against
 *   71.9998 %**, a 0.14-point gap. An earlier draft of this comment guessed "about 0.02 %" and was
 *   wrong by an order of magnitude — which is the argument for the choice rather than against it.
 *   This is the denominator of the only figure the project publishes as evidence, and a third party
 *   recomputing it from the published series has to land on the *same* number, not a near one.
 * - **`√(365·24·12)`**, i.e. 288 five-minute intervals per day and 365 days. Not 252 trading days:
 *   XLM trades continuously, and a trading-day convention borrowed from equities would understate
 *   σ by `√(365/252)` ≈ 20 %.
 *
 * # The gap rule, which D-67 does not state
 *
 * A 5-minute return needs two samples **five minutes apart**. Reflector's feed is a 300 s grid but
 * a tick can be missing, and a pair straddling a gap spans 10 minutes or more. Treating it as a
 * 5-minute return inflates σ — the return is larger and the interval it is scaled by is not.
 *
 * So a return is formed **only between adjacent samples exactly one resolution apart**, and a gap
 * breaks the chain rather than being bridged. The dropped pairs are counted and returned, because
 * an estimate over a feed that dropped a third of its ticks is not the estimate D-67 defines and
 * the caller has to be able to see that rather than infer it. This is recorded as a finding against
 * D-67 rather than treated as settled: it is an implementation choice standing in for a rule the
 * decision does not carry.
 */

/** Five-minute intervals in a day (24 × 12), and the year D-67 annualizes over. */
export const INTERVALS_PER_DAY = 288;
export const DAYS_PER_YEAR = 365;

/** `√(365 · 24 · 12)` — D-67's annualization factor, computed rather than pasted. */
export const ANNUALIZATION = Math.sqrt(DAYS_PER_YEAR * INTERVALS_PER_DAY);

export class SigmaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigmaError";
  }
}

/** One observation of the feed: a tick-aligned timestamp and the price at it. */
export interface Sample {
  /** Unix seconds, on the feed's resolution grid. */
  readonly ts: number;
  /**
   * The price, already normalized to a fixed scale by the sampler. Ratios are taken, so the scale
   * cancels — but it must be the *same* scale throughout, which is why the sampler refuses a series
   * whose `decimals` changed mid-epoch rather than rescaling it (D-68's reasoning, same hazard).
   */
  readonly price: number;
}

export interface SigmaResult {
  /** σ_realized, annualized. */
  readonly sigma: number;
  /** How many 5-minute returns the estimate is built from. */
  readonly returns: number;
  /** Adjacent pairs discarded because they straddled a gap in the feed. */
  readonly droppedForGaps: number;
  /**
   * Returns actually formed, over returns that *would* exist on a complete grid. 1 means the feed
   * had every tick. Published alongside σ so a reader can judge the estimate rather than trust it.
   */
  readonly completeness: number;
  readonly firstTs: number;
  readonly lastTs: number;
}

/**
 * Log returns between samples exactly `resolution` apart.
 *
 * Samples are assumed sorted and unique; the sampler guarantees both, and a violation here would
 * silently produce a negative interval rather than an error, so it is checked.
 */
export function logReturns(
  samples: readonly Sample[],
  resolution: number,
): { returns: number[]; droppedForGaps: number } {
  if (resolution <= 0) {
    throw new SigmaError(`resolution must be positive, got ${resolution}`);
  }
  const returns: number[] = [];
  let droppedForGaps = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    if (cur.ts <= prev.ts) {
      throw new SigmaError(
        `samples must be strictly increasing in time; ${cur.ts} follows ${prev.ts}. An unsorted ` +
          `or duplicated series would produce returns over negative or zero intervals.`,
      );
    }
    if (prev.price <= 0 || cur.price <= 0) {
      throw new SigmaError(
        `a non-positive price is not a price: ${prev.price} -> ${cur.price} at ${cur.ts}. The ` +
          `adapter filters these before they reach a reading (O-9) and the sampler must too.`,
      );
    }
    if (cur.ts - prev.ts !== resolution) {
      // The gap rule. Not an error: a feed with a missing tick is a normal feed, and refusing the
      // whole epoch over one absent print would throw away a measurement that is still usable.
      droppedForGaps++;
      continue;
    }
    returns.push(Math.log(cur.price / prev.price));
  }
  return { returns, droppedForGaps };
}

/**
 * Population standard deviation.
 *
 * Split out and exported so the divisor is testable on its own: `n` versus `n − 1` is the single
 * most likely place for this estimator to drift from the one D-67 defines, and it is invisible in
 * the final number.
 */
export function populationStdDev(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) {
    throw new SigmaError("the standard deviation of an empty series is not a number");
  }
  const mean = xs.reduce((a, x) => a + x, 0) / n;
  const variance = xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n;
  return Math.sqrt(variance);
}

/**
 * σ_realized over one epoch's samples.
 *
 * `resolution` is the feed's own, read live rather than assumed (D-58): the 5 minutes in D-67's
 * sentence is Reflector's current 300 s grid, and if the feed's resolution changes the estimator
 * has to follow it or the annualization is against an interval the samples do not have.
 */
export function realizedSigma(samples: readonly Sample[], resolution: number): SigmaResult {
  if (samples.length < 2) {
    throw new SigmaError(
      `σ_realized needs at least two samples to form one return; got ${samples.length}. An epoch ` +
        `with no series has no σ, and a fabricated one is worse than an absent one.`,
    );
  }
  const { returns, droppedForGaps } = logReturns(samples, resolution);
  if (returns.length < 2) {
    throw new SigmaError(
      `σ_realized needs at least two returns; the feed supplied ${samples.length} samples and ` +
        `only ${returns.length} adjacent pairs survived the gap rule. This is a sparse feed, not ` +
        `a low-volatility epoch, and reporting a number here would say the opposite.`,
    );
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  // What a complete grid over the same span would have yielded. The denominator is the span rather
  // than the sample count, so a feed that dropped ticks scores below 1 instead of scoring itself.
  const expected = Math.round((last.ts - first.ts) / resolution);

  return {
    sigma: populationStdDev(returns) * ANNUALIZATION,
    returns: returns.length,
    droppedForGaps,
    completeness: expected > 0 ? returns.length / expected : 0,
    firstTs: first.ts,
    lastTs: last.ts,
  };
}
