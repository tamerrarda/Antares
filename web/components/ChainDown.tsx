"use client";

import { deployment } from "../lib/deployment.ts";

/**
 * The read-side equivalent of a bare "transaction failed".
 *
 * Found by breaking `fetch` and watching: the page showed its heading and then the browser's own
 * words, **"Failed to fetch"**, as the whole explanation. 08-OFFCHAIN §3 calls a raw code or a bare
 * failure a defect on the write side, and nothing about that argument is different when the failure
 * is a read.
 *
 * Two things it adds beyond wording. A **retry**, because the only remedy before this was reloading
 * the page — and the failure is usually a moment of network, not a broken build. And the raw message
 * kept, but folded: it is what somebody debugging needs and the last thing somebody reading needs.
 */
export function ChainDown({
  detail,
  onRetry,
  suffix,
}: {
  detail: string;
  onRetry?: () => void;
  /** The vault the failed page was reading — the one worth pointing at when it cannot render it. */
  suffix?: string;
}) {
  const d = deployment(suffix);
  return (
    <article className="card">
      <h2>
        <span>The chain did not answer</span>
      </h2>
      <div className="body">
        <p className="sub" style={{ marginTop: 0, maxWidth: "82ch", fontSize: 12, color: "var(--dim)" }}>
          <b style={{ color: "var(--ink)" }}>Nothing is wrong with the vault.</b> This page could not reach a
          node to ask it. Every number here is read from Stellar by your own browser — there is no server of
          ours in between, which is why an outage on your side looks exactly like this.
        </p>
        <p className="sub" style={{ maxWidth: "82ch" }}>
          Nothing you hold depends on this page being able to load. The contract is readable by anyone with a
          node, and it is{" "}
          <a
            href={`https://stellar.expert/explorer/${d.network}/contract/${d.vaultId}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--ember)" }}
          >
            {d.vaultId.slice(0, 4)}…{d.vaultId.slice(-4)} on {d.network} ↗
          </a>
          .
        </p>
        {onRetry !== undefined && (
          <button className="ghost" type="button" onClick={onRetry} style={{ marginTop: 6 }}>
            Try again
          </button>
        )}
        <details className="more">
          <summary>What the browser reported</summary>
          <p>
            <code>{detail}</code>
          </p>
        </details>
      </div>
    </article>
  );
}
