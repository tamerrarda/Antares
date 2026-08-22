"use client";

import type { ConfigView, EpochInfo, Position } from "@antares/bindings";
import { useState } from "react";

import { explain, type CallSite, type ErrorText } from "../lib/errors.ts";
import { amount, toUnits } from "../lib/format.ts";
import { writeClient } from "../lib/vault.ts";
import { Refusal } from "./Refusal.tsx";
import { useAction } from "./useAction.ts";
import type { WalletState } from "./useWallet.ts";

const SCALE = 10_000_000n;

/**
 * The transaction's return value, when it is an amount.
 *
 * `useAction` is deliberately untyped in its result — one hook serves calls that return shares, XLM,
 * a round outcome and nothing at all — so the amount is narrowed here rather than coerced. Forcing
 * it through `String()` is how a success message ends up reading "[object Object] shares".
 */
function asAmount(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null;
}

/** XLM as typed, to stroops. Refuses rather than rounding, because a silent round is a wrong amount. */
function toStroops(input: string): bigint | null {
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [whole = "0", frac = ""] = t.split(".");
  if (frac.length > 7) return null;
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(7, "0"));
}

export function ActionPanel({
  epoch,
  config,
  wallet,
  position,
  liveRound,
  onDone,
}: {
  epoch: EpochInfo;
  config: ConfigView;
  wallet: WalletState;
  position: Position | null;
  liveRound: boolean;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [value, setValue] = useState("");
  /**
   * `require_idle` defaults to ON, because DEPOSITOR §3 documents it as the safe default: it makes
   * the phase race harmless by refusing rather than queueing you at a price you have not seen.
   */
  const [requireIdle, setRequireIdle] = useState(true);
  const { busy, outcome, run, clear } = useAction(wallet);

  const stroops = toStroops(value);
  const connected = wallet.address !== null && !wallet.wrongNetwork;
  const env = { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] };

  /**
   * The contract's own guards, checked here first — not to replace them, but so an obvious mistake
   * costs a glance rather than a wallet prompt. The text is the contract's, from the same table, so
   * the two can never say different things about the same rule.
   */
  const localRefusal: ErrorText | null =
    stroops === null || stroops === 0n
      ? null
      : tab === "deposit"
        ? stroops < epoch.params.min_deposit
          ? explain(20)
          : stroops > config.deposit_headroom
            ? explain(21)
            : position !== null && position.pending_deposit > 0n
              ? explain(24)
              : null
        : position !== null && stroops > position.shares
          ? explain(25)
          : null;

  /**
   * The field is cleared on a tab change, and that is a correctness fix rather than tidiness.
   * "0.5" typed as XLM becomes "0.5" read as **shares** the moment the tab flips — the same digits
   * meaning a different quantity, with a different minimum and a different consequence. Carrying it
   * over is how somebody exits half a share believing they are depositing half an XLM.
   */
  function switchTo(next: "deposit" | "withdraw") {
    setTab(next);
    setValue("");
    clear();
  }

  async function fire(key: string, build: Promise<unknown>, site?: CallSite) {
    const result = await run(key, build, site);
    if (result?.status === "sent") {
      setValue("");
      onDone();
    }
  }

  const client = wallet.address === null ? null : writeClient(wallet.address, env);
  const who = wallet.address ?? "";

  // A button that says "connect wallet" and cannot be pressed is an instruction with nothing behind
  // it: the reader does what it says, nothing happens, and the page has told them a small lie. When
  // there is no wallet the primary action IS connecting, so that is what it does.
  const needsWallet = wallet.address === null;
  const cta = needsWallet
    ? wallet.connecting
      ? "Connecting…"
      : "Connect wallet"
    : wallet.wrongNetwork
      ? "Switch network first"
      : busy !== null
        ? "Waiting for your wallet…"
        : tab === "deposit"
          ? "Deposit"
          : requireIdle
            ? "Exit now, or not at all"
            : "Queue an exit";

  return (
    <div className="card">
      <div className="tabs">
        <button aria-selected={tab === "deposit"} type="button" onClick={() => switchTo("deposit")}>
          Deposit
        </button>
        <button aria-selected={tab === "withdraw"} type="button" onClick={() => switchTo("withdraw")}>
          Withdraw
        </button>
      </div>

      <div className="body">
        <span className="k">{tab === "deposit" ? "Amount" : "Shares"}</span>
        <div className="field">
          <input
            placeholder="0.00"
            inputMode="decimal"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              clear();
            }}
          />
          {tab === "withdraw" && position !== null && position.shares > 0n && (
            <button type="button" onClick={() => setValue(toUnits(position.shares).toFixed(7))}>
              Max
            </button>
          )}
          <span>{tab === "deposit" ? "XLM" : "shares"}</span>
        </div>

        <div className="meta">
          {tab === "deposit" ? (
            <>
              <span>min {amount(epoch.params.min_deposit, 0)} XLM</span>
              <span>{amount(config.deposit_headroom, 0)} XLM under the cap</span>
            </>
          ) : (
            <>
              <span>you hold {position === null ? "—" : amount(position.shares, 3)}</span>
              <span>1 share ≈ {(Number(epoch.last_pps) / 1e7).toFixed(5)} XLM</span>
            </>
          )}
        </div>

        {tab === "withdraw" && (
          <label
            style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={requireIdle}
              onChange={(e) => setRequireIdle(e.target.checked)}
              style={{ marginTop: 2, accentColor: "var(--ember)" }}
            />
            <span className="note" style={{ margin: 0 }}>
              <b>Only if the window is still open.</b> Leaves you nothing to think about: if a round opens in
              the same moment, the call refuses and nothing changes. Turn it off to queue an exit at whatever
              price the running round ends on.
            </span>
          </label>
        )}

        <button
          className="cta"
          type="button"
          disabled={
            needsWallet
              ? wallet.connecting
              : !connected || busy !== null || stroops === null || stroops === 0n || localRefusal !== null
          }
          onClick={() => {
            // With no wallet the primary action IS connecting. A button that reads "connect wallet"
            // and cannot be pressed is an instruction with nothing behind it.
            if (needsWallet) {
              void wallet.connect();
              return;
            }
            if (client === null || stroops === null) return;
            void (tab === "deposit"
              ? fire("deposit", client.deposit({ from: who, amount: stroops }))
              : fire(
                  "withdraw",
                  client.request_withdraw({ from: who, shares: stroops, require_idle: requireIdle }),
                  "withdraw",
                ));
          }}
        >
          {cta}
        </button>

        <p className="note">
          {tab === "deposit" ? (
            liveRound ? (
              <>
                <b>A round is live, so this waits as a pending deposit</b> and converts at the price the round
                ends on. You can take it back before then.
              </>
            ) : (
              <>
                <b>No round is running, so this becomes shares in the same transaction.</b> Nothing is left
                pending and nothing has to be collected later.
              </>
            )
          ) : liveRound ? (
            <>
              <b>A round is running, so your shares are burned now and paid later</b> — at the price this
              round ends on, which nothing between now and then can reduce.
            </>
          ) : (
            <>
              <b>No round is running, so this pays out in the same transaction.</b> If a round opens in the
              same moment you press it, the call refuses rather than surprising you — that is what the box
              above is for.
            </>
          )}
        </p>
      </div>

      {/* The wallet's own failures had nowhere to appear: `useWallet` set `error` and no component
          read it, so "no wallet answered" was a state the page reached and never showed. */}
      {wallet.error !== null && (
        <Refusal
          text={{
            name: "Wallet",
            kind: "blocked",
            title: "No wallet is available to sign with.",
            body: wallet.error,
          }}
        />
      )}
      {localRefusal !== null && <Refusal text={localRefusal} />}
      {outcome?.status === "refused" && <Refusal text={outcome.refusal} signed={outcome.signed} />}
      {outcome?.status === "sent" && (
        <div className="refusal">
          <b>
            Done
            {asAmount(outcome.value) === null
              ? "."
              : ` — ${amount(asAmount(outcome.value) ?? 0n, 3)} ${tab === "deposit" ? "shares" : "XLM"}.`}
          </b>
          <p>The transaction is on the chain and this page has been re-read from it.</p>
        </div>
      )}

      {/*
        The forgotten pending deposit is the highest-priority nag in the product: a depositor who
        misses a window has money earning nothing AND is blocked from depositing again, and it
        repeats every round. The time shown is a FLOOR, never a deadline — `next_open_at` is the
        earliest the window can close, not when it will.
      */}
      {position !== null && position.pending_deposit > 0n && (
        <div className="nag">
          <b>You have {amount(position.pending_deposit)} XLM waiting</b>
          <p>
            It becomes shares the moment the current round ends — you do not need to be here for it, but you
            cannot deposit again until you collect it.
          </p>
          <button
            type="button"
            disabled={!connected || busy !== null}
            onClick={() => client !== null && void fire("redeem", client.redeem_shares({ from: who }))}
          >
            {busy === "redeem" ? "Waiting…" : `Collect ${amount(position.pending_deposit)} XLM as shares`}
          </button>
          <button
            type="button"
            style={{
              background: "transparent",
              color: "var(--ember)",
              border: "1px solid rgba(255,107,61,0.4)",
              marginLeft: 8,
            }}
            disabled={!connected || busy !== null}
            onClick={() =>
              client !== null && void fire("cancel", client.cancel_pending_deposit({ from: who }))
            }
          >
            {busy === "cancel" ? "Waiting…" : "Take it back"}
          </button>
        </div>
      )}

      {/*
        A queued exit leaves no trace in the wallet — `request_withdraw` burns the shares
        immediately — so nothing reminds the user they are owed anything. It gets the same unmissable
        treatment as the pending deposit for exactly that reason.
      */}
      {position !== null && position.withdraw_claimable > 0n && (
        <div className="nag">
          <b>{amount(position.withdraw_claimable)} XLM is yours to collect</b>
          <p>
            From a queued exit whose round has finalised. The amount is fixed and nothing can reduce it; there
            is no deadline for taking it.
          </p>
          <button
            type="button"
            disabled={!connected || busy !== null}
            onClick={() =>
              client !== null && void fire("claim", client.claim_withdraw({ from: who }), "collect")
            }
          >
            {busy === "claim" ? "Waiting…" : `Collect ${amount(position.withdraw_claimable)} XLM`}
          </button>
        </div>
      )}

      {position !== null && (
        <div className="pos">
          <span className="k">Your position</span>
          <div className="pos-row">
            <span>Shares</span>
            <span className="val">{amount(position.shares, 3)}</span>
          </div>
          <div className="pos-row">
            <span>Worth today</span>
            <span className="val">{amount((position.shares * epoch.last_pps) / SCALE)} XLM</span>
          </div>
          <div className="pos-row">
            <span>Queued exit</span>
            <span className={position.withdraw_claimable > 0n ? "val hot" : "val"}>
              {position.withdraw_claimable > 0n ? `${amount(position.withdraw_claimable)} XLM` : "—"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
