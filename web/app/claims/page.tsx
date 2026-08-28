"use client";

import { useState } from "react";

import { ChainDown } from "../../components/ChainDown.tsx";
import { Refusal } from "../../components/Refusal.tsx";
import { useClaims } from "../../components/useClaims.ts";
import { useInstance } from "../../components/useInstance.ts";
import { VaultPicker } from "../../components/VaultPicker.tsx";
import { useEvents } from "../../components/useEvents.ts";
import { useWallet } from "../../components/useWallet.ts";
import { claim } from "../../lib/claim-tx.ts";
import { claimState, totalUnclaimed, type ClaimRow } from "../../lib/claims.ts";
import { deployment } from "../../lib/deployment.ts";
import { amount } from "../../lib/format.ts";
import { foldRounds, OUTCOME_LABEL, type Outcome } from "../../lib/rounds.ts";
import type { TxOutcome } from "../../lib/tx.ts";

const COLS = "58px 130px 1fr 1fr 190px";

export default function ClaimsPage() {
  const wallet = useWallet();
  const { all, current, select } = useInstance();
  const suffix = current.tokenSuffix;
  const { data, loading, error, reload } = useClaims(wallet.address, suffix);
  const { page } = useEvents(suffix);
  const d = deployment(suffix);

  const [busy, setBusy] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<TxOutcome<bigint> | null>(null);

  // Outcomes come from events and only reach back seven days. Rows older than that still show —
  // `bidder_position` is a view and does not care — they just cannot be labelled.
  const outcomes = new Map<number, Outcome>(
    page === null ? [] : foldRounds(page.events).map((r) => [r.round, r.outcome]),
  );

  async function onClaim(row: ClaimRow) {
    if (wallet.address === null) return;
    setBusy(row.round);
    setOutcome(null);
    try {
      const wk = await import("../../lib/wallet.ts");
      const address = wallet.address;
      const result = await claim(
        row.round,
        address,
        {
          address,
          signTransaction: async (xdr, opts) => {
            const o = opts as { networkPassphrase?: string } | undefined;
            const signed = await wk.sign(xdr, o?.networkPassphrase ?? "", address);
            return { signedTxXdr: signed, signerAddress: address };
          },
        },
        { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] },
        suffix,
      );
      setOutcome(result);
      if (result.status === "sent") reload();
    } finally {
      setBusy(null);
    }
  }

  const rows = data?.rows ?? [];
  const unclaimed = totalUnclaimed(rows);

  return (
    <>
      <div className="head">
        <div>
          <h1>Claims</h1>
          <div className="phase" data-tone="quiet" style={{ marginTop: 14 }}>
            <span style={{ maxWidth: "78ch" }}>
              What this vault owes you as a buyer — payouts from settled rounds and refunds from annulled
              ones.
            </span>
          </div>
          <VaultPicker all={all} current={current} onSelect={select} />
        </div>
      </div>

      {wallet.address === null ? (
        <article className="card">
          <h2>
            <span>Connect the address that bid</span>
          </h2>
          <div className="body">
            <p className="sub" style={{ marginTop: 0, maxWidth: "82ch" }}>
              Claims are per address, and this page reads the chain for the one you connect. Nothing is stored
              here and nothing is remembered about you between visits.
            </p>
          </div>
        </article>
      ) : (
        <>
          <article className="card">
            <h2>
              <span>Unclaimed</span>
              <em>shown whether the round is recent or not</em>
            </h2>
            <div className="body">
              <div className="total">
                <span className="big" style={{ fontSize: 44 }}>
                  {loading ? "…" : amount(unclaimed)}
                  <small> XLM</small>
                </span>
                <span className="sub" style={{ margin: 0 }}>
                  across {rows.filter((r) => claimState(r) === "claimable").length} rounds · nothing here
                  expires
                </span>
              </div>
              <p className="sub" style={{ maxWidth: "82ch" }}>
                There is no deadline on any of these and no way for them to be swept. A claim is a transaction
                you send, and it works the same a year later as on the day the round closed.
              </p>
            </div>
          </article>

          {outcome?.status === "refused" && <Refusal text={outcome.refusal} signed={outcome.signed} />}
          {outcome?.status === "sent" && (
            <div className="refusal" style={{ margin: "0 0 22px" }}>
              <b>Claimed — {amount(outcome.value)} XLM.</b>
              <p>The transaction is on the chain and this page has been re-read from it.</p>
            </div>
          )}

          <article className="card">
            <h2>
              <span>Your fills</span>
              <em>
                {error !== null
                  ? "the chain did not answer"
                  : loading
                    ? "reading every round…"
                    : data === null
                      ? ""
                      : `rounds ${data.from}–${data.to}, read one by one from the contract`}
              </em>
            </h2>
            {error !== null ? (
              <div className="body">
                <ChainDown detail={error} onRetry={reload} suffix={suffix} />
              </div>
            ) : rows.length === 0 && !loading ? (
              <div className="body">
                <p className="sub" style={{ marginTop: 0, maxWidth: "82ch" }}>
                  This address has not filled any round in the range read. That is a fact about this address,
                  not about the window: <code>bidder_position</code> is a view, so it answers for any round
                  the contract still holds.
                </p>
              </div>
            ) : (
              <div className="tbl">
                <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                  <span>Round</span>
                  <span>Outcome</span>
                  <span className="num">You filled</span>
                  <span className="num">Owed to you</span>
                  <span className="num" />
                </div>
                {rows.map((r) => {
                  const state = claimState(r);
                  const label = outcomes.get(r.round);
                  return (
                    <div className="tr" key={r.round} style={{ gridTemplateColumns: COLS }}>
                      <span data-l="Round">
                        <b>{r.round}</b>
                      </span>
                      <span data-l="Outcome">
                        {label === undefined ? (
                          <span className="muted">beyond the event window</span>
                        ) : (
                          <span className="pill" data-o={label === "settled" ? "settled" : undefined}>
                            {OUTCOME_LABEL[label]}
                          </span>
                        )}
                      </span>
                      <span data-l="You filled" className="num muted">
                        {amount(r.notional)} XLM
                      </span>
                      <span data-l="Owed to you" className="num">
                        {state === "claimable" ? (
                          <b>{amount(r.claimable)} XLM</b>
                        ) : (
                          <span className="muted">
                            {state === "claimed" ? "collected" : "nothing was owed"}
                          </span>
                        )}
                      </span>
                      <span data-l="" className="num">
                        {state === "claimable" ? (
                          <>
                            <button
                              className="mini"
                              type="button"
                              disabled={busy !== null || wallet.wrongNetwork}
                              onClick={() => void onClaim(r)}
                            >
                              {busy === r.round ? "Waiting…" : "Claim"}
                            </button>
                            {r.archived && (
                              <div className="muted" style={{ marginTop: 7 }}>
                                archived — restored by the claim itself
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </article>

          <article className="card">
            <h2>
              <span>How this page finds your fills</span>
            </h2>
            <div className="body">
              <p
                className="sub"
                style={{ marginTop: 0, maxWidth: "82ch", fontSize: 12, color: "var(--dim)" }}
              >
                Not from events. Soroban RPC keeps about <b style={{ color: "var(--ink)" }}>seven days</b> of
                them, and a page built on events would show a bidder who looked a round late an empty table —
                which for money owed is not a gap in a feature.
              </p>
              <ul className="endings">
                <li>
                  <span className="n">1</span>
                  <div>
                    <b>Every round is asked directly.</b> <code>bidder_position(round, you)</code> is a view,
                    so it answers for any round the contract still holds
                    {data !== null && ` — ${data.to - data.from + 1} of them were read for this page`}.
                  </div>
                </li>
                <li>
                  <span className="n">2</span>
                  <div>
                    <b>Claiming is never the problem.</b> A claim is a transaction, so an archived entry is
                    restored inside its own footprint. No extra step is asked of you.
                  </div>
                </li>
                <li>
                  <span className="n">3</span>
                  <div>
                    <b>The right call is chosen for you.</b> A settled round pays out and an annulled one
                    refunds; pressing Claim tries the first and falls through to the second on the
                    contract&apos;s own say-so, so you never have to know which applies.
                  </div>
                </li>
              </ul>
              {data?.truncated === true && (
                <p className="sub" style={{ maxWidth: "82ch" }}>
                  Rounds before {data.from} were not read — the scan is capped so a page load stays bounded.
                  They are not lost, and the evidence index the keeper writes is what will reach them.
                </p>
              )}
            </div>
          </article>

          <article className="card">
            <div className="contract">
              <span>Vault contract</span>
              <a
                href={`https://stellar.expert/explorer/${d.network}/contract/${d.vaultId}`}
                target="_blank"
                rel="noreferrer"
              >
                {d.vaultId.slice(0, 4)}…{d.vaultId.slice(-4)} ↗
              </a>
            </div>
          </article>
        </>
      )}
    </>
  );
}
