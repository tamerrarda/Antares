"use client";

import { isUnrecognised, type AdminEvent } from "@antares/common/events";

import { ChainDown } from "../../components/ChainDown.tsx";
import { useEvents } from "../../components/useEvents.ts";
import { useVault } from "../../components/useVault.ts";
import { deployment } from "../../lib/deployment.ts";
import { amount, bps, when } from "../../lib/format.ts";

const COLS = "150px 190px 1fr 130px";

/** What the call did, in words, from its own payload. */
function describe(e: AdminEvent): string {
  if (isUnrecognised(e)) {
    const fields =
      typeof e.data === "object" && e.data !== null ? Object.keys(e.data).join(", ") : String(e.data);
    return `this build has no decoder for it — payload fields: ${fields || "(none)"}`;
  }
  switch (e.name) {
    case "initialized":
      return `deployed with its full configuration — fee ${bps(e.feeBps)}, allowlist ${e.allowlistEnabled ? "on" : "off"}, cap ${amount(e.depositCap, 0)} XLM`;
    case "paused":
      return `deposits and new rounds stopped, by ${e.by.slice(0, 4)}…${e.by.slice(-4)}`;
    case "unpaused":
      return `deposits and new rounds resumed, by ${e.by.slice(0, 4)}…${e.by.slice(-4)}`;
    case "allowed_changed":
      return `${e.bidder.slice(0, 4)}…${e.bidder.slice(-4)} ${e.allowed ? "added to" : "removed from"} the bidder allowlist`;
    case "upgraded":
      return `contract code replaced — wasm ${e.wasmHash.slice(0, 8)}…${e.wasmHash.slice(-8)}, from version ${e.appVersion}`;
    case "position_restored":
      return `${e.user.slice(0, 4)}…${e.user.slice(-4)}'s archived position brought back — permissionless, anyone may call it`;
    default:
      return "";
  }
}

const CANNOT = [
  [
    "Take your collateral.",
    "No sweep, no emergency withdrawal, no recipient field but the protocol fee — which ships at zero.",
  ],
  [
    "Trap it by pausing.",
    "close_round, redeem_shares and request_withdraw are unpausable. Pause stops money coming in, not going out.",
  ],
  [
    "Extend the allowlist, or repoint the price feed.",
    "No setter exists for allowlist_expires_at, asset or oracle — each costs a reviewed upgrade that appears in the table above.",
  ],
  [
    "Set a fee worth having.",
    "set_fee_bps is capped at 2,000 — 20% of the premium, never of your collateral.",
  ],
  [
    "Push the settlement fallback out of reach.",
    "unresolved_after is bounded above on-chain as well as below.",
  ],
  [
    "Lose the admin role to a typo.",
    "Transfer is two-step: the new address has to accept before it takes effect.",
  ],
] as const;

export default function OperatorPage() {
  const { page, error, reload } = useEvents();
  const { config } = useVault(null);
  const d = deployment();

  const rows = page === null ? [] : [...page.admin].reverse();
  const unknown = rows.filter((r) => isUnrecognised(r.decoded)).length;

  return (
    <>
      <div className="head">
        <div>
          <h1>Operator log</h1>
          <div className="phase" data-tone="quiet" style={{ marginTop: 14 }}>
            <span style={{ maxWidth: "78ch" }}>
              Every administrative call this vault has emitted inside the RPC&apos;s window. Nothing on this
              page is filtered by us, and nothing is written by us.
            </span>
          </div>
        </div>
      </div>

      {config !== null && (
        <article className="card">
          <h2>
            <span>Who holds the admin key</span>
            <em>and what that key is worth</em>
          </h2>
          <div className="stats">
            <div>
              <span className="k">Admin</span>
              <span className="val">
                {config.admin.slice(0, 4)}…{config.admin.slice(-4)}
              </span>
              <span className="cap">a single testnet key — on mainnet, a timelocked multisig</span>
            </div>
            <div>
              <span className="k">Actions in this window</span>
              <span className="val">{rows.length}</span>
              <span className="cap">all of them below</span>
            </div>
            <div>
              <span className="k">Allowlist expires</span>
              <span className="val">{when(config.allowlist_expires_at)}</span>
              <span className="cap">on-chain, and there is no setter to move it</span>
            </div>
            <div>
              <span className="k">Protocol fee</span>
              <span className="val">{bps(config.fee_bps)}</span>
              <span className="cap">capped at 2,000 by on-chain validation</span>
            </div>
          </div>
        </article>
      )}

      <article className="card">
        <h2>
          <span>What the operator has done</span>
          <em>{error === null ? "newest first · each row is a transaction" : "the chain did not answer"}</em>
        </h2>
        {error !== null ? (
          <div className="body">
            <ChainDown detail={error} onRetry={reload} />
          </div>
        ) : page === null ? (
          <div className="body">
            <p className="sub" style={{ marginTop: 0 }}>
              Reading seven days of events…
            </p>
          </div>
        ) : (
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <span>When</span>
              <span>Call</span>
              <span>What changed</span>
              <span className="num">Transaction</span>
            </div>
            {rows.map((r) => (
              <div
                className="tr"
                key={`${r.txHash}-${r.ledger}-${r.decoded.name}`}
                style={{ gridTemplateColumns: COLS }}
              >
                <span data-l="When" className="muted">
                  {r.at === null ? `ledger ${r.ledger}` : when(Math.floor(r.at.getTime() / 1000))}
                </span>
                <span data-l="Call">
                  <span className="pill" data-o={isUnrecognised(r.decoded) ? undefined : "settled"}>
                    {r.decoded.name}
                  </span>
                </span>
                <span data-l="What changed">{describe(r.decoded)}</span>
                <span data-l="Transaction" className="num">
                  <a
                    href={`https://stellar.expert/explorer/${d.network}/tx/${r.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.txHash.slice(0, 4)}…{r.txHash.slice(-4)} ↗
                  </a>
                </span>
              </div>
            ))}
          </div>
        )}
      </article>

      <article className="card">
        <h2>
          <span>What the operator cannot do</span>
          <em>the part that is enforced rather than promised</em>
        </h2>
        <div className="body">
          <ul className="endings">
            {CANNOT.map(([head, tail]) => (
              <li key={head}>
                <span className="n">—</span>
                <div>
                  <b>{head}</b> {tail}
                </div>
              </li>
            ))}
          </ul>
          <details className="more">
            <summary>The one thing an admin can do</summary>
            <p>
              Ship a bad upgrade — nothing on-chain prevents it. That is stated rather than argued away: it is
              why v1 is upgradeable and unaudited at the same time, why the key moves to a timelocked multisig
              before mainnet, and why every upgrade appears in this table with its wasm hash.
            </p>
          </details>
        </div>
      </article>

      {page !== null && (unknown > 0 || page.tokenEvents > 0) && (
        <article className="card">
          <h2>
            <span>What this table leaves out, and what it does not</span>
          </h2>
          <div className="body">
            <p className="sub" style={{ marginTop: 0, maxWidth: "82ch" }}>
              {page.tokenEvents} share mints and burns are counted rather than listed — every deposit and
              every exit makes one, and listing them would bury {rows.length} admin calls under them. They are
              not administrative and none of them is the operator doing anything.
            </p>
            {unknown > 0 && (
              <p className="sub" style={{ maxWidth: "82ch" }}>
                {unknown} row{unknown === 1 ? " is" : "s are"} shown with raw fields because this build has no
                verified decoder for that call. It is still listed: an operator log that omitted an action for
                being unfamiliar would be worse than one that admits it cannot read it.
              </p>
            )}
          </div>
        </article>
      )}
    </>
  );
}
