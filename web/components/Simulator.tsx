"use client";

import type { EpochInfo } from "@antares/bindings";
import { useState } from "react";

import { amount, price, toUnits } from "../lib/format.ts";
import { payoff } from "../lib/payoff.ts";

const MOVES = [-10, 0, 3, 6, 10] as const;
const COLS = "1fr 1fr 1fr 1fr";

/**
 * What D-35 puts in place of the yield figure it forbids.
 *
 * *"A payoff simulator — if XLM closes below the strike you keep X; above it, your upside caps at
 * Y."* The shape is the argument: above the strike the **Worth** column stops moving, and that flat
 * line is the covered call. Nothing is liquidated, no position is closed, and the difference is
 * settled in cash — so the depositor keeps every XLM they own and pays the gap.
 *
 * The arithmetic is `lib/payoff.ts` and it is unit-tested there, including the property this table
 * exists to show and the contract's rounding direction. Nothing is computed inline here.
 */
export function Simulator({ epoch }: { epoch: EpochInfo }) {
  const [value, setValue] = useState("1000");

  const typed = Number(value.replace(",", "."));
  const amountStroops = Number.isFinite(typed) && typed > 0 ? BigInt(Math.round(typed * 1e7)) : 0n;
  const premiumBps =
    epoch.current_premium_bps > 0 ? epoch.current_premium_bps : epoch.params.premium_floor_bps;
  const { credited, rows } = payoff(amountStroops, epoch.open_twap, epoch.strike, premiumBps, [...MOVES]);

  return (
    <article className="card">
      <h2>
        <span>Your cap this round is {price(epoch.strike)}</span>
        <em>settled in cash — you keep every XLM you own</em>
      </h2>
      <div className="body" style={{ paddingBottom: 14 }}>
        <p style={{ margin: "0 0 18px", fontSize: 14, lineHeight: 1.55, maxWidth: "70ch" }}>
          Below {price(epoch.strike)} you keep the premium and every share. Above it your gain stops there.
        </p>
        <label className="k" htmlFor="sim-amount">
          If you held
        </label>
        <div className="field" style={{ maxWidth: 320 }}>
          <input
            id="sim-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <span>XLM</span>
        </div>
      </div>

      <div className="tbl">
        <div className="tr th" style={{ gridTemplateColumns: COLS }}>
          <span>XLM closes at</span>
          <span className="num">Your XLM after</span>
          <span className="num">Worth</span>
          <span className="num">vs simply holding XLM</span>
        </div>
        {rows.map((r) => (
          <div className="tr" key={r.movePct} style={{ gridTemplateColumns: COLS }}>
            <span data-l="XLM closes at">
              {price(r.close)}{" "}
              <span className="muted">
                {r.movePct === 3 ? "the strike" : `${r.movePct > 0 ? "+" : ""}${r.movePct}%`}
              </span>
            </span>
            <span data-l="Your XLM after" className={r.capped ? "num" : "num muted"}>
              {amount(r.held, 1)}
            </span>
            <span data-l="Worth" className="num">
              <b style={r.capped ? { color: "var(--ember)" } : undefined}>${toUnits(r.worth).toFixed(2)}</b>
            </span>
            <span data-l="vs simply holding XLM" className="num muted">
              {r.difference >= 0n ? "+" : "−"}${Math.abs(toUnits(r.difference)).toFixed(2)}
            </span>
          </div>
        ))}
      </div>

      <div className="body" style={{ borderTop: "1px solid var(--rule-soft)" }}>
        <p className="sub" style={{ margin: 0, maxWidth: "88ch" }}>
          Credited <b>{amount(credited)} XLM</b> when the option sells. Above the strike the <b>Worth</b>{" "}
          column stops moving — that flat line is the cap.
        </p>
        <details className="more">
          <summary>What the cap actually costs</summary>
          <p>
            Below the strike the premium is the whole story. Above it you keep every XLM you own and the vault
            settles the difference in cash — nothing is liquidated and no position is closed. The last column
            is what that trade is worth against simply holding XLM, and it turns negative exactly where the
            cap begins.
          </p>
        </details>
      </div>
    </article>
  );
}
