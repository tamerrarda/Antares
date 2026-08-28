"use client";

import { useFleet } from "../../components/useFleet.ts";
import { useWallet } from "../../components/useWallet.ts";
import { amount, duration, when } from "../../lib/format.ts";
import { faceOf, windowOpensAt } from "../../lib/phase.ts";
import { summarise, waitingWorth } from "../../lib/positions.ts";
import { vaultName } from "../../lib/vault-name.ts";

/**
 * `max-content` on the status column, not a fixed width.
 *
 * A `.pill` is `white-space: nowrap` and the longest label — "Sold — the round is running" —
 * overruns 210 px, so on the deployed page it printed as `RUNNINGafter round 2 closes`: the badge
 * ran straight into the next cell with no gap. Measured in the live DOM, not inferred. A wider
 * fixed number would move the collision rather than remove it, because the label set can grow; a
 * track sized to its own content cannot collide at all. The narrow layout is unaffected — it
 * already stacks every cell and wraps the pill (see globals.css).
 */
const COLS = "200px 1fr 1fr max-content 1fr";

export default function PositionsPage() {
  const wallet = useWallet();
  const { rows, loading } = useFleet(wallet.address);
  const now = Math.floor(Date.now() / 1000);

  /**
   * A pending deposit is money in the vault, and this page counted it as nothing.
   *
   * Until it was measured on the deployed build the total read `position.shares` alone — so an
   * address whose 2 999 XLM was waiting for a live round to end saw **"0.0 XLM in 0 of 1 vault"**
   * and a row that said "no position". It is the common case rather than an edge: every deposit
   * made while a round is running lands there, which is most of an epoch. The arithmetic moved to
   * `lib/positions.ts` so it can be tested without a browser or a round.
   */
  const { total, waiting, vaults } = summarise(rows);

  return (
    <>
      <div className="head">
        <div>
          <h1>My positions</h1>
          <div className="phase" data-tone="quiet" style={{ marginTop: 14 }}>
            <span style={{ maxWidth: "78ch" }}>Where your money is, and when you can next move it.</span>
          </div>
        </div>
      </div>

      {wallet.address === null ? (
        <article className="card">
          <h2>
            <span>Connect a wallet to see your positions</span>
          </h2>
          <div className="body">
            <p className="sub" style={{ marginTop: 0, maxWidth: "82ch" }}>
              The vaults are readable by anyone. An address only says which hold yours.
            </p>
          </div>
        </article>
      ) : (
        <article className="card">
          <h2>
            <span>Total</span>
          </h2>
          <div className="body">
            <div className="total">
              <span className="big" style={{ fontSize: 44 }}>
                {loading ? "…" : amount(total)}
                <small> XLM</small>
              </span>
              <span className="sub" style={{ margin: 0 }}>
                in {vaults} of {rows.length} {rows.length === 1 ? "vault" : "vaults"}
              </span>
            </div>
            {/* No profit-and-loss curve, no allocation ring, no ranking of the vaults against each
                other. 08-OFFCHAIN §3: without this page the interface becomes a trading terminal,
                which is the opposite of the product. */}
            <p className="sub" style={{ maxWidth: "82ch" }}>
              Worth follows price per share, which moves when a round settles and at no other time.
              {waiting > 0n && (
                <>
                  {" "}
                  <b>{amount(waiting)} XLM of this is still waiting</b> for a round to end: it is not shares
                  yet, so it takes none of that round&rsquo;s result, and it can be taken back whole until it
                  converts.
                </>
              )}
            </p>
          </div>
        </article>
      )}

      <article className="card">
        <h2>
          <span>{rows.length === 1 ? "The deployed vault" : `Your ${rows.length} vaults`}</span>
          <em>the same wasm, one parameter set each</em>
        </h2>
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: COLS }}>
            <span>Vault</span>
            <span className="num">Your shares</span>
            <span className="num">Worth today</span>
            <span>What it is doing</span>
            <span>Next window</span>
          </div>
          {rows.map((r) => {
            const face = r.epoch === null ? null : faceOf(r.epoch, now);
            const opensAt = r.epoch === null ? null : windowOpensAt(r.epoch);
            const untilOpen = opensAt === null ? null : duration(Number(opensAt) - now);
            const pps = r.epoch === null ? 0n : r.epoch.last_pps;
            const worth = r.position === null ? null : (r.position.shares * pps) / 10_000_000n;
            const waitingHere = waitingWorth(r);
            return (
              <div className="tr" key={r.instance.vaultId} style={{ gridTemplateColumns: COLS }}>
                <span data-l="Vault">
                  <b>{vaultName(r.instance.epochDuration, r.instance.strikeBpsOtm)}</b>{" "}
                  <span className="muted">· {r.instance.tokenSuffix.replace("-", "instance ")}</span>
                </span>
                <span data-l="Your shares" className="num">
                  {r.position === null || r.position.shares === 0n ? (
                    <span className="muted">—</span>
                  ) : (
                    amount(r.position.shares, 3)
                  )}
                </span>
                <span data-l="Worth today" className="num">
                  {worth !== null && worth > 0n ? `${amount(worth)} XLM` : null}
                  {waitingHere > 0n ? (
                    <span className={worth !== null && worth > 0n ? "muted" : undefined}>
                      {worth !== null && worth > 0n ? " + " : ""}
                      {amount(waitingHere)} XLM waiting
                    </span>
                  ) : null}
                  {(worth === null || worth === 0n) && waitingHere === 0n ? (
                    <span className="muted">no position</span>
                  ) : null}
                </span>
                <span data-l="What it is doing">
                  {r.error !== null ? (
                    <span className="muted">did not answer</span>
                  ) : face === null ? (
                    <span className="muted">reading…</span>
                  ) : (
                    <span className="pill" data-o={face.id === "window" ? "claimable" : undefined}>
                      {face.label}
                    </span>
                  )}
                </span>
                <span data-l="Next window" className="muted">
                  {r.epoch === null
                    ? "—"
                    : untilOpen === null
                      ? face?.id === "window"
                        ? "open now"
                        : `after round ${r.epoch.round} closes`
                      : `${untilOpen} — ${when(opensAt ?? 0n)}`}
                </span>
              </div>
            );
          })}
        </div>
      </article>

      {rows.length < 5 && (
        <article className="card">
          <h2>
            <span>Four vaults are planned and not yet deployed</span>
          </h2>
          <div className="body">
            <p className="sub" style={{ marginTop: 0, maxWidth: "82ch" }}>
              Phase 2 runs five instances at once, differing only in how long money is committed and how far
              the price can rise before you stop keeping the gain. This build reads the deployment record, and
              the record lists {rows.length}. The others will appear here the day they exist — drawing them
              now would be showing you a plan and calling it a product.
            </p>
          </div>
        </article>
      )}
    </>
  );
}
