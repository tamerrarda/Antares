"use client";

import type { EpochInfo } from "@antares/bindings";

import { calendar } from "../lib/calendar.ts";
import { duration, when } from "../lib/format.ts";
import type { FaceId } from "../lib/phase.ts";

/**
 * A file you keep yourself, because there is nothing here that can reach you.
 *
 * `08-OFFCHAIN §3` cuts browser push and says why: push that arrives with the tab closed needs a
 * server holding subscriptions and watching the chain, and that **is** a backend of record — the one
 * thing this app's first architectural line says it does not have. Keeping push would have meant
 * shipping a service the trust model denies, or a notification that only fires while the user is
 * already looking at the page.
 *
 * A calendar file touches no funds, holds no keys and is not a backend of anything.
 *
 * **Two dates while a round is live, and that is not indecision.** A round that finds no buyer
 * finalises at `auction_end`; one that sells runs to `expiry`. Both anchors are known when the round
 * opens and which applies is not decided until the auction closes, so the file carries both and the
 * reader deletes the one that did not happen. Quoting only the expiry would be wrong on every round
 * that lapses — six of the last ten.
 */
export function Calendar({ epoch, face }: { epoch: EpochInfo; face: FaceId }) {
  const live = face !== "window";

  function download() {
    const round = epoch.round;
    const events = live
      ? [
          {
            uid: `r${round}-lapse`,
            at: epoch.auction_end,
            title: `Antares — your window may open (round ${round})`,
            body:
              `If round ${round} found no buyer it finalises now, and deposits and exits are instant ` +
              "from this moment. Delete this if the option sold.",
          },
          {
            uid: `r${round}-expiry`,
            at: epoch.expiry,
            title: `Antares — round ${round} expires`,
            body:
              "If the option sold, the round expires now and anyone can close it for a bounty — " +
              "including you. Delete this if nobody bid.",
          },
        ]
      : [
          {
            uid: `r${round}-open`,
            at: epoch.next_open_at,
            title: `Antares — the next round may open`,
            body:
              "The earliest moment anyone may open the next round. It is a floor, not a deadline: the " +
              "window stays open until somebody actually opens one.",
          },
        ];
    const blob = new Blob([calendar(events)], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `antares-round-${round}.ics`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="card" style={{ marginTop: 22 }}>
      <h2>
        <span>Antares cannot notify you</span>
      </h2>
      <div className="body">
        <p className="note" style={{ margin: 0 }}>
          Nothing here can remind you. Take a file instead.
        </p>
        <button
          className="cta"
          type="button"
          style={{ background: "transparent", color: "var(--ink)", border: "1px solid var(--ink)" }}
          onClick={download}
        >
          {live ? "Add both endings to your calendar" : "Add the next opening to your calendar"}
        </button>
        <details className="more">
          <summary>{live ? "Why two dates" : "Why one date"}</summary>
          {live ? (
            <p>
              A round that finds no buyer finalises at <b>{when(epoch.auction_end)}</b>; one that sells runs
              to <b>{when(epoch.expiry)}</b>. Which applies is decided when the auction closes, so the file
              carries both and you delete the one that did not happen.
            </p>
          ) : (
            <p>
              The window is open now and the file marks <b>{when(epoch.next_open_at)}</b> — the earliest
              anyone may open the next round
              {duration(Number(epoch.next_open_at) - Math.floor(Date.now() / 1000)) === null
                ? ", which has already passed, so anyone may open one at any moment"
                : ""}
              .
            </p>
          )}
          <p>
            Push that reaches you with the tab closed needs a server holding subscriptions and watching the
            chain. That is a backend of record, and this app does not have one.
          </p>
        </details>
      </div>
    </div>
  );
}
