"use client";

import type { RoundOutcome } from "@antares/bindings";
import { useEffect, useState } from "react";

import { OUTCOME_SENTENCE, previewClose, previewOpen, type Preview } from "../lib/preview.ts";
import { writeClient } from "../lib/vault.ts";
import { Refusal } from "./Refusal.tsx";
import { useAction } from "./useAction.ts";
import type { WalletState } from "./useWallet.ts";

/**
 * The two calls that make "nobody operates this vault" a thing you can do rather than a thing we say.
 *
 * Three public documents tell the user these are theirs — DEPOSITOR §4 ("you can close the round
 * yourself"), BIDDER §4 ("get paid for doing it") and TRUST_MODEL §5 ("rounds close whenever anyone
 * calls, including you") — and the trust model's entire keeper argument rests on them. So they are
 * a card on the page with their live simulation next to them, never a developer affordance and
 * never hidden while they would refuse: at the moment they start working, nobody should have to
 * find a CLI to press them.
 */
export function Permissionless({
  wallet,
  bountyAddress,
  onDone,
  bare = false,
}: {
  wallet: WalletState;
  /** Whoever would collect the close bounty — the visitor, so the figure shown is theirs. */
  bountyAddress: string;
  onDone: () => void;
  /**
   * Render without the card shell, to sit inside another one.
   *
   * The window card already says a round can be opened; the button that opens it was two cards
   * further down. State and the action that changes it belong in one block, so in the window face
   * this renders inside that card instead of beside it. Everywhere else it keeps its own card,
   * because `close_round` matters most exactly when the window is shut.
   */
  bare?: boolean;
}) {
  const [close, setClose] = useState<Preview<RoundOutcome> | null>(null);
  const [open, setOpen] = useState<Preview<boolean> | null>(null);
  const { busy, outcome, run, clear } = useAction(wallet);

  useEffect(() => {
    let live = true;
    const env = { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] };
    void (async () => {
      const [c, o] = await Promise.all([previewClose(bountyAddress, env), previewOpen(env)]);
      if (!live) return;
      setClose(c);
      setOpen(o);
    })();
    return () => {
      live = false;
    };
  }, [bountyAddress]);

  const canClose = close?.kind === "would-succeed";
  const canOpen = open?.kind === "would-succeed";
  const connected = wallet.address !== null && !wallet.wrongNetwork;

  async function fire(key: "close" | "open") {
    const address = wallet.address;
    if (address === null) return;
    const client = writeClient(address, { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] });
    const built = key === "close" ? client.close_round({ bounty_to: address }) : client.open_epoch();
    const result = await run(key, built, key);
    if (result?.status === "sent") onDone();
  }

  const body = (
    <>
      <div className="body">
        <div className="anyone">
          <button
            className={`ghost${canClose ? " hot" : ""}`}
            type="button"
            disabled={!connected || busy !== null || close === null}
            onClick={() => void fire("close")}
          >
            {busy === "close" ? "Waiting…" : "Close the round"}
          </button>
          <p className="sub">
            {close === null ? (
              "Asking the chain…"
            ) : close.kind === "would-succeed" ? (
              <>
                <b>{OUTCOME_SENTENCE[close.value.tag] ?? close.value.tag}.</b> The caller keeps the bounty.
              </>
            ) : (
              <>
                <b>Would refuse.</b> {close.refusal.title}
                <details className="more">
                  <summary>Why</summary>
                  <p>{close.refusal.body}</p>
                </details>
              </>
            )}
          </p>
        </div>

        <div className="anyone">
          <button
            className={`ghost${canOpen ? " hot" : ""}`}
            type="button"
            disabled={!connected || busy !== null || open === null}
            onClick={() => void fire("open")}
          >
            {busy === "open" ? "Waiting…" : "Open the next round"}
          </button>
          <p className="sub">
            {open === null ? (
              "Asking the chain…"
            ) : open.kind === "would-succeed" && open.value ? (
              <>
                <b>A round would open.</b> Strike is fixed above the price at that moment.
              </>
            ) : open.kind === "would-succeed" ? (
              // `open_epoch` returning FALSE without reverting is its second failure shape: it
              // finalised a lapse and then could not open. A transaction that succeeds and changes
              // nothing visible must not be reported as success.
              <>
                <b>Would finalise the last round and open nothing.</b> Not an error, and not a new round.
              </>
            ) : (
              <>
                <b>Would refuse.</b> {open.refusal.title}
                <details className="more">
                  <summary>Why</summary>
                  <p>{open.refusal.body}</p>
                </details>
              </>
            )}
          </p>
        </div>

        {!connected && (
          <p className="note" style={{ marginTop: 18 }}>
            Connect a wallet to call either.
          </p>
        )}
      </div>

      {outcome?.status === "refused" && <Refusal text={outcome.refusal} signed={outcome.signed} />}
      {outcome?.status === "sent" && (
        <div className="refusal">
          <b>Done.</b>
          <p>
            The call landed and this page has been re-read from the chain.{" "}
            <button
              type="button"
              onClick={clear}
              style={{
                background: "none",
                border: 0,
                color: "var(--ember)",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              dismiss
            </button>
          </p>
        </div>
      )}
    </>
  );

  if (bare) return body;
  return (
    <article className="card">
      <h2>
        <span>Nobody operates this vault</span>
        <em>these two calls are open to anyone, including you</em>
      </h2>
      {body}
    </article>
  );
}
