/**
 * Every reachable contract error, in words a person can act on.
 *
 * `08-OFFCHAIN §3` makes this a requirement rather than polish: *"Every reachable error code has
 * written user-facing text, and the mapping ships with the UI... a raw code or a bare 'transaction
 * failed' is a defect, not a fallback."* The standard to match is `BIDDER §2`'s rejection table,
 * which explains **why** each rejection exists, not just that it happened.
 *
 * The sharpest case is the one the product *recommends*. `request_withdraw(require_idle = true)`
 * is documented to depositors as the safe default and it works by **reverting** with `WrongPhase`
 * when a round opened first — so the recommended path shows a red failure unless this file says
 * what actually happened. That is why `kind` exists: a refusal that protected you is not the same
 * event as a mistake, and rendering them identically teaches people to fear the safe option.
 *
 * One fact underwrites every entry below and is stated once here rather than in each: a Soroban
 * transaction that reverts changes nothing. No partial state, no fee taken from your balance, no
 * half-moved funds. "Nothing was taken" is not reassurance, it is how the chain works.
 */

/**
 * What the refusal means for the person reading it.
 *
 * - `working` — the guard did its job and you are better off than if it had not fired.
 * - `blocked` — something has to change before this call can succeed, and you can change it.
 * - `waiting` — nothing is wrong; a clock has not run out yet.
 * - `absent`  — there is nothing here to act on, which is usually a stale page rather than a loss.
 * - `operator` — an admin-only path. A depositor who sees one of these has found a bug in us.
 */
export type ErrorKind = "working" | "blocked" | "waiting" | "absent" | "operator";

export interface ErrorText {
  readonly name: string;
  readonly kind: ErrorKind;
  /** One line, in the second person, saying what happened. */
  readonly title: string;
  /** Why the refusal exists, and what to do next. */
  readonly body: string;
}

const TABLE: Readonly<Record<number, ErrorText>> = {
  1: {
    name: "Paused",
    kind: "blocked",
    title: "The vault is paused, so nothing new can go in.",
    body:
      "Pause stops deposits and new rounds. It cannot stop you leaving: closing a round, redeeming a " +
      "pending deposit and queueing an exit all work while paused, which is why a pause can never " +
      "trap what you already hold.",
  },
  2: {
    name: "WrongPhase",
    kind: "working",
    title: "A new round opened before this landed. Nothing was taken and nothing changed.",
    body:
      "You asked for an action that only makes sense between rounds, and a round started first. The " +
      "call refused instead of putting you into something you had not seen the terms of. Wait for " +
      "the next window, or choose the version that queues you at this round's closing price.",
  },
  3: {
    name: "IdleGapNotElapsed",
    kind: "waiting",
    title: "The next round cannot open yet.",
    body:
      "Between rounds there is a guaranteed window in which deposits and exits are instant, and it " +
      "has not run its minimum length. Nobody can shorten it — not the operator, not a keeper, not " +
      "you. It is the one interval in which leaving is always immediate.",
  },
  4: {
    name: "NotExpired",
    kind: "waiting",
    title: "This round has not expired yet, so it cannot be closed.",
    body:
      "Settlement reads the price at expiry. Closing early would have to invent one, so the contract " +
      "refuses until the moment arrives — and from then on anyone may close it, including you.",
  },
  6: {
    name: "OracleNotDeadYet",
    kind: "waiting",
    title: "It is too early to annul this round.",
    body:
      "Annulling refunds the buyer's premium, so it needs proof the price feed was dead at expiry " +
      "rather than briefly quiet. The contract will not accept that proof until the grace period " +
      "has run, because a feed that is late is not a feed that is gone.",
  },
  7: {
    name: "NothingOffered",
    kind: "blocked",
    title: "There is nothing to write an option against.",
    body: "The vault holds no collateral this round, so there is no notional to sell and no auction to open.",
  },
  8: {
    name: "NoShares",
    kind: "blocked",
    title: "This vault has never had a deposit.",
    body: "A round needs collateral to cover. Until somebody deposits, there is nothing for a buyer to buy.",
  },
  9: {
    name: "RoundNotFound",
    kind: "absent",
    title: "That round does not exist.",
    body: "Either the number is wrong or this page is older than the vault. Reloading is the usual fix.",
  },
  10: {
    name: "OracleStale",
    kind: "working",
    title: "The price feed's latest reading is too old to use.",
    body:
      "The contract will not settle against a stale price, because a stale price is somebody's " +
      "advantage. This one clears itself: the round retries and still settles normally once the " +
      "feed catches up.",
  },
  11: {
    name: "OracleDeviation",
    kind: "working",
    title: "The price feed moved further than the guard allows.",
    body:
      "Two samples disagreed by more than the round's deviation limit, which is what a manipulated " +
      "or broken feed looks like. The contract halts rather than settling on it. The round is not " +
      "lost — it retries, and there is a deadline past which it closes either way.",
  },
  12: {
    name: "OracleInvalidPrice",
    kind: "working",
    title: "The price feed returned something that is not a price.",
    body:
      "Zero, or a negative. The contract refuses to reason about it rather than treating it as a " +
      "market move, which is the only safe reading of a number that cannot be true.",
  },
  13: {
    name: "OracleUnreachable",
    kind: "working",
    title: "The price feed cannot be reached right now.",
    body:
      "Your funds are unaffected. Anything that needs a live price — settling a round, checking a " +
      "bid against the strike — waits. Anything that does not, including leaving, still works.",
  },
  20: {
    name: "BelowMinDeposit",
    kind: "blocked",
    title: "That is below the smallest deposit this vault accepts.",
    body:
      "A minimum exists so the vault does not fill with positions that cost more in fees to maintain " +
      "than they hold. Send at least the minimum shown next to the field.",
  },
  21: {
    name: "DepositCapExceeded",
    kind: "blocked",
    title: "That would take the vault past its deposit cap.",
    body:
      "The cap is a deliberate limit on how much is at risk while this is unaudited, and it is " +
      "readable on-chain before you deposit anything. Depositing the headroom shown will work.",
  },
  22: {
    name: "NothingPending",
    kind: "absent",
    title: "You have no pending deposit to act on.",
    body: "Either it was already collected, or this page is showing a state the chain has moved past. Reload.",
  },
  24: {
    name: "UnredeemedPending",
    kind: "blocked",
    title: "Collect your waiting deposit first.",
    body:
      "An earlier deposit is still sitting as a pending one, and a second would have no unambiguous " +
      "price to convert at. Collecting it takes one transaction and turns it into shares at the " +
      "price its round ended on — this is not a fee or a penalty, and nothing expires.",
  },
  25: {
    name: "InsufficientShares",
    kind: "blocked",
    title: "You do not hold that many shares.",
    body: "Check the amount against your position. If the balance looks wrong, your entry may be archived rather than empty.",
  },
  26: {
    name: "NothingToClaim",
    kind: "absent",
    title: "There is nothing owed to you here.",
    body: "Either it has been claimed already, or this round did not owe you anything.",
  },
  27: {
    name: "WithdrawNotSettled",
    kind: "waiting",
    title: "Your queued exit is waiting for its round to finish.",
    body:
      "You are out of the vault already — the shares were burned when you queued it — and the payout " +
      "is fixed at the price that round ends on. Nothing can reduce it in the meantime, and there is " +
      "no deadline for collecting it.",
  },
  29: {
    name: "InsufficientAllowance",
    kind: "blocked",
    title: "This spender is not approved for that much.",
    body: "Share transfers made on your behalf need an allowance you set yourself. Raise it, or send the transfer directly.",
  },
  30: {
    name: "AllowlistForbidden",
    kind: "blocked",
    title: "This address is not on the bidder allowlist.",
    body:
      "While the allowlist is on, only approved addresses may bid. It has an expiry timestamp that " +
      "is set at deployment and has no setter — the operator cannot extend it without a reviewed " +
      "upgrade, and the date is readable on-chain.",
  },
  31: {
    name: "PremiumAboveMax",
    kind: "working",
    title: "The asking price is still above your limit.",
    body:
      "You set a maximum and the auction has not fallen to it. Nothing was spent. The price keeps " +
      "falling until the auction closes, so the same bid may succeed later in the window.",
  },
  32: {
    name: "BelowMinFill",
    kind: "blocked",
    title: "That fill is smaller than the round allows.",
    body: "A minimum fill keeps settlement arithmetic from being dominated by dust. Bid at least the minimum shown.",
  },
  34: {
    name: "InTheMoney",
    kind: "working",
    title: "The price has reached the strike, so the vault will not sell.",
    body:
      "An option that is already in the money has real value the auction's schedule does not price. " +
      "Selling it at the curve's price would hand that value away at the depositors' expense, so the " +
      "contract refuses the bid instead of filling it cheaply.",
  },
  35: {
    name: "ZeroPremium",
    kind: "blocked",
    title: "That fill is too small to pay any premium at this price.",
    body:
      "Rounded down, the premium would be zero — the vault would take on the obligation for nothing. " +
      "Bid a larger size, or wait: the same size pays a premium earlier in the auction.",
  },
  36: {
    name: "InsufficientBalance",
    kind: "blocked",
    title: "Your balance is not enough for this.",
    body: "Nothing was moved. Check the amount against what the wallet actually holds, and leave room for the network fee.",
  },
  37: {
    name: "AlreadyClaimed",
    kind: "absent",
    title: "You have already claimed this.",
    body: "The payment went out in an earlier transaction. Your wallet history has it.",
  },
  38: {
    name: "NoFill",
    kind: "absent",
    title: "You did not buy any of this round.",
    body: "There is no fill recorded for this address in this round, so there is nothing to claim against it.",
  },
  39: {
    name: "WrongOutcome",
    kind: "blocked",
    title: "That is the wrong kind of claim for how this round ended.",
    body:
      "A settled round pays a payout; an annulled one refunds the premium. The two are different " +
      "calls, and the round's outcome decides which one applies.",
  },
  40: {
    name: "InvalidAmount",
    kind: "blocked",
    title: "That amount is not usable.",
    body: "Amounts have to be positive and within what the contract can represent. Nothing was sent.",
  },
  41: {
    name: "InvalidParams",
    kind: "operator",
    title: "The parameters offered were refused by the contract.",
    body:
      "The vault validates its own configuration and rejected this set. Only the operator can reach " +
      "this — if you are not the operator and you are reading it, that is a bug on our side.",
  },
  44: {
    name: "ZeroShares",
    kind: "blocked",
    title: "That deposit would round down to zero shares.",
    body:
      "Every amount leaving the vault rounds in the vault's favour so that the accounting can never " +
      "come up short, and this one rounds to nothing. Deposit slightly more.",
  },
  51: {
    name: "MigrationOrder",
    kind: "operator",
    title: "Migrations have to run in order.",
    body: "An operator-only guard against skipping or repeating a version step. A depositor cannot reach it.",
  },
  52: {
    name: "NoPendingAdmin",
    kind: "operator",
    title: "There is no pending admin to accept the role.",
    body:
      "Admin transfer is two-step precisely so a typo cannot strand it. This is the second step " +
      "firing with no first step behind it.",
  },
  53: {
    name: "InvalidAddress",
    kind: "blocked",
    title: "That address is not one the contract will accept here.",
    body: "Nothing was sent. Check it against the address you meant to use.",
  },
  54: {
    name: "VaultWorthless",
    kind: "blocked",
    title: "The vault holds nothing, so a deposit has no price to convert at.",
    body:
      "Shares are priced against what the vault holds, and it holds nothing — there is no honest " +
      "exchange rate to mint at. This is a state the vault has to be repaired out of, not deposited into.",
  },
};

/**
 * The refusal's own words, or an honest fallback.
 *
 * An unknown code is still not allowed to surface as a number. The contract can grow codes this
 * build has never seen — a newer deployment against an older static page is exactly the situation
 * `output: "export"` creates — and the fallback has to stay useful: name what is known, state the
 * one thing that is always true, and point at the record instead of guessing.
 */
export function explain(code: number): ErrorText {
  const known = TABLE[code];
  if (known !== undefined) return known;
  return {
    name: `Error #${code}`,
    kind: "blocked",
    title: "The vault refused this, and this page does not recognise the reason.",
    body:
      `The contract returned error ${code}, which this build has no text for — most likely because ` +
      "the vault has been upgraded since this page was published. Nothing was taken and nothing " +
      "changed: a refused transaction on Stellar leaves no trace but the fee. The transaction in " +
      "your wallet history carries the code, and the contract's source names it.",
  };
}

/**
 * The same table, reached by the name the contract uses.
 *
 * `AssembledTransaction` hands back a `Result` whose error carries a *message* — "WrongPhase" —
 * not a number, so a lookup keyed only by code would miss every refusal that arrives through the
 * bindings' own error type. Built once from the table rather than maintained twice.
 */
const BY_NAME: ReadonlyMap<string, number> = new Map(
  Object.entries(TABLE).map(([code, text]) => [text.name, Number(code)]),
);

/**
 * Whatever the chain said, turned into something readable.
 *
 * Three shapes arrive here and all three are real: the bindings' own `{ message: "WrongPhase" }`,
 * a raw host error string containing `#2`, and something unrecognised. The last one still must not
 * surface as a stack trace — 08-OFFCHAIN §3 calls a bare "transaction failed" a defect.
 */
export function explainMessage(raw: string): ErrorText {
  const byName = BY_NAME.get(raw.trim());
  if (byName !== undefined) return explain(byName);

  for (const [name, code] of BY_NAME) {
    if (raw.includes(name)) return explain(code);
  }

  const code = /#(\d+)/.exec(raw)?.[1];
  if (code !== undefined) return explain(Number(code));

  return {
    name: "Refused",
    kind: "blocked",
    title: "The vault refused this.",
    body:
      "The reason did not come back in a form this page recognises, which usually means the failure " +
      "happened before the contract was reached — a network problem, or a wallet that declined. " +
      "Nothing was taken and nothing changed.",
  };
}

/** Every code this build can explain, for the test that keeps it in step with the bindings. */
export function knownCodes(): readonly number[] {
  return Object.keys(TABLE).map(Number);
}
