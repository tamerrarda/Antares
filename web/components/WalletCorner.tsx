"use client";

import { useWallet } from "./useWallet.ts";

/** The passphrase is unreadable in a chip; the chain's name is what a person can act on. */
function chainName(passphrase: string | null): string {
  if (passphrase === null) return "unknown chain";
  if (passphrase.includes("Public Global")) return "Mainnet";
  if (passphrase.includes("Test SDF")) return "Testnet";
  return "another chain";
}

/**
 * Connect, disconnect, and the guard between them.
 *
 * The wrong-network case gets the chip rather than a toast, because it is not an event — it is a
 * condition that persists until the user changes it, and every action on the page is withheld
 * while it holds.
 */
export function WalletCorner() {
  const w = useWallet();
  const short = w.address === null ? "" : `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;

  return (
    <div id="wallet" style={{ display: "flex", alignItems: "center", gap: 14 }}>
      {w.wrongNetwork ? (
        <span className="net" data-bad="">
          <i style={{ background: "var(--ember)" }} /> {chainName(w.walletNetwork)} — wrong chain
        </span>
      ) : (
        <span className="net">
          <i /> Testnet
        </span>
      )}

      {w.address === null ? (
        <button className="connect" type="button" onClick={() => void w.connect()} disabled={w.connecting}>
          {w.connecting ? "Connecting…" : "Connect wallet"}
        </button>
      ) : (
        <span className="addr">
          <i style={w.wrongNetwork ? { background: "var(--ember)" } : undefined} /> {short}
          <button type="button" title="Disconnect" onClick={w.disconnect}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
