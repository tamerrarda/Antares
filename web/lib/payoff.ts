/**
 * What a round would do to a given amount, at a range of closing prices.
 *
 * `D-35` forbids a yield figure and names this as what stands in its place: *"a payoff simulator —
 * if XLM closes below the strike you keep X; above it, your upside caps at Y"*. The shape is the
 * argument. Above the strike the `worth` column stops moving, and that flat line **is** the covered
 * call: nothing is liquidated, no position is closed, and the difference is settled in cash.
 *
 * The payout formula is the contract's own, in the single-strike form D-47 records:
 *
 *     payout = notional × (spot − strike) / spot,  when spot > strike
 *
 * D-47 also records why that collapse is only valid with one strike — with fills at different
 * strikes the accumulator diverges from `Σ max(0, ·)` and can even return a negative, i.e. the vault
 * appearing to be owed money by bidders. Every fill in a round shares the round's strike, so the
 * single-strike form is exact here; it would not be if strikes were per-fill.
 *
 * Rounding follows the contract's rule (02-CONTRACT-SPEC): everything LEAVING the vault rounds down,
 * so the dust stays with depositors and solvency can never break on a rounding step. Getting that
 * backwards here would show a payout a fraction larger than the one the chain will make.
 */

const SCALE = 10_000_000n;

export interface PayoffRow {
  /** Percentage move from the price at open, as the caller asked for it. */
  readonly movePct: number;
  /** The closing price, at 7 dp like every other price. */
  readonly close: bigint;
  /** What the depositor still holds afterwards, in stroops. */
  readonly held: bigint;
  /** What that is worth at the closing price, in stroops of value. */
  readonly worth: bigint;
  /** The same holding without the option — `amount × close`. */
  readonly plain: bigint;
  /** `worth − plain`. Negative exactly where the cap bites. */
  readonly difference: bigint;
  /** True once the option finished in the money. */
  readonly capped: boolean;
}

export interface Payoff {
  /** The premium credited when the option sold, in stroops. */
  readonly credited: bigint;
  readonly rows: readonly PayoffRow[];
}

/** Floor division that stays correct for negatives — BigInt `/` truncates toward zero. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

export function payoff(
  amount: bigint,
  openPrice: bigint,
  strike: bigint,
  premiumBps: number,
  moves: readonly number[],
): Payoff {
  // Down, like every amount that leaves the vault. The dust stays with depositors.
  const credited = floorDiv(amount * BigInt(Math.round(premiumBps * 100)), 1_000_000n);

  const rows = moves.map((movePct): PayoffRow => {
    const close = floorDiv(openPrice * BigInt(Math.round((100 + movePct) * 100)), 10_000n);
    const payout = close > strike ? floorDiv(amount * (close - strike), close) : 0n;
    const held = amount + credited - payout;
    return {
      movePct,
      close,
      held,
      worth: floorDiv(held * close, SCALE),
      plain: floorDiv(amount * close, SCALE),
      difference: floorDiv(held * close, SCALE) - floorDiv(amount * close, SCALE),
      capped: payout > 0n,
    };
  });

  return { credited, rows };
}
