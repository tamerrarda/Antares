"use client";

import { useEvents } from "./useEvents.ts";
import { amount } from "../lib/format.ts";
import { foldRounds, OUTCOME_LABEL, type Outcome } from "../lib/rounds.ts";

/**
 * What stands where a competitor puts an APY.
 *
 * D-35 forbids an annualised figure and this is the substitute it names: the raw record. Ribbon puts
 * "Total Projected Yield (APY)" here and Lusty puts "MAX APR 95.62%"; both are extrapolations from a
 * handful of rounds. What this shows instead is what actually happened, and it is deliberately the
 * same card whether the news is good or bad — a record that only appears when it flatters is not a
 * record.
 *
 * The premium figure is what was **kept**, not what was collected: an annulled round hands its
 * premium back, and counting it would credit depositors with money that left the vault.
 */
export function TheRecord() {
  const { page } = useEvents();
  if (page === null) return null;

  const rounds = foldRounds(page.events);
  if (rounds.length === 0) return null;

  const closed = rounds.filter((r) => r.outcome !== "running");
  const count = (o: Outcome) => closed.filter((r) => r.outcome === o).length;
  const refunded = closed.reduce((s, r) => s + (r.refunded ?? 0n), 0n);
  const kept = closed.reduce((s, r) => s + r.premium, 0n) - refunded;
  const days = ((page.latestLedger - page.oldestLedger) * 5) / 86400;

  return (
    <article className="card">
      <h2>
        <span>The record</span>
        <em>no yield figure is shown, and there is a reason</em>
      </h2>
      <div className="body">
        {/* Oldest on the left, so the strip reads the way time does. */}
        <div className="record">
          {[...closed].reverse().map((r) => (
            <i
              key={r.round}
              data-o={r.outcome === "settled" ? "settled" : r.outcome === "voided" ? "void" : "lapsed"}
              title={`Round ${r.round} — ${OUTCOME_LABEL[r.outcome]}`}
            />
          ))}
        </div>
        <div className="legend">
          <span>
            <s style={{ background: "rgba(244,241,234,0.28)" }} /> {count("settled")} sold and settled
          </span>
          <span>
            <s style={{ background: "rgba(244,241,234,0.06)" }} /> {count("lapsed")} had no buyer
          </span>
          <span>
            <s
              style={{
                background:
                  "repeating-linear-gradient(45deg,rgba(244,241,234,0.14) 0 3px,transparent 3px 6px)",
              }}
            />{" "}
            {count("voided")} annulled, premium refunded
          </span>
          {count("unresolved") > 0 && (
            <span>
              <s style={{ background: "rgba(244,241,234,0.06)" }} /> {count("unresolved")} closed unresolved
            </span>
          )}
        </div>
        <details className="more">
          <summary>Why there is no APY here</summary>
          <p>
            An annualised yield from {count("settled")} sold {count("settled") === 1 ? "round" : "rounds"} is
            a number invented from a sample too small to carry it. What is shown instead is what actually
            happened, plus the raw premium each round paid — every one of them a transaction you can open in
            the explorer.
          </p>
          <p>
            These are the rounds inside the node&apos;s {days.toFixed(0)}-day memory. Older ones happened and
            are still on the chain; they are out of reach from here, which is distance rather than absence.
          </p>
        </details>
      </div>
      <div className="stats">
        <div>
          <span className="k">Premium kept</span>
          <span className="val">{amount(kept)}</span>
          <span className="cap">
            XLM — raw, unannualised
            {refunded > 0n && `, after ${amount(refunded)} was refunded on annulled rounds`}
          </span>
        </div>
        <div>
          <span className="k">Rounds with a buyer</span>
          <span className="val">
            {closed.length - count("lapsed")} of {closed.length}
          </span>
          <span className="cap">counterparty discovery is the experiment</span>
        </div>
        <div>
          <span className="k">Every round</span>
          <span className="val">
            <a href="/rounds/" style={{ color: "var(--ember)", textDecoration: "none" }}>
              Round history →
            </a>
          </span>
          <span className="cap">each row links to the transaction that ended it</span>
        </div>
      </div>
    </article>
  );
}
