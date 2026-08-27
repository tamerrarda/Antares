"use client";

import type { EpochInfo } from "@antares/bindings";
import { useEffect, useState } from "react";

import { parseAmount } from "../lib/amount.ts";
import { amount, bps, price } from "../lib/format.ts";
import { previewBid, type Preview } from "../lib/preview.ts";
import { writeClient } from "../lib/vault.ts";
import { Refusal } from "./Refusal.tsx";
import { useAction } from "./useAction.ts";
import type { WalletState } from "./useWallet.ts";

const BPS = 10_000n;

/**
 * The buy side, on the page where the auction already is.
 *
 * This app is built for depositors and BIDDER §2 says as much — pricing an option is not a thing to
 * do by clicking, and anybody automating it should start from the reference bidder. That argument
 * justifies not building a *pricing* surface. It does not justify making the one irreversible thing
 * a counterparty does reachable only from a shell, when the project's own stop condition is written
 * in terms of whether an independent counterparty ever fills.
 *
 * So: no chart, no greeks, no suggestion about what to pay. A size, a ceiling, the contract's own
 * answer about what that would do, and the same refusal vocabulary every other control on this site
 * uses. It renders only inside the auction face, because that is the roughly 1 % of an epoch in
 * which a bid is a thing that can happen at all.
 */
export function BidPanel({
  epoch,
  wallet,
  onDone,
}: {
  epoch: EpochInfo;
  wallet: WalletState;
  onDone: () => void;
}) {
  const [size, setSize] = useState("");
  const [ceiling, setCeiling] = useState(String(epoch.current_premium_bps));
  const [sim, setSim] = useState<Preview<bigint> | null>(null);
  const { busy, outcome, run, clear } = useAction(wallet);

  const address = wallet.address;
  const connected = address !== null && !wallet.wrongNetwork;
  const parsed = parseAmount(size);
  const notional = parsed !== null && "stroops" in parsed ? parsed.stroops : null;
  const maxBps = /^\d+$/.test(ceiling.trim()) ? Number(ceiling.trim()) : null;

  /**
   * The simulation is the whole panel. Nine refusals can end a bid and three of them turn on
   * numbers this card does not show, so rather than reimplement the contract's rules in the browser
   * and get one of them subtly wrong, the contract is asked. It signs nothing and costs nothing.
   */
  useEffect(() => {
    if (address === null || notional === null || notional <= 0n || maxBps === null) {
      setSim(null);
      return;
    }
    let live = true;
    const id = setTimeout(() => {
      void previewBid(address, notional, maxBps, {
        NETWORK: process.env["NEXT_PUBLIC_NETWORK"],
      }).then((r) => {
        if (live) setSim(r);
      });
    }, 350);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [address, notional, maxBps]);

  const wouldFill = sim?.kind === "would-succeed" ? sim.value : null;
  // Two numbers, because the bidder pays one and escrows the other. The ceiling is what leaves the
  // account; the curve's rate is what is kept, and the difference comes back in the same
  // transaction. Showing only one of them is how a bidder is surprised by their own balance.
  const atCeiling = wouldFill !== null && maxBps !== null ? (wouldFill * BigInt(maxBps)) / BPS : 0n;
  const atCurve = wouldFill !== null ? (wouldFill * BigInt(epoch.current_premium_bps)) / BPS : 0n;

  async function fire() {
    if (address === null || notional === null || maxBps === null) return;
    const client = writeClient(address, { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] });
    const result = await run(
      "bid",
      client.bid({ bidder: address, notional, max_premium_bps: maxBps }),
      "bid",
    );
    if (result?.status === "sent") {
      setSize("");
      setSim(null);
      onDone();
    }
  }

  return (
    <div className="anyone" style={{ marginTop: 22 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: "0.95rem" }}>Buy this option</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        You pay a premium now and receive the amount by which XLM finishes above {price(epoch.strike)},
        against the notional you take. If it finishes at or below, you receive nothing and the premium is
        gone. That is the whole trade.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "10px 0" }}>
        <label style={{ flex: "1 1 160px" }}>
          <span className="k">Notional, XLM</span>
          <input
            value={size}
            onChange={(e) => {
              setSize(e.target.value);
              clear();
            }}
            inputMode="decimal"
            placeholder={amount(epoch.notional_offered - epoch.notional_sold)}
          />
        </label>
        <label style={{ flex: "0 1 130px" }}>
          <span className="k">Your ceiling, bps</span>
          <input
            value={ceiling}
            onChange={(e) => {
              setCeiling(e.target.value);
              clear();
            }}
            inputMode="numeric"
          />
        </label>
      </div>

      <p className="sub">
        The curve is asking {bps(epoch.current_premium_bps)} and is still falling. Your ceiling is a slippage
        guard and it is mandatory: above it the bid refuses rather than fills, so no price you did not name
        can be charged to you.
      </p>

      {parsed !== null && "problem" in parsed && <p className="sub">{parsed.problem}</p>}

      {connected && notional !== null && notional > 0n && maxBps !== null && sim === null && (
        <p className="sub">Asking the chain…</p>
      )}

      {sim?.kind === "would-succeed" && wouldFill !== null && (
        <p className="sub">
          <b>Would fill {amount(wouldFill)} XLM</b> of notional
          {notional !== null && wouldFill < notional
            ? " — less than you asked, because that is all that is left"
            : ""}
          . At the curve&rsquo;s rate the premium is about {amount(atCurve)} XLM; {amount(atCeiling)} XLM
          leaves your account against your ceiling and the difference returns in the same transaction.
        </p>
      )}

      {sim?.kind === "would-refuse" && (
        <p className="sub">
          <b>Would refuse.</b> {sim.refusal.title}
          <details className="more">
            <summary>Why</summary>
            <p>{sim.refusal.body}</p>
          </details>
        </p>
      )}

      <button
        className={`ghost${wouldFill !== null ? " hot" : ""}`}
        type="button"
        disabled={!connected || busy !== null || wouldFill === null}
        onClick={() => void fire()}
      >
        {busy === "bid" ? "Waiting…" : "Buy the option"}
      </button>

      {!connected && <p className="sub">Connect a wallet to see what your bid would do.</p>}

      {outcome?.status === "refused" && <Refusal text={outcome.refusal} signed={outcome.signed} />}
      {outcome?.status === "sent" && (
        <p className="sub">
          <b>Filled.</b> The premium has left your account and the position is recorded against this round.
          Nothing more is required of you until it settles — then Claims collects the payout, if there is one.
        </p>
      )}
    </div>
  );
}
