"use client";

import Link from "next/link";

import { ActionPanel } from "../components/ActionPanel.tsx";
import { useInstance } from "../components/useInstance.ts";
import { VaultPicker } from "../components/VaultPicker.tsx";
import { BidPanel } from "../components/BidPanel.tsx";
import { ChainDown } from "../components/ChainDown.tsx";
import { AuctionCurve } from "../components/AuctionCurve.tsx";
import { Calendar } from "../components/Calendar.tsx";
import { Permissionless } from "../components/Permissionless.tsx";
import { Simulator } from "../components/Simulator.tsx";
import { TheRecord } from "../components/TheRecord.tsx";
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
  const { all, current, select } = useInstance();
  const suffix = current.tokenSuffix;
  const { epoch, config, position, error, now, reload } = useVault(wallet.address, suffix);
  const d = deployment(suffix);

  if (error !== null) {
    return <ChainDown detail={error} onRetry={reload} />;
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
          {/*
            Under the heading rather than in the site header: the choice is what this page is about,
            not where you are in the site, and it changes every figure below it. It renders nothing
            while one vault exists, so the page reads exactly as it did before the set grew.
          */}
          <VaultPicker all={all} current={current} onSelect={select} />
        </div>
        <div className="spot">
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
              {/*
                The buy side sits under the curve it is priced from, for the reason `Permissionless`
                gives about its own buttons: state and the action that changes it belong in one
                block. It exists only in this face — outside the auction window a bid cannot happen
                at all, and a control that is always refused teaches people to ignore controls.
              */}
              <BidPanel epoch={epoch} wallet={wallet} onDone={reload} suffix={suffix} />
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
                {/* Only the "floor, not a deadline" case earns a sentence. The open case had one too —
                    "deposits and exits are instant" — which the page header says above and the two
                    stats below say with more precision. Three statements of one fact in one card. */}
                {untilOpen !== null && (
                  <p className="sub" style={{ maxWidth: "70ch" }}>
                    <b>A floor, not a deadline.</b> {when(opensAt ?? 0n)} is the earliest anyone may open, not
                    when this closes.
                  </p>
                )}
              </div>
              <div className="stats">
                {/* Both of these are derived from `last_finalize_time`, which a vault that has
                    never closed a round reports as **0** — and epoch zero renders as a real date,
                    "1 Jan, 02:00". A fresh vault was printing 1970 as the moment its window opened
                    and as the earliest anyone could act. Neither timestamp exists yet, so neither
                    is shown; the two below are true from the first block. */}
                {epoch.round > 0 && (
                  <>
                    <div>
                      <span className="k">Window opened</span>
                      <span className="val">{whenParts(epoch.last_finalize_time).day}</span>
                      <span className="cap">
                        {whenParts(epoch.last_finalize_time).time} · round {epoch.round} closed
                      </span>
                    </div>
                    <div>
                      <span className="k">Earliest close</span>
                      <span className="val">{whenParts(epoch.next_open_at).day}</span>
                      <span className="cap">
                        {whenParts(epoch.next_open_at).time} · earliest anyone may open
                      </span>
                    </div>
                  </>
                )}
                <div>
                  <span className="k">Deposits</span>
                  <span className="val">Instant</span>
                  <span className="cap">no pending step</span>
                </div>
                <div>
                  <span className="k">Exits</span>
                  <span className="val">Instant</span>
                  <span className="cap">paid in the same transaction</span>
                </div>
              </div>

              {/* The two calls, in the card that describes the state they change. The window card
                  said a round could be opened while the button that opens it sat two cards below;
                  a reader had to hold one claim in mind to recognise the control. Outside this face
                  they keep their own card, because `close_round` matters most when a round is live. */}
              <Permissionless
                bare
                wallet={wallet}
                bountyAddress={wallet.address ?? config.admin}
                onDone={reload}
                suffix={suffix}
              />
            </article>
          )}

          {/* Not rendered before the first round has ever opened: every field would be a zero,
              and `expiry` would print the epoch-zero timestamp as a real date — 1 Jan, passed. */}
          {epoch.round > 0 && (
            <article className="card">
              <h2>
                <span>This round</span>
                <em>snapshotted at open</em>
              </h2>
              <div className="stats">
                <div>
                  <span className="k">Strike</span>
                  <span className="val">{price(epoch.strike)}</span>
                  <span className="cap">
                    {p.strike_bps_otm / 100}% above {price(epoch.open_twap)} at open
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
                  <span className="cap">XLM, paid up front</span>
                </div>
              </div>
            </article>
          )}

          {/* Only while a round is live: outside one there is no strike to reason about, and running
              the table against the PREVIOUS round's strike would describe an option nobody holds. */}
          {face.id !== "window" && <Simulator epoch={epoch} />}

          {/* The anti-APY card. It reads seven days of events, which is a few seconds — so it is
              placed after the round's own numbers and renders itself when it is ready rather than
              holding the page. */}
          <TheRecord />

          {/* Before the operator card on purpose: what anyone can do comes above what only the
              operator can, because that is the order the trust claim runs in. In the idle face this
              is not rendered here — it is inside the window card, beside the state it acts on. */}
          {face.id !== "window" && (
            <Permissionless
              wallet={wallet}
              bountyAddress={wallet.address ?? config.admin}
              onDone={reload}
              suffix={suffix}
            />
          )}

          <article className="card">
            <h2>
              <span>What the operator can and cannot do</span>
            </h2>
            <div className="stats">
              <div>
                <span className="k">Paused</span>
                <span className="val">{config.paused ? "Yes" : "No"}</span>
                <span className="cap">exits work either way</span>
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
                  {config.fee_bps === 0 ? "nothing taken" : "of premium, never collateral"}
                </span>
              </div>
              {/* The fifth balance somebody can forget, and the last one with no surface anywhere.
                  It is owed to the fee recipient rather than to a depositor, so it lives beside the
                  fee that produces it — and it is shown at zero too, because "nothing is owed" is
                  the fact a reader wants and an absent row does not give them. */}
              <div>
                <span className="k">Fee accrued</span>
                <span className={config.fee_claimable > 0n ? "val hot" : "val"}>
                  {amount(config.fee_claimable)}
                </span>
                <span className="cap">
                  {config.fee_claimable > 0n ? "XLM owed, unclaimed" : "XLM — nothing owed"}
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
              <Link
                className="switch"
                style={{ textDecoration: "none", display: "inline-block" }}
                href="/operator/"
              >
                See everything the operator has ever done →
              </Link>
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
            suffix={suffix}
          />
          <Calendar epoch={epoch} face={face.id} />

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
