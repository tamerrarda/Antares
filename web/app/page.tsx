"use client";

import { ActionPanel } from "../components/ActionPanel.tsx";
import { AuctionCurve } from "../components/AuctionCurve.tsx";
import { useVault } from "../components/useVault.ts";
import { useWallet } from "../components/useWallet.ts";
import { deployment } from "../lib/deployment.ts";
import { amount, bps, duration, price, when, whenParts } from "../lib/format.ts";
import { faceOf, windowOpensAt } from "../lib/phase.ts";

/** "7-day · 3%", from the round's own parameters rather than from a name somebody typed. */
function vaultName(epochSeconds: bigint, otmBps: number): string {
  const s = Number(epochSeconds);
  const length =
    s >= 86400
      ? `${Math.round(s / 86400)}-day`
      : s >= 3600
        ? `${Math.round(s / 3600)}-hour`
        : `${Math.round(s / 60)}-minute`;
  return `${length} · ${otmBps / 100}%`;
}

export default function VaultPage() {
  const wallet = useWallet();
  const { epoch, config, position, error, now, reload } = useVault(wallet.address);
  const d = deployment();

  if (error !== null) {
    return (
      <article className="card">
        <h2>
          <span>The chain did not answer</span>
        </h2>
        <div className="body">
          <p className="sub" style={{ marginTop: 0 }}>
            Nothing is wrong with the vault — this page could not reach an RPC node to ask it. The contract is{" "}
            <code>{d.vaultId}</code> on {d.network} and is readable by anyone with a node.
          </p>
          <p className="sub">{error}</p>
        </div>
      </article>
    );
  }

  if (epoch === null || config === null) {
    return (
      <article className="card">
        <h2>
          <span>Reading the chain…</span>
        </h2>
      </article>
    );
  }

  const face = faceOf(epoch, now);
  const p = epoch.params;
  const opensAt = windowOpensAt(epoch);
  const untilOpen = opensAt === null ? null : duration(Number(opensAt) - now);

  return (
    <>
      {/* A fast-test profile is permanent (D-57) and a round rendered without saying so is being
          presented as demand evidence. The flag lives in the deployment record; the disclosure
          belongs on the page that shows the numbers. */}
      {d.economicallyMeaningless && (
        <div className="block" style={{ margin: "0 0 26px" }}>
          <b>This is a fast-test instance.</b>
          <p>
            Its rounds last {duration(Number(p.epoch_duration))} instead of a week, so its numbers are for
            exercising the machinery and can never be read as evidence that anyone wants these terms.
          </p>
        </div>
      )}

      <div className="head">
        <div>
          <div className="vault-pick">
            <h1>{vaultName(p.epoch_duration, p.strike_bps_otm)} vault</h1>
            <span className="tag">Round {epoch.round}</span>
          </div>
          <div className="phase" data-tone={face.tone}>
            <strong>{face.label}</strong>
            <span>{face.note}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="k">Price per share</span>
          <span className="big" style={{ fontSize: 22 }}>
            {(Number(epoch.last_pps) / 1e7).toFixed(5)}
          </span>
        </div>
      </div>

      <div className="grid">
        <section>
          {face.id === "auction" && (
            <article className="card">
              <h2>
                <span>The price is falling</span>
                <em>
                  linear · {p.premium_start_bps} → {p.premium_floor_bps} bps over{" "}
                  {duration(Number(p.auction_duration))}
                </em>
              </h2>
              <div className="body auction">
                <div>
                  <AuctionCurve epoch={epoch} now={now} />
                </div>
                <div className="now-box">
                  <span className="k">Asking now</span>
                  <span className="big">{bps(epoch.current_premium_bps)}</span>
                  <span className="sub">
                    of {amount(epoch.notional_offered)} XLM — {amount(epoch.notional_sold)} sold so far.
                  </span>
                  <div style={{ marginTop: 18 }}>
                    <span className="k">Auction ends in</span>
                    <span className="big clock">{duration(Number(epoch.auction_end) - now) ?? "closed"}</span>
                  </div>
                </div>
              </div>
            </article>
          )}

          {face.id === "active" && (
            <article className="card">
              <h2>
                <span>The round</span>
                <em>sold, and running to expiry</em>
              </h2>
              <div className="body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26 }}>
                <div>
                  <span className="k">Premium, already in the vault</span>
                  <span className="big">{amount(epoch.premium_collected)}</span>
                  <p className="sub">Yours whatever happens next.</p>
                </div>
                <div>
                  <span className="k">Expires in</span>
                  <span className="big clock">{duration(Number(epoch.expiry) - now) ?? "expired"}</span>
                  <p className="sub">{when(epoch.expiry)}. Nothing to do until then.</p>
                </div>
              </div>
            </article>
          )}

          {face.id === "delayed" && (
            <article className="card">
              <h2>
                <span>The price feed is not answering</span>
                <em>three endings, and the contract has already decided all of them</em>
              </h2>
              <div className="body">
                <p
                  className="sub"
                  style={{ marginTop: 0, fontSize: 12, color: "var(--dim)", maxWidth: "78ch" }}
                >
                  Settling reads the oracle and the oracle is not answering.{" "}
                  <b style={{ color: "var(--ink)" }}>Nothing is stuck and nothing is at risk.</b>
                </p>
                <ul className="endings">
                  <li>
                    <span className="n">1</span>
                    <div>
                      <b>It settles.</b> The price is read at expiry, not when the call lands, so a late close
                      cannot move it.
                    </div>
                  </li>
                  <li>
                    <span className="n">2</span>
                    <div>
                      <b>It is annulled and the buyer gets the premium back.</b> Only after{" "}
                      {duration(Number(p.oracle_dead_after))}, and only if the feed was demonstrably dead at
                      expiry. Your collateral is untouched.
                    </div>
                  </li>
                  <li>
                    <span className="n">3</span>
                    <div>
                      <b>It closes unresolved — you keep the premium, the buyer gets nothing.</b> The ending
                      past {duration(Number(p.unresolved_after))}.
                    </div>
                  </li>
                </ul>
              </div>
              <div className="clocks">
                <div>
                  <span className="k">Annulment becomes possible</span>
                  <span className="val">
                    {duration(Number(epoch.expiry) + Number(p.oracle_dead_after) - now) ?? "now"}
                  </span>
                  <span className="cap">
                    When option 2 <b style={{ color: "var(--dim)" }}>becomes possible</b>, not when it
                    happens.
                  </span>
                </div>
                <div data-guarantee>
                  <span className="k">Closes regardless — guaranteed</span>
                  <span className="val">
                    {duration(Number(epoch.expiry) + Number(p.unresolved_after) - now) ?? "now"}
                  </span>
                  <span className="cap">
                    Past this it closes with no oracle call at all — but somebody has to call it, and anyone
                    can.
                  </span>
                </div>
              </div>
            </article>
          )}

          {face.id === "window" && (
            <article className="card">
              <h2>
                <span>The window</span>
                <em>min_idle_gap · {duration(Number(p.min_idle_gap))}, guaranteed</em>
              </h2>
              <div className="body">
                <span className="k">{untilOpen === null ? "Open" : "Open for at least"}</span>
                <span className="big clock" style={{ fontSize: 44 }}>
                  {untilOpen ?? "right now"}
                </span>
                <p className="sub" style={{ maxWidth: "70ch" }}>
                  {untilOpen === null ? (
                    <>
                      <b>Nobody has opened the next round.</b> The guaranteed minimum elapsed already, so
                      anyone — including you — can open round {epoch.round + 1} at any moment. Until somebody
                      does, deposits and exits settle in the same transaction.
                    </>
                  ) : (
                    <>
                      <b>A floor, not a deadline.</b> {when(opensAt ?? 0n)} is the earliest anyone may open
                      the next round, not when this window closes.
                    </>
                  )}
                </p>
              </div>
              <div className="stats">
                <div>
                  <span className="k">Window opened</span>
                  <span className="val">{whenParts(epoch.last_finalize_time).day}</span>
                  <span className="cap">
                    {whenParts(epoch.last_finalize_time).time} — when round {epoch.round} finalised
                  </span>
                </div>
                <div>
                  <span className="k">Earliest close</span>
                  <span className="val">{whenParts(epoch.next_open_at).day}</span>
                  <span className="cap">
                    {whenParts(epoch.next_open_at).time} — the first moment open_epoch can succeed
                  </span>
                </div>
                <div>
                  <span className="k">Deposits</span>
                  <span className="val">Instant</span>
                  <span className="cap">no pending step while no round is running</span>
                </div>
                <div>
                  <span className="k">Exits</span>
                  <span className="val">Instant</span>
                  <span className="cap">request_withdraw pays out in the same transaction</span>
                </div>
              </div>
            </article>
          )}

          <article className="card">
            <h2>
              <span>This round</span>
              <em>snapshotted when it opened — a later parameter change cannot move it</em>
            </h2>
            <div className="stats">
              <div>
                <span className="k">Strike</span>
                <span className="val">{price(epoch.strike)}</span>
                <span className="cap">
                  {p.strike_bps_otm / 100}% above {price(epoch.open_twap)}, the price at open
                </span>
              </div>
              <div>
                <span className="k">Expiry</span>
                <span className="val">{whenParts(epoch.expiry).day}</span>
                <span className="cap">
                  {whenParts(epoch.expiry).time} — {duration(Number(epoch.expiry) - now) ?? "passed"}
                </span>
              </div>
              <div>
                <span className="k">Covered</span>
                <span className="val">{amount(epoch.notional_offered)}</span>
                <span className="cap">XLM — {amount(epoch.notional_sold)} sold</span>
              </div>
              <div>
                <span className="k">Premium collected</span>
                <span className="val">{amount(epoch.premium_collected)}</span>
                <span className="cap">XLM, paid up front by the buyer</span>
              </div>
            </div>
          </article>

          <article className="card">
            <h2>
              <span>What the operator can and cannot do</span>
            </h2>
            <div className="stats">
              <div>
                <span className="k">Paused</span>
                <span className="val">{config.paused ? "Yes" : "No"}</span>
                <span className="cap">and a paused vault can still be exited</span>
              </div>
              <div>
                <span className="k">Deposit cap</span>
                <span className="val">{amount(config.deposit_cap, 0)}</span>
                <span className="cap">XLM — {amount(config.deposit_headroom, 0)} left</span>
              </div>
              <div>
                <span className="k">Protocol fee</span>
                <span className="val">{bps(config.fee_bps)}</span>
                <span className="cap">
                  {config.fee_bps === 0 ? "nothing is taken" : "of the premium, never of your collateral"}
                </span>
              </div>
              <div>
                <span className="k">Allowlist</span>
                <span className="val">{config.allowlist_enabled ? "On" : "Off"}</span>
                <span className="cap">
                  expires {whenParts(config.allowlist_expires_at).day} — the timestamp is on-chain
                </span>
              </div>
            </div>
            <div className="body" style={{ borderTop: "1px solid var(--rule-soft)" }}>
              <a
                className="switch"
                style={{ textDecoration: "none", display: "inline-block" }}
                href="/operator/"
              >
                See everything the operator has ever done →
              </a>
            </div>
          </article>
        </section>

        <aside>
          <ActionPanel
            epoch={epoch}
            config={config}
            wallet={wallet}
            position={position}
            liveRound={face.id !== "window"}
            onDone={reload}
          />
          <div className="card" style={{ marginTop: 22 }}>
            <div className="contract">
              <span>Vault contract</span>
              <a
                href={`https://stellar.expert/explorer/testnet/contract/${d.vaultId}`}
                target="_blank"
                rel="noreferrer"
              >
                {d.vaultId.slice(0, 4)}…{d.vaultId.slice(-4)} ↗
              </a>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
