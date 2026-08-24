"use client";

import Link from "next/link";

import { ChainDown } from "../../components/ChainDown.tsx";
import { useEvents } from "../../components/useEvents.ts";
import { deployment } from "../../lib/deployment.ts";
import { amount, when } from "../../lib/format.ts";
import { foldRounds, OUTCOME_LABEL, type Outcome } from "../../lib/rounds.ts";

const COLS = "58px 150px 128px 1fr 1fr 1fr 120px";

function Pill({ outcome }: { outcome: Outcome }) {
  // Neutral for every ending. LAPSED and VOIDED are outcomes, not errors, and colouring them red
  // teaches a depositor to fear the case that happens most often.
  return (
    <span className="pill" data-o={outcome === "settled" ? "settled" : undefined}>
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

export default function RoundsPage() {
  const { page, error, reload } = useEvents();
  const d = deployment();

  if (error !== null) {
    return <ChainDown detail={error} onRetry={reload} />;
  }

  if (page === null) {
    return (
      <article className="card">
        <h2>
          <span>Reading seven days of events…</span>
          <em>a dozen round-trips; the window is scanned forward, not sampled</em>
        </h2>
      </article>
    );
  }

  const rounds = foldRounds(page.events);
  const days = ((page.latestLedger - page.oldestLedger) * 5) / 86400;
  const settled = rounds.filter((r) => r.outcome === "settled").length;
  const lapsed = rounds.filter((r) => r.outcome === "lapsed").length;
  // Premium KEPT, not premium collected. An annulled round hands its premium back, so counting it
  // would credit depositors with money that left the vault — the exact overstatement this page
  // exists to avoid. The two numbers are shown separately rather than netted silently.
  const refunded = rounds.reduce((sum, r) => sum + (r.refunded ?? 0n), 0n);
  const kept = rounds.reduce((sum, r) => sum + r.premium, 0n) - refunded;

  return (
    <>
      <div className="head">
        <div>
          <h1>Rounds</h1>
          <div className="phase" data-tone="quiet" style={{ marginTop: 14 }}>
            <span style={{ maxWidth: "78ch" }}>
              Every round this vault has run inside the RPC&apos;s memory, folded from the events it emitted.
              Each row keeps the transaction that ended it.
            </span>
          </div>
        </div>
      </div>

      <article className="card">
        <h2>
          <span>Round history</span>
          <em>
            {rounds.length} rounds · the last {days.toFixed(1)} days
          </em>
        </h2>
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <span>Round</span>
            <span>Opened</span>
            <span>Outcome</span>
            <span className="num">Premium</span>
            <span className="num">Paid to the buyer</span>
            <span className="num">Price per share after</span>
            <span className="num">Transaction</span>
          </div>
          {rounds.map((r) => (
            <div className="tr" key={r.round} style={{ gridTemplateColumns: COLS }}>
              <span data-l="Round">
                <b>{r.round}</b>
              </span>
              <span data-l="Opened" className="muted">
                {r.openedAt === null ? "before this window" : when(r.openedAt)}
              </span>
              <span data-l="Outcome">
                <Pill outcome={r.outcome} />
              </span>
              <span data-l="Premium" className="num">
                {r.premium > 0n ? `+${amount(r.premium)}` : <span className="muted">—</span>}
                {r.refunded !== null && r.refunded > 0n && <span className="muted"> → refunded</span>}
              </span>
              <span data-l="Paid to the buyer" className="num">
                {r.payout === null ? (
                  <span className="muted">—</span>
                ) : r.payout === 0n ? (
                  "0"
                ) : (
                  `−${amount(r.payout)}`
                )}
              </span>
              <span data-l="Price per share after" className="num">
                {r.ppsAfter === null ? (
                  <span className="muted">—</span>
                ) : (
                  (Number(r.ppsAfter) / 1e7).toFixed(5)
                )}
              </span>
              <span data-l="Transaction" className="num">
                {r.terminalTx === null ? (
                  <span className="muted">—</span>
                ) : (
                  <a
                    href={`https://stellar.expert/explorer/${d.network}/tx/${r.terminalTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.terminalTx.slice(0, 4)}…{r.terminalTx.slice(-4)} ↗
                  </a>
                )}
              </span>
            </div>
          ))}
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
              {rounds.length - lapsed} of {rounds.length}
            </span>
            <span className="cap">counterparty discovery is the experiment</span>
          </div>
          <div>
            <span className="k">Settled</span>
            <span className="val">{settled}</span>
            <span className="cap">the rest lapsed, were annulled, or closed unresolved</span>
          </div>
        </div>
      </article>

      <article className="card">
        <h2>
          <span>What this page can and cannot see</span>
        </h2>
        <div className="body">
          <p className="sub" style={{ marginTop: 0, maxWidth: "82ch" }}>
            Soroban RPC keeps <b>{Math.round(page.retentionLedgers)} ledgers</b> of events — about{" "}
            {days.toFixed(0)} days. Rounds older than that are not gone, they are out of reach from a node:
            they happened, and the transactions are still on the chain. A page that showed nothing for them
            would be reporting absence where there is only distance.
          </p>
          {page.undecoded.length > 0 && (
            <p className="sub" style={{ maxWidth: "82ch" }}>
              {page.undecoded.length} kinds of event in this window are not shown here because they are not
              about rounds — token transfers, and the administrative calls that belong on the{" "}
              <Link href="/operator/" style={{ color: "var(--ember)" }}>
                operator log
              </Link>
              . Nothing is filtered for being unflattering.
            </p>
          )}
        </div>
      </article>
    </>
  );
}
