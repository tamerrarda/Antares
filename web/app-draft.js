/*
 * Antares — Vault page draft, all seven faces.
 *
 * The hard part of this page is not any one screen: it is that the contract's state machine gives
 * it seven, and 08-OFFCHAIN's UX rules are almost entirely about the differences between them.
 * So the page renders from a state map and carries a switcher, and the copy for each state is
 * written here rather than in markup — the wording IS the design in a product whose whole claim
 * is that it explains itself.
 *
 * Mock numbers, one consistent timeline at instance A's real parameters (D-57):
 *   round 11  15 Aug 08:15 → sold at 92 bps → settled 22 Aug, below strike
 *   round 12  22 Aug 08:15 → auction to 09:00 → NO BUYER → lapsed, window opens 09:00
 *   round 13  22 Aug 13:04 → sold at 78 bps → expires 29 Aug 13:04
 */

const P = {
  epochDays: 7, otmBps: 300, auctionSec: 2700,
  startBps: 450, floorBps: 40, fairBps: 75.6,
  idleGapH: 4, oracleDeadH: 12, unresolvedH: 21,
  notional: 84320, cap: 100000,
};

let W = "off";

const more = (label, html) => `<details class="more"><summary>${label}</summary>${html}</details>`;

const fmt = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

// ---- building blocks ---------------------------------------------------------------------------
const card = (title, note, inner) =>
  `<article class="card"><h2><span>${title}</span>${note ? `<em>${note}</em>` : ""}</h2>${inner}</article>`;

const stats = (rows) =>
  `<div class="stats">${rows
    .map(([k, v, u, hot]) => `<div><span class="k">${k}</span><v${hot ? ' class="hot"' : ""}>${v}</v><u>${u}</u></div>`)
    .join("")}</div>`;

/* Where the price sits against the strike. The number pair states the fact; the bar is what makes
   "capped, not lost" legible without reading a sentence — and that distinction is the one a
   covered-call product most often fails to communicate. */
const gauge = (openPx, strikePx, nowPx, label) => {
  const lo = openPx * 0.96, hi = openPx * 1.1;
  const at = (v) => ((v - lo) / (hi - lo)) * 100;
  const here = Math.min(88, Math.max(12, at(nowPx)));
  return `<div class="gauge">
    <div class="track">
      <span class="fill" ${nowPx > strikePx ? "data-over" : ""} style="width:${at(nowPx).toFixed(1)}%"></span>
      <span class="mark" style="left:${at(strikePx).toFixed(1)}%"><b>strike $${strikePx.toFixed(4)}</b></span>
      <span class="here" style="left:${here.toFixed(1)}%">${label}</span>
    </div>
    <div class="ends"><span>$${lo.toFixed(4)}</span><span>$${hi.toFixed(4)}</span></div>
  </div>`;
};

/* The record card is the same in every state, and that is the point: it is what stands where a
   competitor puts an APY, so it cannot be something the page shows only when the news is good. */
const recordCard = card(
  "The record",
  "",
  `<div class="body">
     <div class="record">
       <i data-o="lapsed"></i><i data-o="settled"></i><i data-o="lapsed"></i><i data-o="lapsed"></i>
       <i data-o="void"></i><i data-o="settled"></i><i data-o="lapsed"></i><i data-o="lapsed"></i>
       <i data-o="settled"></i><i data-o="lapsed"></i>
     </div>
     <div class="legend">
       <span><s style="background:rgba(244,241,234,0.28)"></s> 3 sold and settled</span>
       <span><s style="background:rgba(244,241,234,0.06)"></s> 6 had no buyer</span>
       <span><s style="background:repeating-linear-gradient(45deg,rgba(244,241,234,0.14) 0 3px,transparent 3px 6px)"></s> 1 annulled, premium refunded</span>
     </div>
     <p class="sub" style="margin-top:16px">
       </p>
     ${more(
       "Why there is no APY here",
       `<p>An annualised yield from three sold rounds is a number invented from a sample too small to
           carry it. What is shown instead is what actually happened, plus the raw premium each round
           paid — every one of them a transaction you can open in the explorer.</p>`,
     )}
     
   </div>` +
    stats([
      ["Premium, last 10 rounds", "1,681.8", "XLM — total, raw, unannualised"],
      ["Price per share", "1.01220", "started at 1.00000"],
      ["Rounds with a buyer", "3 of 10", "counterparty discovery is the experiment"],
    ]),
);

const configCard = card(
  "What the operator can and cannot do",
  "",
  stats([
    ["Paused", "No", "and a paused vault can still be exited"],
    ["Deposit cap", "100,000", `XLM — ${fmt(P.cap - P.notional)} left`],
    ["Protocol fee", "0 bps", "nothing is taken"],
    ["Allowlist", "On", "expires 30 Sep 2026 — the timestamp is on-chain"],
  ]) +
    `<div class="body" style="border-top:1px solid var(--rule-soft)">
       <a class="switch" style="text-decoration:none;display:inline-block" href="#operator">
         See everything the operator has ever done →
       </a>
     </div>`,
);

/* `close_round` and `open_epoch` are the trust model made operable. Three public documents tell the
   user these calls are theirs, and the keeper argument rests on them — so they are a card on the
   page with their bounty next to them, never a developer affordance. */
const anyoneCard = (close, open) =>
  card(
    "Nobody operates this vault",
    "these two calls are open to anyone, including you",
    `<div class="body">
       <div class="anyone">
         <button class="ghost${close.hot ? " hot" : ""}" ${close.on ? "" : "disabled"}>Close the round</button>
         <p class="sub">${close.why}</p>
       </div>
       <div class="anyone">
         <button class="ghost${open.hot ? " hot" : ""}" ${open.on ? "" : "disabled"}>Open the next round</button>
         <p class="sub">${open.why}</p>
       </div>
     </div>`,
  );

// ---- the aside, in its two shapes ---------------------------------------------------------------
/*
 * `08-OFFCHAIN §3`: "An archived position must never render as an empty one." Soroban can evict a
 * persistent entry, and `position()` is a read-only view that does not restore it — so a dormant
 * depositor's balance can come back unreadable. Rendering that as "0 shares" tells someone their
 * money is gone, which is the one thing DEPOSITOR §5 promises cannot happen. The two cases are
 * distinguishable at simulation (the entry appears in the restore list), and the fix is a call
 * anyone may make, so it is offered as a button rather than explained as a caveat.
 */
const position = (pps) => {
  if (W === "archived") {
    return `<div class="pos">
        <span class="k">Your position</span>
        <div class="refusal" style="margin:12px 0 0">
          <b>Archived — not lost, and not changed.</b>
          <p>The network archived this entry, so it cannot be read right now. Your shares and their value are
             unchanged. One call brings it back, and <b style="color:var(--dim)">anyone can make it.</b></p>
          <div class="opts"><button style="border-color:var(--ember);color:var(--ember)">Restore my position</button></div>
        </div>
      </div>
      <div class="contract"><span>Vault contract</span><a href="#">CBQH…K4WA ↗</a></div>`;
  }
  const on = W !== "off" && W !== "wrong";
  return `<div class="pos">
    <span class="k">Your position</span>
    <div class="pos-row"><span>Shares</span><v>${on ? "12,500.000" : "—"}</v></div>
    <div class="pos-row"><span>Worth today</span><v>${on ? `${fmt(12500 * pps, 1)} XLM` : "—"}</v></div>
    <div class="pos-row"><span>Queued exit</span><v>${W === "refused" ? `<span class="muted">nothing queued</span>` : "—"}</v></div>
  </div>
  <div class="contract"><span>Vault contract</span><a href="#">CBQH…K4WA ↗</a></div>`;
};

/* The wrong-network guard blocks rather than explains: every call would fail against a contract
   that does not exist on the chain the wallet is pointed at, and a disabled button with a reason
   beats a signed transaction that reverts. */
const netBlock = `<div class="block">
    <b>Your wallet is on Mainnet.</b>
    <p>This vault exists only on Testnet. Antares has never been deployed to Mainnet — if you find
       something that claims to be it, it is not.</p>
  </div>`;

const ctaFor = (verb) =>
  W === "off"
    ? `<button class="cta">Connect wallet to ${verb}</button>`
    : W === "wrong"
      ? `<button class="cta" disabled style="background:transparent;color:var(--faint);border:1px solid var(--rule-soft)">Switch to Testnet first</button>`
      : `<button class="cta">${verb[0].toUpperCase() + verb.slice(1)} 250 XLM</button>`;

const balanceLine = () => (W === "off" || W === "wrong" ? "Balance —" : "Balance 4,120.5 XLM");

/*
 * The sharpest error in the product, and the one the product RECOMMENDS.
 * `request_withdraw(require_idle = true)` is documented to depositors as the safe default and it
 * works by REVERTING with `WrongPhase` when a round opened first — so the recommended path shows a
 * red failure unless the interface says what actually happened. Nothing was taken; nothing changed.
 */
const refusal = `<div class="refusal">
    <b>A new round opened before your exit landed.</b>
    <p><b style="color:var(--dim)">Nothing was taken and nothing changed.</b> You asked to leave only if
       the window was still open, and it closed first. <code>(WrongPhase)</code></p>
    <div class="opts">
      <button>Wait for the next window — about 7 days</button>
      <button>Queue an exit at this round's closing price</button>
    </div>
  </div>`;

/*
 * `08-OFFCHAIN §3`: browser push is CUT, and the reason is the trust claim — push that reaches a
 * user with the tab closed needs a server holding subscriptions and watching the chain, and that is
 * a backend of record. Keeping it would have meant shipping a service the trust model denies, or a
 * notification that only fires while the user is already looking at the page.
 *
 * A calendar file is the honest substitute: it touches no funds, holds no keys and is not a backend
 * of anything. Which moment it names depends on whether the option sells, and that is decided at
 * `auction_end` — so both anchors are offered while the round is live rather than one guessed one.
 */
const calendarCard = `<div class="card" style="margin-top:22px">
    <h2><span>Antares cannot notify you</span></h2>
    <div class="body">
      <p class="note" style="margin:0">
        No server watches the chain for you, so nothing here can remind you. Take a file instead.
      </p>
      <button class="cta" style="background:transparent;color:var(--ink);border:1px solid var(--ink)"
              onclick="downloadIcs()">Add the next window to your calendar</button>
      ${more(
        "Why two dates, and why no notifications",
        `<p>The file carries both endings — <b>09:00 today</b> if nobody bids, <b>29 Aug</b> if the
            option sells — because which one it is gets decided when the auction closes. Delete the one
            that did not happen.</p>
         <p>Push that reaches you with the tab closed needs a server holding subscriptions and watching
            the chain. That is a backend of record, and this app's first architectural line is that it
            does not have one.</p>`,
      )}
    </div>
  </div>`;

/* A real file rather than a mocked button: it is four lines, and a reminder nobody can open is not
   a substitute for a notification. Times are UTC, which is what `Z` means here. */
function downloadIcs() {
  const ev = (uid, stamp, title, desc) =>
    ["BEGIN:VEVENT", `UID:${uid}@antares`, `DTSTAMP:${stamp}`, `DTSTART:${stamp}`,
     `SUMMARY:${title}`, `DESCRIPTION:${desc}`, "END:VEVENT"].join("\r\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Antares//Vault//EN",
    ev("r12-lapse", "20260822T090000Z", "Antares — your window may be open (7-day 3% vault)",
       "If round 12 found no buyer it finalised at 09:00 and deposits and exits are instant now. Delete this if the option sold."),
    ev("r12-expiry", "20260829T081500Z", "Antares — round 12 expires (7-day 3% vault)",
       "If the option sold, the round expires now and anyone can close it for a bounty. Delete this if nobody bid."),
    "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = "antares-next-window.ics";
  a.click();
  URL.revokeObjectURL(a.href);
}

const asidePending = (note, nag) => `<div class="card">
    <div class="tabs"><button aria-selected="true">Deposit</button><button aria-selected="false">Withdraw</button></div>
    <div class="body">
      <span class="k">Amount</span>
      <div class="field"><input placeholder="0.00" inputmode="decimal" /><button>Max</button><span>XLM</span></div>
      <div class="meta"><span>min 10 XLM</span><span>${balanceLine()}</span></div>
      <div class="meta"><span>${fmt(P.cap - P.notional)} XLM left under the cap</span></div>
      ${ctaFor("deposit")}
      <p class="note">${note}</p>
    </div>
    ${W === "wrong" ? netBlock : ""}
    ${W === "refused" ? refusal : ""}
    ${W === "off" || W === "wrong" ? "" : nag || ""}
    ${position(1.0122)}
  </div>
  ${calendarCard}`;

const asideInstant = () => `<div class="card">
    <div class="tabs"><button aria-selected="true">Deposit</button><button aria-selected="false">Withdraw</button></div>
    <div class="body">
      <span class="k">Amount</span>
      <div class="field"><input placeholder="0.00" inputmode="decimal" /><button>Max</button><span>XLM</span></div>
      <div class="meta"><span>min 10 XLM</span><span>${balanceLine()}</span></div>
      <div class="meta"><span>${fmt(P.cap - P.notional)} XLM left under the cap</span></div>
      ${ctaFor("deposit")}
      <p class="note">
        <b>Becomes shares in the same transaction.</b> Nothing pending, nothing to collect later. Exits pay out immediately too.
      </p>
      <p class="note">
        </p>
      ${more(
        "If a round opens the moment you press this",
        `<p>The deposit becomes a pending one and an exit becomes burn-now-claim-later. Nothing is lost
            either way, which is why the button is not withheld as the window runs down.</p>`,
      )}
    </div>
    ${W === "wrong" ? netBlock : ""}
    ${W === "refused" ? refusal : ""}
    ${position(1.0122)}
  </div>
  ${calendarCard}`;

// ---- the seven states ---------------------------------------------------------------------------
const STATES = {
  auction: {
    chip: "Auction",
    label: "The option is for sale",
    note: "Round 12 · nobody has bought it yet",
    tone: "live",
    left: () =>
      card(
        "The price is falling",
        `linear · ${P.startBps} → ${P.floorBps} bps over 45 min`,
        `<div class="body auction">
           <div>
             <svg class="curve" aria-hidden="true" id="curve"></svg>
             <p class="sub" style="margin-top:14px">
               Only the shaded wedge is worth buying — <b style="color:var(--ember)">3 m 54 s of the 45</b>.
             </p>
             ${more(
               "Why most rounds go unsold",
               `<p>The asking price falls in a straight line and a buyer only acts once it drops below
                   what the option is worth. At these terms that window is under four minutes, so a
                   round with no buyer is the ordinary outcome rather than a sign anything is wrong.</p>`,
             )}
             
           </div>
           <div class="now-box">
             <span class="k">Buy it now for</span>
             <span class="big">721<small>.4 XLM</small></span>
             <span class="sub">85.6 bps of ${fmt(P.notional)} XLM — still 10 bps above fair. Worth buying in <b>1 m 06 s</b>.</span>
             <div style="margin-top:18px"><span class="k">Auction ends in</span><span class="big clock">04:58</span></div>
             <p class="sub">Then it ends with no premium and nothing lost — 6 of the last 10 did.</p>
           </div>
         </div>` +
          stats([
            ["Strike", "$0.2127", "3% above the price at open"],
            ["Expires", "29 Aug, 08:15", "in 6 d 23 h"],
            ["Covered this round", fmt(P.notional), "XLM — 0 sold so far"],
            ["Fair value", `${P.fairBps} bps`, "Black-Scholes at σ 33.7%"],
          ]),
      ) +
            simulatorCard("$0.2127") +
      recordCard +
      anyoneCard(
        { on: false, why: "From 29 Aug, 08:15 — when the round expires. The caller keeps a bounty out of the premium." },
        { on: false, why: "4 h after this round is closed. No keeper has special rights here; the project runs one only so the vault does not sit idle." },
      ) +
      configCard,
    aside: () =>
      asidePending(
        `<b>Waits as a pending deposit.</b> Converts when the round ends — in about <b>5 minutes</b> if
         nobody bids, on <b>29 Aug</b> if it sells. Take it back any time before that.`,
        `<div class="nag">
           <b>You have 250 XLM waiting</b>
           <p>From round 11. Becomes shares when this round ends — and you cannot deposit again until you collect it.</p>
           <button>Collect 250 XLM as shares</button>
         </div>`,
      ),
  },

  window: {
    chip: "Window open",
    label: "Your window is open",
    note: "Round 12 had no buyer · deposits, exits and redemptions are instant right now",
    tone: "live",
    left: () =>
      card(
        "The window",
        "min_idle_gap · 4 h, guaranteed",
        `<div class="body">
           <span class="k">Open for at least</span>
           <span class="big clock" style="font-size:44px">2 h 41 m</span>
           <p class="sub" style="max-width:70ch">
             <b>A floor, not a deadline.</b> 13:04 is the earliest anyone may open the next round.
           </p>
           ${more(
             "What happens at 13:04",
             `<p>Nothing, unless somebody acts. The window stays open until a round is actually opened,
                 which may be minutes later or days later, and the somebody can be you. Nothing on this
                 page is withheld as the clock runs down.</p>`,
           )}
           
         </div>` +
          stats([
            ["Window opened", "09:00", "when round 12 finalised with no buyer"],
            ["Earliest close", "13:04", "the first moment open_epoch can succeed"],
            ["Deposits", "Instant", "no pending step while no round is running"],
            ["Exits", "Instant", "request_withdraw pays out in the same transaction"],
          ]),
      ) +
      recordCard +
      anyoneCard(
        { on: false, why: "Nothing to close — round 12 is finalised. This becomes available again once the next round has expired." },
        { on: false, why: "In 2 h 41 m. Opening a round reads the oracle, fixes the strike 3% above the price at that moment, and puts the whole vault balance up for auction for 45 minutes. Anyone may call it and nobody is paid to." },
      ) +
      configCard,
    aside: () => asideInstant(),
  },

  active: {
    chip: "Sold, running",
    label: "Sold — the round is running",
    note: "Round 13 · a buyer paid 657.7 XLM up front",
    tone: "live",
    left: () =>
      card(
        "The round",
        "sold at 78 bps, 45 s before the auction closed",
        `<div class="body">
           <div style="display:grid;grid-template-columns:1fr 1fr;gap:26px">
             <div>
               <span class="k">Premium, already in the vault</span>
               <span class="big">657<small>.7 XLM</small></span>
               <p class="sub">Yours whatever happens next.</p>
             </div>
             <div>
               <span class="k">Expires in</span>
               <span class="big clock">6 d 20 h</span>
               <p class="sub">29 Aug, 13:04. Nothing to do until then.</p>
             </div>
           </div>
           <div style="margin-top:26px">
             <span class="k">Where XLM sits against the strike</span>
             ${gauge(0.2069, 0.2131, 0.2065, "now $0.2065 — below the strike")}
             <p class="sub">Below it the buyer gets nothing. Above it your gain stops at $0.2131.</p>
           </div>
         </div>` +
          stats([
            ["Strike", "$0.2131", "3% above the price at open"],
            ["Sold", fmt(P.notional), "XLM — the whole vault, in one fill"],
            ["Premium", "78 bps", `against a fair value of ${P.fairBps} bps`],
            ["Price per share", "1.01220", "up from 1.00437 when the option sold"],
          ]),
      ) +
            simulatorCard("$0.2131") +
      recordCard +
      anyoneCard(
        { on: false, why: "From 29 Aug, 13:04, when the round expires. Bounty to whoever calls it: <b>1.6 XLM</b>, simulated." },
        { on: false, why: "4 h after this round closes — 29 Aug, 17:04 at the earliest." },
      ) +
      configCard,
    aside: () =>
      asidePending(
        `<b>Waits as a pending deposit</b> and converts on <b>29 Aug</b>, when round 13 ends. It earns
         nothing while it waits.`,
      ),
  },

  delayed: {
    chip: "Settlement late",
    label: "Settlement is late",
    note: "Round 13 expired 2 h 16 m ago · your funds are safe",
    tone: "live",
    left: () =>
      card(
        "The price feed is not answering",
        "three endings, and the contract has already decided all of them",
        `<div class="body">
           <p class="sub" style="margin-top:0;max-width:78ch;font-size:12px;color:var(--dim)">
             Settling reads the oracle and the oracle is not answering.
             <b style="color:var(--ink)">Nothing is stuck and nothing is at risk.</b> Within 18 h 44 m
             this round ends one of three ways.
           </p>
           <ul class="endings">
             <li><s>1</s><div><b>It settles.</b> The price is read at expiry, not when the call lands, so a late close cannot move it.</div></li>
             <li><s>2</s><div><b>It is annulled and the buyer gets the premium back.</b> Only after 12 h, and only if the feed was
   demonstrably dead at expiry. Your collateral is untouched.</div></li>
             <li><s>3</s><div><b>It closes unresolved — you keep the premium, the buyer gets nothing.</b> The ending past 21 h.</div></li>
           </ul>
         </div>
         <div class="clocks">
           <div>
             <span class="k">Annulment becomes possible</span>
             <v>9 h 44 m</v>
             <u>12 h after expiry — when option 2 <b style="color:var(--dim)">becomes possible</b>, not when it happens.</u>
           </div>
           <div data-guarantee>
             <span class="k">Closes regardless — guaranteed</span>
             <v>18 h 44 m</v>
             <u>21 h after expiry. Past this it closes with no oracle call at all — but somebody has to call it, and anyone can.</u>
           </div>
         </div>`,
      ) +
      anyoneCard(
        { on: true, hot: true, why: "<b>Simulated this second: it would refuse</b> — the feed is unreachable and the round is not yet 12 h past expiry. It starts working at 10:04 tomorrow. Bounty if it settles: 1.6 XLM; if annulled, none." },
        { on: false, why: "Not until this round closes, plus 4 h." },
      ) +
      recordCard +
      configCard,
    aside: () =>
      asidePending(
        `<b>Waits as a pending deposit.</b> It converts on all three endings, including the two that pay nothing.`,
      ),
  },

  settled: {
    chip: "Settled",
    label: "Round 13 settled",
    note: "XLM closed above the strike — your gain was capped, not lost",
    tone: "quiet",
    left: () =>
      card(
        "What happened",
        "closed 29 Aug 13:04 · settled in cash, nothing was delivered",
        `<div class="body">
           <span class="k">XLM closed at</span>
           <span class="big">$0.2205<small> &nbsp;·&nbsp; 3.5% above the $0.2131 strike</small></span>
           ${gauge(0.2069, 0.2131, 0.2205, "closed $0.2205")}
           <p class="sub" style="max-width:78ch;font-size:12px;color:var(--dim);margin-top:18px">
             <b style="color:var(--ink)">You did not lose money.</b> XLM rose 6.6% and you kept everything
             below $0.2131; the vault paid out the part above it.
           </p>
           ${more(
             "The same round in dollars",
             `<p>The vault went from $17,446 to $18,114 — up 3.8% against XLM's 6.6%. That gap is the
                 cap, and it is exactly what was sold when the option sold.</p>`,
           )}
         </div>` +
          stats([
            ["Premium kept", "+657.7", "XLM, paid up front on 22 Aug"],
            ["Paid to the buyer", "−2,829.8", "XLM — the part of the rise above $0.2131"],
            ["Net", "−2,172.1", "XLM, on a vault of 84,320"],
            ["Price per share", "0.97850", "down from 1.01220", true],
          ]),
      ) +
      card(
        "The two endings, and which one this was",
        "",
        `<div class="payoff">
           <div>
             <span class="k">If XLM had been below $0.2131</span>
             <b>You would have kept the premium and every share.</b>
             <p>Price-per-share rises by the whole 657.7 XLM — what happened in round 11.</p>
           </div>
           <div data-happened>
             <span class="k">XLM was above $0.2131 — this is what happened</span>
             <b>Your gain stopped at $0.2131 and the excess was paid to the buyer.</b>
             <p>Settled in cash. Nothing delivered, nothing sold, nothing liquidated.</p>
           </div>
         </div>`,
      ) +
      recordCard +
      anyoneCard(
        { on: false, why: "Closed at 13:07 by GBZK…7QP2, who took the 1.6 XLM bounty — not by the project's keeper." },
        { on: true, why: "Live now. Opening a round fixes a new strike 3% above the price at that moment." },
      ) +
      configCard,
    aside: () => asideInstant(),
  },

  lapsed: {
    chip: "No buyer",
    label: "Round 12 had no buyer",
    note: "No premium, and nothing lost",
    tone: "quiet",
    left: () =>
      card(
        "What happened",
        "the auction closed 09:00 with no fill · this is the ordinary case",
        `<div class="body">
           <span class="k">The result</span>
           <span class="big" style="font-size:26px">Nothing moved.</span>
           <p class="sub" style="max-width:78ch;font-size:12px;color:var(--dim)">
             Nobody took it. Your shares are unchanged, and the window opened the moment the auction closed —
             deposits and exits are instant right now.
           </p>
           <p class="sub" style="max-width:78ch">
             <b>Six of the last ten ended this way.</b>
           </p>
           ${more(
             "Why that is the expected case",
             `<p>The vault is looking for someone willing to buy an option on XLM at these terms.
                 Finding out that nobody is — at five parameter sets at once — is the result the
                 experiment was built to produce, not a malfunction.</p>`,
           )}
         </div>` +
          stats([
            ["Premium", "0 XLM", "no fill, nothing to pay"],
            ["Your shares", "Unchanged", "12,500.000, as before the round"],
            ["Price per share", "1.01220", "unchanged — a lapse cannot move it"],
            ["Cost of the attempt", "0 XLM", "the vault pays nothing to hold an auction"],
          ]),
      ) +
      recordCard +
      anyoneCard(
        { on: false, why: "Nothing to close — a round with no fill finalises the first time anyone touches the vault." },
        { on: false, why: "In 2 h 41 m, at 13:04." },
      ) +
      configCard,
    aside: () => asideInstant(),
  },

  voided: {
    chip: "Annulled",
    label: "Round 9 was annulled",
    note: "The price feed was dead at expiry · premiums refunded to the buyer",
    tone: "quiet",
    left: () =>
      card(
        "What happened",
        "annulled 9 Aug 01:12, 12 h after expiry · your collateral was never touched",
        `<div class="body">
           <span class="k">The result</span>
           <span class="big" style="font-size:26px">512.4 XLM went back to the buyer.</span>
           <p class="sub" style="max-width:78ch;font-size:12px;color:var(--dim)">
             The oracle was dead when the settlement price was due. The contract will not invent one, so the
             round is undone — the buyer gets the premium back and the vault keeps every XLM it held.
           </p>
           <p class="sub" style="max-width:78ch">
             <b>The only outcome where money leaves without a price being agreed</b> — capped at the premium
             that came in.</p>
           ${more(
             "Why not just settle at the strike",
             `<p>Either invented price hands one side a win for somebody else's outage. Undoing the
                 round is the only ending that costs neither party anything they earned.</p>`,
           )}
         </div>` +
          stats([
            ["Premium refunded", "−512.4", "XLM — the whole of it, to the buyer"],
            ["Your collateral", "Untouched", "84,320 XLM, never at risk"],
            ["Price per share", "1.00000", "back to where the round opened"],
            ["Claimed by the buyer", "Pull, not push", "claim_refund — the vault never iterates a list"],
          ]),
      ) +
      recordCard +
      anyoneCard(
        { on: false, why: "Annulled by GDX7…M4LC, a bystander. The annul branch pays no bounty." },
        { on: true, why: "Live now. The 4 h window elapsed at 05:12." },
      ) +
      configCard,
    aside: () => asideInstant(),
  },
};

/*
 * The payoff simulator D-35 asks for, in place of the yield figure it forbids: "if XLM closes below
 * the strike you keep X; above it, your upside caps at Y".
 *
 * Computed from the round's real numbers rather than illustrated, because the shape is the argument:
 * above the strike the last column flattens. That flat line IS the covered call, and no sentence
 * makes it as quickly as five rows of arithmetic do. It is also the honest counterweight to the
 * premium — the same table that shows the 8.6 XLM you are paid shows what it costs in a rally.
 */
let simAmount = 1000;

function simulate(amount) {
  const OPEN = 0.2065, STRIKE = 0.2127, PREM_BPS = 85.6;
  const credited = amount * (PREM_BPS / 10000);
  const rows = [-10, 0, 3, 6, 10].map((pct) => {
    const close = OPEN * (1 + pct / 100);
    const payout = close > STRIKE ? amount * ((close - STRIKE) / close) : 0;
    const held = amount + credited - payout;
    const worth = held * close;
    const plain = amount * close;
    return { pct, close, held, worth, diff: worth - plain, capped: payout > 0 };
  });
  return { credited, rows };
}

function resim(v) {
  const n = Math.max(10, Math.min(15680, Number(String(v).replace(/[^0-9.]/g, "")) || 0));
  simAmount = n;
  const host = document.getElementById("sim-out");
  if (host) host.innerHTML = simRows();
}

const simRows = () => {
  const { credited, rows } = simulate(simAmount);
  return (
    tbl(
      [
        ["XLM closes at", "1fr"],
        ["Your XLM after", "1fr", "num"],
        ["Worth", "1fr", "num"],
        ["vs simply holding XLM", "1fr", "num"],
      ],
      rows.map((r) => [
        `${r.pct === 3 ? `<b>$${r.close.toFixed(4)}</b> <span class="muted">the strike</span>` : `$${r.close.toFixed(4)} <span class="muted">${r.pct > 0 ? "+" : ""}${r.pct}%</span>`}`,
        `<span class="${r.capped ? "" : "muted"}">${fmt(r.held, 1)}</span>`,
        `<b${r.capped ? ' style="color:var(--ember)"' : ""}>$${r.worth.toFixed(2)}</b>`,
        `<span class="muted">${r.diff >= 0 ? "+" : "−"}$${Math.abs(r.diff).toFixed(2)}</span>`,
      ]),
    ) +
    `<div class="body" style="border-top:1px solid var(--rule-soft)">
       <p class="sub" style="margin:0;max-width:88ch">
         Credited <b>${credited.toFixed(2)} XLM</b> when the option sells. Above the strike the
         <b>Worth</b> column stops moving — that flat line is the cap.
       </p>
       ${more(
         "What the cap actually costs",
         `<p>Below the strike the premium is the whole story. Above it you keep every XLM you own and
             the vault settles the difference in cash — nothing is liquidated and no position is
             closed. The last column is what that trade is worth against simply holding XLM, and it
             turns negative exactly where the cap begins.</p>`,
       )}
       
     </div>`
  );
};

const simulatorCard = (strike) =>
  card(
    `Your cap this round is ${strike}`,
    "settled in cash — you keep every XLM you own",
    `<div class="body" style="padding-bottom:14px">
       <p style="margin:0 0 18px;font-size:14px;line-height:1.55;max-width:70ch">
         Below ${strike} you keep the premium and every share. Above it your gain stops there.
       </p>
       <span class="k">If you held</span>
       <div class="field" style="max-width:320px">
         <input value="${fmt(simAmount)}" inputmode="decimal" oninput="resim(this.value)" />
         <span>XLM</span>
       </div>
     </div>
     <div id="sim-out">${simRows()}</div>`,
  );

/* The payoff pair, in the two tenses it needs. Deliberately never says "sell": settlement is in
   cash, the depositor keeps every XLM they own and pays the difference — and teaching "sold"
   describes physical settlement, which is exactly what this protocol is not. */
function payoffCard(strike) {
  return card(
    "What this round does to your XLM",
    "settled in cash — you keep every XLM you own",
    `<div class="payoff">
       <div>
         <span class="k">If XLM is below ${strike} at expiry</span>
         <b>You keep the premium and every share you hold.</b>
         <p>The buyer walks away.</p>
       </div>
       <div>
         <span class="k">If XLM is above ${strike} at expiry</span>
         <b>Your gain stops at ${strike}. The excess is paid to the buyer.</b>
         <p>Settled in cash — nothing is delivered and nothing is sold.</p>
       </div>
     </div>`,
  );
}

// ---- the auction curve ---------------------------------------------------------------------------
/*
 * The one object on this page no competitor has: Ribbon runs its auction off-chain among whitelisted
 * market makers, and Lusty sets the price itself. Drawn from the contract's own parameters — linear
 * decay from `premium_start_bps` to `premium_floor_bps` across `auction_duration`, against the
 * Black-Scholes fair value.
 *
 * The shaded wedge is the argument. A rational bidder acts only while the asking price is BELOW fair
 * value, and at instance A that is under four minutes of a forty-five minute auction. Every "why did
 * nothing happen" question this project will be asked is answered by it.
 *
 * Drawn at measured pixel size rather than through a stretched viewBox: preserveAspectRatio="none"
 * scales text with the box and every label comes out horizontally smeared.
 */
function drawCurve() {
  const el = document.getElementById("curve");
  if (!el) return;
  const START = P.startBps, FLOOR = P.floorBps, FAIR = P.fairBps, T = P.auctionSec, NOW = 2400;
  const bpsAt = (t) => START - ((START - FLOOR) * t) / T;
  const tCross = ((START - FAIR) * T) / (START - FLOOR);
  const W = Math.max(280, el.clientWidth), H = W < 470 ? 200 : 262;
  // Below ~470 px there is not room for both the long labels and the line they annotate. The two
  // that go are the two the card's caption already carries in prose, so nothing is lost that the
  // reader cannot find one line lower.
  const tight = W < 470;
  const L = 6, R = W - (tight ? 34 : 64), TOP = tight ? 26 : 34, BOT = H - (tight ? 24 : 30);
  const x = (t) => L + (t / T) * (R - L);
  const y = (b) => BOT - (b / (START * 1.04)) * (BOT - TOP);
  const n = (v) => Math.round(v * 10) / 10;

  el.setAttribute("viewBox", `0 0 ${W} ${H}`);
  el.innerHTML = `
    <path class="under" d="M ${n(x(0))} ${n(y(START))} L ${n(x(T))} ${n(y(FLOOR))} L ${n(x(T))} ${n(BOT)} L ${n(x(0))} ${n(BOT)} Z"/>
    <path class="live" d="M ${n(x(tCross))} ${n(y(FAIR))} L ${n(x(T))} ${n(y(FAIR))} L ${n(x(T))} ${n(y(FLOOR))} Z"/>
    <line class="axis" x1="${L}" y1="${n(BOT)}" x2="${n(R)}" y2="${n(BOT)}"/>
    <line class="fair" x1="${L}" y1="${n(y(FAIR))}" x2="${n(R)}" y2="${n(y(FAIR))}"/>
    <line class="cross" x1="${n(x(tCross))}" y1="${n(TOP)}" x2="${n(x(tCross))}" y2="${n(BOT)}"/>
    <path class="line" d="M ${n(x(0))} ${n(y(START))} L ${n(x(T))} ${n(y(FLOOR))}"/>
    <text x="${L}" y="${n(y(START) - 10)}">${tight ? `asking ${START} bps` : `asking ${START} bps · ${fmt((P.notional * START) / 10000)} XLM`}</text>
    <text x="${L}" y="${n(y(FAIR) - 9)}">fair value · ${FAIR} bps</text>
    <line class="now" x1="${n(x(NOW))}" y1="${n(TOP)}" x2="${n(x(NOW))}" y2="${n(BOT)}"/>
    <circle cx="${n(x(NOW))}" cy="${n(y(bpsAt(NOW)))}" r="4" fill="#ff6b3d"/>
    <text class="hot" x="${n(x(NOW) - 10)}" y="${n(TOP + 10)}" text-anchor="end">now · ${n(bpsAt(NOW))} bps</text>
    ${tight ? "" : `<text class="hot" x="${n(x(tCross) - 7)}" y="${n(BOT - 14)}" text-anchor="end">worth buying from 41:06</text>`}
    <text x="${L}" y="${n(H - 7)}">opened 08:15</text>
    <text x="${n(R)}" y="${n(H - 7)}" text-anchor="end">${tight ? "closes 09:00" : `closes 09:00 · floor ${FLOOR} bps`}</text>
  `;
}

// =================================================================================================
// The other three pages, plus the five-vault comparison the Vault page links to.
// =================================================================================================

const tbl = (cols, rows) => {
  const grid = `style="grid-template-columns:${cols.map((c) => c[1]).join(" ")}"`;
  const head = `<div class="tr th" ${grid}>${cols.map((c) => `<span class="${c[2] || ""}">${c[0]}</span>`).join("")}</div>`;
  // `data-l` is dead weight on a desktop and the whole mechanism on a phone, where the header row
  // is hidden and each cell reprints its own column name beside its value.
  const body = rows
    .map(
      (r) =>
        `<div class="tr" ${grid}>${r
          .map((cell, i) => `<span class="${cols[i][2] || ""}" data-l="${cols[i][0]}">${cell}</span>`)
          .join("")}</div>`,
    )
    .join("");
  return `<div class="tbl">${head}${body}</div>`;
};

const outcome = (o) =>
  ({
    settled: `<span class="pill" data-o="settled">Settled</span>`,
    lapsed: `<span class="pill">No buyer</span>`,
    void: `<span class="pill" data-o="void">Annulled</span>`,
  })[o];

/*
 * Ten rounds, and they are the same ten the record strip counts: six with no buyer, three settled,
 * one annulled. Written out rather than generated because the price-per-share column has to chain —
 * a history whose own numbers do not add up is worse than no history, and this page's entire claim
 * is that every row is a transaction somebody else can check.
 */
const HISTORY = [
  [13, "22 Aug 13:04", "settled", "+657.7", "−2,829.8", "0.97850", "a41c…9f2b"],
  [12, "22 Aug 08:15", "lapsed", "—", "—", "1.01220", "7d09…c115"],
  [11, "15 Aug 08:15", "settled", "+562.0", "0", "1.01220", "3ee8…41a7"],
  [10, "8 Aug 08:15", "settled", "+462.1", "0", "1.00550", "b620…8d3e"],
  [9, "1 Aug 08:15", "void", "+512.4 → refunded", "—", "1.00000", "5fa1…20c4"],
  [8, "25 Jul 08:15", "lapsed", "—", "—", "1.00000", "c803…7e59"],
  [7, "18 Jul 08:15", "lapsed", "—", "—", "1.00000", "9b24…d0f6"],
  [6, "11 Jul 08:15", "lapsed", "—", "—", "1.00000", "1a7f…6b82"],
  [5, "4 Jul 08:15", "lapsed", "—", "—", "1.00000", "e5c0…3419"],
  [4, "27 Jun 08:15", "lapsed", "—", "—", "1.00000", "84dd…af07"],
];

const roundsPage = () =>
  pageHead("Rounds", "Every round this vault has run, read from the chain — each row opens in the explorer") +
  card(
    "Round history",
    "instance A · 7-day · 3%",
    tbl(
      [
        ["Round", "60px"],
        ["Opened", "150px"],
        ["Outcome", "120px"],
        ["Premium", "1fr", "num"],
        ["Paid to the buyer", "1fr", "num"],
        ["Price per share after", "1fr", "num"],
        ["Transaction", "120px", "num"],
      ],
      HISTORY.map(([n, opened, o, prem, pay, pps, tx]) => [
        `<b>${n}</b>`,
        `<span class="muted">${opened}</span>`,
        outcome(o),
        prem === "—" ? `<span class="muted">—</span>` : prem,
        pay === "—" ? `<span class="muted">—</span>` : pay,
        pps,
        `<a href="#">${tx} ↗</a>`,
      ]),
    ),
  ) +
  card(
    "Why this page is a feature and not a report",
    "",
    `<div class="body">
       <p class="sub" style="margin-top:0;max-width:82ch;font-size:12px;color:var(--dim)">
         Every row is an event the contract emitted, and the last column is the transaction that emitted
         it — so anyone with the contract id can rebuild this table without us.
       </p>
       <p class="sub" style="max-width:82ch">
         <b>Six of these ten found no buyer</b>, one was annulled, and of the three that sold, one cost
         the vault more than its premium. That is the whole record at these terms.
       </p>
     </div>`,
  );

/*
 * Claims — the bidder's side. `08-OFFCHAIN §3` is unusually specific about how this page finds its
 * rows, and the reason is a defect an earlier draft had: Soroban RPC retains roughly seven days of
 * events, which at instance A is barely one round, so a bidder who looked a round late would find
 * an empty page and conclude they were owed nothing.
 */
const CLAIMS = [
  [13, "A · 7-day 3%", "settled", "84,320", "2,829.8", "claimable", false],
  [9, "A · 7-day 3%", "void", "68,000", "512.4", "claimable", true],
  [11, "A · 7-day 3%", "settled", "84,320", "0", "nothing owed", false],
  [6, "C · 3-day 2%", "settled", "12,000", "318.9", "claimed", false],
];

const claimsPage = () =>
  pageHead("Claims", "What the vaults owe you as a buyer — payouts from settled rounds and refunds from annulled ones") +
  card(
    "Unclaimed",
    "shown whether the round is recent or not",
    `<div class="body">
       <div class="total">
         <span class="big" style="font-size:44px">3,342<small>.2 XLM</small></span>
         <span class="sub" style="margin:0">across 2 rounds · nothing here expires</span>
       </div>
       <p class="sub" style="max-width:82ch">
         No deadline, and no way for these to be swept. A claim works the same a year later as on the day.
       </p>
     </div>`,
  ) +
  card(
    "Your fills",
    "read from the chain, not from events — see below",
    tbl(
      [
        ["Round", "60px"],
        ["Vault", "150px"],
        ["Outcome", "120px"],
        ["You filled", "1fr", "num"],
        ["Owed to you", "1fr", "num"],
        ["", "180px", "num"],
      ],
      CLAIMS.map(([n, vault, o, filled, owed, state, archived]) => [
        `<b>${n}</b>`,
        `<span class="muted">${vault}</span>`,
        outcome(o),
        `<span class="muted">${filled} XLM</span>`,
        state === "claimable" ? `<b>${owed} XLM</b>` : `<span class="muted">${owed} XLM</span>`,
        state === "claimable"
          ? `<button class="mini">${o === "void" ? "Claim refund" : "Claim payout"}</button>${
              archived ? `<div class="muted" style="margin-top:7px">archived — restored by the claim itself</div>` : ""
            }`
          : `<span class="muted">${state}</span>`,
      ]),
    ),
  ) +
  card(
    "How this page finds your fills, and why it does not use events",
    "",
    `<div class="body">
       <p class="sub" style="margin-top:0;max-width:82ch;font-size:12px;color:var(--dim)">
         Soroban's RPC keeps about <b style="color:var(--ink)">seven days</b> of events — barely one round.
         A page built on events would show a bidder who looked a round late an empty table.
       </p>
       <ul class="endings">
         <li><s>1</s><div><b>Claiming is never the problem.</b> An archived entry is restored inside the claim's own footprint.</div></li>
         <li><s>2</s><div><b>An archived entry is not an absent one, and the page can tell.</b> It appears in the restore list at simulation.</div></li>
         <li><s>3</s><div><b>Recent rounds come from the chain first</b>, so a fill from an hour ago does not wait for a redeploy.</div></li>
       </ul>
     </div>`,
  );

/*
 * My positions — the page that keeps this from becoming a trading terminal. It is deliberately
 * flat: where your money is, and when you can move it. No P&L curve, no allocation ring, no
 * ranking of the five against each other.
 */
const FLEET = [
  ["A", "7-day · 3%", "12,500.000", "12,652.5", "Your window is open", "open now — anyone may close it from 13:04", true],
  ["B", "7-day · 5%", "4,000.000", "4,000.0", "The option is for sale", "if nobody bids, in about 12 m", false],
  ["C", "3-day · 2%", null, null, "Sold — running", "26 Aug, then 4 h later", false],
  ["D", "14-day · 5%", "2,000.000", "2,014.8", "Sold — running", "29 Aug, then 4 h later", false],
  ["E", "3-day · 3%", null, null, "Your window is open", "open now", false],
];

const positionsPage = () =>
  pageHead("My positions", "Across all five vaults — where your money is, and when you can next move it") +
  card(
    "Total",
    "",
    `<div class="body">
       <div class="total">
         <span class="big" style="font-size:44px">18,667<small>.3 XLM</small></span>
         <span class="sub" style="margin:0">in 3 of 5 vaults · $3,854 at today's price</span>
       </div>
       <p class="sub" style="max-width:82ch">
         One of your three has an open window — deposits and exits there settle instantly. The other two
         are inside a live round.
       </p>
     </div>`,
  ) +
  card(
    "Your five vaults",
    "the same wasm, five parameter sets",
    tbl(
      [
        ["Vault", "190px"],
        ["Your shares", "1fr", "num"],
        ["Worth today", "1fr", "num"],
        ["What it is doing", "220px"],
        ["Next window", "1fr"],
      ],
      FLEET.map(([code, name, shares, worth, phase, next, open]) => [
        `<b>${name}</b> <span class="muted">· instance ${code}</span>`,
        shares ? shares : `<span class="muted">—</span>`,
        worth ? `${worth} XLM` : `<span class="muted">no position</span>`,
        open ? `<span class="pill" data-o="claimable">${phase}</span>` : `<span class="pill">${phase}</span>`,
        `<span class="muted">${next}</span>`,
      ]),
    ),
  );

/*
 * Five vaults are not a menu. The comparison is on two plain axes and never on `epoch_duration` or
 * `strike_bps_otm` — and the second axis says "keep the gain", never "sell", because settlement is
 * in cash and teaching "sold" describes physical settlement on the one label a person reads while
 * choosing between five options.
 */
const comparePage = () =>
  pageHead("Five vaults, one experiment", "They differ in two things only. Everything else — the code, the oracle, the auction — is identical.") +
  card(
    "How they differ",
    "instance A is the default; the rest are the experiment",
    `<div class="fleet">
       ${[
         ["A", "7-day · 3%", "7 days", "up to 3% higher", "The default. The shortest commitment that still prices an option anyone would buy.", true],
         ["B", "7-day · 5%", "7 days", "up to 5% higher", "The same week, but you keep more of a rise — and the cheaper option sells less often.", false],
         ["C", "3-day · 2%", "3 days", "up to 2% higher", "Half the commitment, and you give up the gain soonest of the five.", false],
         ["D", "14-day · 5%", "14 days", "up to 5% higher", "The longest commitment, and the richest premium for it.", false],
         ["E", "3-day · 3%", "3 days", "up to 3% higher", "Shares its length with C and its cap with A — a fill here says which of the two mattered.", false],
       ]
         .map(
           ([code, name, days, cap, why, def]) => `<div ${def ? "data-default" : ""}>
             <h3>${name}</h3>
             <span class="muted">instance ${code}${def ? " · default" : ""}</span>
             <dl>
               <dt>Your money is committed for</dt><dd>${days}</dd>
               <dt>You keep the gain</dt><dd>${cap}</dd>
             </dl>
             <p class="why">${why}</p>
             ${def ? "" : `<button class="switch">Join the experiment</button>`}
           </div>`,
         )
         .join("")}
     </div>`,
  ) +
  card(
    "What the two axes actually mean",
    "",
    `<div class="payoff">
       <div>
         <span class="k">How long your money is committed</span>
         <b>The length of one round, plus a window at the end of it.</b>
         <p>You can queue an exit at any moment; the length decides how long you wait for it to pay. Between
            rounds there is a window of at least four hours in which exits are instant.</p>
       </div>
       <div>
         <span class="k">How far XLM can rise before you stop keeping the gain</span>
         <b>The cap, set fresh at the start of every round from the price at that moment.</b>
         <p>Below it you keep everything and the premium on top. Above it the vault pays the difference in
            cash — nothing is delivered or sold.</p>
       </div>
     </div>`,
  );

/*
 * Operator log — the inverse of an admin console.
 *
 * `08-OFFCHAIN §3` specifies four pages and no admin surface, and that is right: `upgrade`/`migrate`
 * depend on a reviewed wasm hash and 09-DEPLOYMENT §4's post-check ladder, mainnet moves the admin
 * to a timelocked multisig that does not press buttons in a browser, and a statically-hosted "admin"
 * route hides nothing from anyone — the only gate is the contract's own `require_auth`.
 *
 * But the *read* side belongs here and had no home. Every admin-gated call emits an event —
 * 02-CONTRACT-SPEC §14 says so and says why: "Every setter emits... a UI that only reads events must
 * be able to show the current cap, fee and allowlist." So the material for this page already exists,
 * and what it produces is not a place to exercise power but the record of its exercise. That is the
 * side of the trust claim no competitor publishes.
 */
const OPS = [
  ["2 Oct 08:01", "migrated", "app_version 1 → 2", "d91c…7a03"],
  ["2 Oct 08:00", "upgraded", "wasm 7b5f…a80f2 → 9c21…44e7", "6b02…e918"],
  ["14 Sep 15:40", "unpaused", "deposits and new rounds resume", "af31…5c26"],
  ["14 Sep 11:05", "paused", "during the feed outage of round 21 — exits stayed open throughout", "22e7…b840"],
  ["3 Sep 09:22", "cap_changed", "deposit cap 50,000 → 100,000 XLM", "70da…19f5"],
  ["20 Aug 23:14", "allowlist_toggled", "enabled — the 30-day window starts", "c4b8…2e71"],
  ["20 Aug 23:11", "initialized", "deployed with its full configuration", "7556…1e68"],
];

const operatorPage = () =>
  pageHead(
    "Operator log",
    "Every admin action this vault has ever taken, read from the chain. Nothing on this page is filtered by us, and nothing is written by us.",
  ) +
  card(
    "Who holds the admin key",
    "and what that key is worth",
    stats([
      ["Admin", "GDFP…KBQQ", "a single testnet key — on mainnet, a timelocked multisig"],
      ["Actions taken", "7", "in 62 days, all of them below"],
      ["Allowlist expires", "30 Sep 2026", "on-chain, and there is no setter to move it"],
      ["Protocol fee", "0 bps", "capped at 2,000 by on-chain validation"],
    ]),
  ) +
  card(
    "What the operator has done",
    "newest first · each row is a transaction",
    tbl(
      [
        ["When", "150px"],
        ["Call", "190px"],
        ["What changed", "1fr"],
        ["Transaction", "130px", "num"],
      ],
      OPS.map(([when, call, what, tx]) => [
        `<span class="muted">${when}</span>`,
        `<span class="pill" data-o="settled">${call}</span>`,
        what,
        `<a href="#">${tx} ↗</a>`,
      ]),
    ),
  ) +
  card(
    "What the operator cannot do",
    "the part that is enforced rather than promised",
    `<div class="body">
       <ul class="endings">
         <li><s>—</s><div><b>Take your collateral.</b> No sweep, no emergency withdrawal, no recipient field but the protocol fee — which ships at zero.</div></li>
         <li><s>—</s><div><b>Trap it by pausing.</b> <code>close_round</code>, <code>redeem_shares</code> and
   <code>request_withdraw</code> are unpausable. Pause stops money coming in, not going out.</div></li>
         <li><s>—</s><div><b>Extend the allowlist, or repoint the price feed.</b> No setter exists for any of the three — each costs a reviewed upgrade.</div></li>
         <li><s>—</s><div><b>Set a fee worth having.</b> <code>set_fee_bps</code> is capped at 2,000 — 20% of the premium, never of your collateral.</div></li>
         <li><s>—</s><div><b>Push the settlement fallback out of reach.</b> <code>unresolved_after</code> is bounded above on-chain as well as below.</div></li>
         <li><s>—</s><div><b>Lose the admin role to a typo.</b> Transfer is two-step.</div></li>
       </ul>
       <p class="sub" style="max-width:82ch;margin-top:20px">
         </p>
       ${more(
         "The one thing an admin can do",
         `<p>Ship a bad upgrade — nothing on-chain prevents it. That is stated rather than argued away:
             it is why v1 is upgradeable and unaudited at the same time, why the key moves to a
             timelocked multisig before mainnet, and why every upgrade appears in this table with its
             wasm hash.</p>`,
       )}
     </div>`,
  );

// =================================================================================================
// Router
// =================================================================================================
const PAGES = { rounds: roundsPage, claims: claimsPage, positions: positionsPage, compare: comparePage, operator: operatorPage };

function pageHead(title, sub, right = "") {
  return `<div class="head">
      <div>
        <h1>${title}</h1>
        <div class="phase" data-tone="quiet" style="margin-top:14px"><span style="max-width:78ch">${sub}</span></div>
      </div>${right}</div>`;
}

function vaultPage(key) {
  const s = STATES[key];
  return `<div class="head">
      <div>
        <div class="vault-pick">
          <h1>7-day&nbsp;·&nbsp;3% vault</h1>
          <span class="tag">Instance A</span>
          <button class="switch" onclick="location.hash='compare'">Compare 5 vaults</button>
        </div>
        <div class="phase" data-tone="${s.tone}"><strong>${s.label}</strong><span>${s.note}</span></div>
      </div>
      <div style="text-align:right"><span class="k">XLM</span><span class="big" style="font-size:22px">$0.2065</span></div>
    </div>
    <div class="grid"><section>${s.left()}</section><aside>${s.aside()}</aside></div>`;
}

let phaseKey = "auction";

const WALLET = {
  off: "No wallet",
  on: "Connected",
  archived: "Archived position",
  wrong: "Wrong network",
  refused: "A refused exit",
};

function walletCorner() {
  const bad = W === "wrong";
  const net = `<span class="net" ${bad ? "data-bad" : ""}><i style="${bad ? "background:var(--ember)" : ""}"></i> ${bad ? "Mainnet — wrong chain" : "Testnet"}</span>`;
  const right =
    W === "off"
      ? `<button class="connect">Connect wallet</button>`
      : `<span class="addr"><i style="${bad ? "background:var(--ember)" : ""}"></i> GBZK…7QP2 <button title="Disconnect">✕</button></span>`;
  return net + right;
}

/* The hash carries both dimensions — `#delayed:archived` — so any combination can be linked,
   screenshotted or reported in a bug without a click path attached to it. */
function route() {
  const [h0, w0] = (location.hash.slice(1) || "vault").split(":");
  const h = h0 || "vault";
  if (w0 && WALLET[w0]) W = w0;
  const onVault = !PAGES[h];
  if (onVault && STATES[h]) phaseKey = h;

  document.getElementById("wallet").innerHTML = walletCorner();
  document.getElementById("main").innerHTML = onVault ? vaultPage(phaseKey) : PAGES[h]();
  document.getElementById("switcher").style.display = onVault ? "" : "none";

  document.querySelectorAll("nav a").forEach((a) => {
    const t = a.getAttribute("href").slice(1);
    if ((onVault && t === "vault") || t === h) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.querySelectorAll("#switcher button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === phaseKey)));
  document.querySelectorAll("[data-w]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.w === W)));
  if (onVault) drawCurve();
}

const sw = document.getElementById("switcher");
Object.entries(STATES).forEach(([k, v]) => {
  const b = document.createElement("button");
  b.textContent = v.chip;
  b.dataset.k = k;
  b.onclick = () => (location.hash = `${k}:${W}`);
  sw.appendChild(b);
});

// The wallet is a second, orthogonal dimension: every phase above has five of these underneath it,
// and the states that only exist here — an archived position, a refused exit, the wrong chain — are
// each named in 08-OFFCHAIN as things the interface must not get wrong.
const sw2 = document.createElement("div");
sw2.className = "switcher";
sw2.style.bottom = "44px";
sw2.innerHTML = `<em>Wallet</em>`;
Object.entries(WALLET).forEach(([k, label]) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.dataset.w = k;
  b.onclick = () => {
    W = k;
    location.hash = `${location.hash.slice(1).split(":")[0] || "vault"}:${k}`;
    route();
  };
  sw2.appendChild(b);
});
document.body.appendChild(sw2);

addEventListener("hashchange", route);
addEventListener("resize", drawCurve);
route();
