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
}: {
  wallet: WalletState;
  /** Whoever would collect the close bounty — the visitor, so the figure shown is theirs. */
  bountyAddress: string;
  onDone: () => void;
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

  return (
    <article className="card">
      <h2>
        <span>Nobody operates this vault</span>
        <em>these two calls are open to anyone, including you</em>
      </h2>
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
              "Asking the chain what closing would do…"
            ) : close.kind === "would-succeed" ? (
              <>
                <b>Simulated now: {OUTCOME_SENTENCE[close.value.tag] ?? close.value.tag}.</b> Whoever calls it
                keeps the close bounty.
              </>
            ) : (
              <>
                <b>Simulated now: it would refuse.</b> {close.refusal.title} {close.refusal.body}
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
              "Asking the chain what opening would do…"
            ) : open.kind === "would-succeed" && open.value ? (
              <>
                <b>Simulated now: a round would open.</b> It reads the oracle, fixes the strike above the
                price at that moment, and puts the vault up for auction.
              </>
            ) : open.kind === "would-succeed" ? (
              // `open_epoch` returning FALSE without reverting is its second failure shape: it
              // finalised a lapse and then could not open. A transaction that succeeds and changes
              // nothing visible must not be reported as success.
              <>
                <b>Simulated now: it would succeed and open nothing.</b> There is a previous round left to
                finalise, and this call would do that and stop. It is not an error, and it is not a new round
                either.
              </>
            ) : (
              <>
                <b>Simulated now: it would refuse.</b> {open.refusal.title} {open.refusal.body}
              </>
            )}
          </p>
        </div>

        {!connected && (
          <p className="note" style={{ marginTop: 18 }}>
            Connect a wallet to make either call. The simulations above need no wallet — anyone can ask the
            chain what would happen, which is the same permissionlessness the buttons rely on.
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
    </article>
  );
}
