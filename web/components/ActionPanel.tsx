"use client";

import type { ConfigView, EpochInfo, Position } from "@antares/bindings";
import { useState } from "react";

import { amount, toUnits } from "../lib/format.ts";
import { explain, type ErrorText } from "../lib/errors.ts";
import { submit, type TxOutcome } from "../lib/tx.ts";
import { writeClient } from "../lib/vault.ts";
import { Refusal } from "./Refusal.tsx";
import type { WalletState } from "./useWallet.ts";

const SCALE = 10_000_000n;

/** XLM as typed, to stroops. Refuses rather than rounding, because a silent round is a wrong amount. */
function toStroops(input: string): bigint | null {
  if (!/^\d*\.?\d*$/.test(input.trim()) || input.trim() === "" || input.trim() === ".") return null;
  const [whole = "0", frac = ""] = input.trim().split(".");
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
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TxOutcome<bigint> | null>(null);

  const stroops = toStroops(value);
  const ready = wallet.address !== null && !wallet.wrongNetwork;

  /**
   * The same guards the contract enforces, checked here first.
   *
   * Not to replace them — the contract is the authority and its refusal is the one that counts —
   * but so an obvious mistake costs a glance rather than a wallet prompt and a simulation. The text
   * shown is the contract's own, from the same table, so the two can never say different things
   * about the same rule.
   */
  const localRefusal: ErrorText | null =
    stroops === null || stroops === 0n
      ? null
      : stroops < epoch.params.min_deposit
        ? explain(20)
        : stroops > config.deposit_headroom
          ? explain(21)
          : position !== null && position.pending_deposit > 0n && liveRound
            ? explain(24)
            : null;

  async function onDeposit() {
    if (wallet.address === null || stroops === null || stroops <= 0n) return;
    setBusy(true);
    setOutcome(null);
    try {
      const wk = await import("../lib/wallet.ts");
      const client = writeClient(wallet.address, { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] });
      const result = await submit<bigint>(client.deposit({ from: wallet.address, amount: stroops }), {
        address: wallet.address,
        signTransaction: async (xdr, opts) => {
          const o = opts as { networkPassphrase?: string } | undefined;
          const signed = await wk.sign(xdr, o?.networkPassphrase ?? "", wallet.address ?? "");
          return { signedTxXdr: signed, signerAddress: wallet.address ?? "" };
        },
      });
      setOutcome(result);
      if (result.status === "sent") {
        setValue("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  const label =
    wallet.address === null
      ? "Connect wallet to deposit"
      : wallet.wrongNetwork
        ? "Switch network first"
        : busy
          ? "Waiting for your wallet…"
          : "Deposit";

  return (
    <div className="card">
      <div className="tabs">
        <button aria-selected="true" type="button">
          Deposit
        </button>
        <button aria-selected="false" type="button">
          Withdraw
        </button>
      </div>
      <div className="body">
        <span className="k">Amount</span>
        <div className="field">
          <input
            placeholder="0.00"
            inputMode="decimal"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setOutcome(null);
            }}
          />
          <span>XLM</span>
        </div>
        <div className="meta">
          <span>min {amount(epoch.params.min_deposit, 0)} XLM</span>
          <span>{amount(config.deposit_headroom, 0)} XLM under the cap</span>
        </div>

        <button
          className="cta"
          type="button"
          disabled={!ready || busy || stroops === null || stroops === 0n || localRefusal !== null}
          onClick={() => void onDeposit()}
        >
          {label}
        </button>

        <p className="note">
          {liveRound ? (
            <>
              <b>A round is live, so this waits as a pending deposit</b> and converts at the price the round
              ends on. You can take it back before then.
            </>
          ) : (
            <>
              <b>No round is running, so this becomes shares in the same transaction.</b> Nothing is left
              pending and nothing has to be collected later.
            </>
          )}
        </p>
      </div>

      {localRefusal !== null && <Refusal text={localRefusal} />}
      {outcome?.status === "refused" && <Refusal text={outcome.refusal} signed={outcome.signed} />}
      {outcome?.status === "sent" && (
        <div className="refusal">
          <b>Done — {toUnits(outcome.value).toLocaleString("en-US", { maximumFractionDigits: 7 })} shares.</b>
          <p>
            The transaction is on the chain and this page has been re-read from it.{" "}
            {outcome.hash !== "" && (
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${outcome.hash}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--ember)" }}
              >
                Open it in the explorer ↗
              </a>
            )}
          </p>
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
            <span>Pending deposit</span>
            <span className={position.pending_deposit > 0n ? "val hot" : "val"}>
              {position.pending_deposit > 0n ? `${amount(position.pending_deposit)} XLM` : "—"}
            </span>
          </div>
          <div className="pos-row">
            <span>Claimable exit</span>
            <span className={position.withdraw_claimable > 0n ? "val hot" : "val"}>
              {position.withdraw_claimable > 0n ? `${amount(position.withdraw_claimable)} XLM` : "—"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
