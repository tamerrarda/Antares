"use client";

import { useCallback, useEffect, useState } from "react";

import { network } from "../lib/vault.ts";

export interface WalletState {
  /** `G…`, or null when nothing is connected. */
  readonly address: string | null;
  /** The passphrase the wallet is actually on — not the one this build wants. */
  readonly walletNetwork: string | null;
  /** True when the wallet is on a different chain from the one this build was pointed at. */
  readonly wrongNetwork: boolean;
  readonly connecting: boolean;
  readonly error: string | null;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
}

/** Survives a reload so a returning visitor is not asked to pick a wallet again. */
const REMEMBERED = "antares.wallet";

/**
 * Connect, remember, and check the chain — in that order, because the third is the one that matters.
 *
 * A wallet on the wrong network does not fail loudly. It signs happily against a contract address
 * that means nothing there, and the transaction fails for a reason that has nothing to do with what
 * the user did. So the passphrase the wallet reports is compared against the one this build was
 * compiled for, and every action is withheld until they agree.
 *
 * The kit is imported dynamically and only inside the browser. It reaches for `window` at module
 * scope, and this app is a static export whose pages are rendered at build time in Node — a
 * top-level import would fail the build rather than the page.
 */
export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [walletNetwork, setWalletNetwork] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const want = network({ NETWORK: process.env["NEXT_PUBLIC_NETWORK"] }).networkPassphrase;

  const load = useCallback(async (openModal: boolean) => {
    setError(null);
    setConnecting(true);
    try {
      // The silent path only runs for somebody who has connected here before. Probing the wallet
      // on every arrival would ask the extension a question about a visitor who has not asked us
      // anything, and on a first visit it fails — which is not an error, it is the normal state.
      if (!openModal && localStorage.getItem(REMEMBERED) === null) return;
      const wallet = await import("../lib/wallet.ts");
      if (!(await wallet.available())) {
        if (openModal) {
          setError(
            "No Stellar wallet answered. Freighter, or another wallet that speaks the same protocol, " +
              "has to be installed and unlocked in this browser before anything here can be signed. " +
              "Everything on this page that only reads the chain works without one.",
          );
        }
        return;
      }
      // `connect` opens the extension's own approval prompt; `currentAddress` reads a grant that
      // already exists. Only the first is allowed to interrupt somebody who just opened the page.
      // Both are bounded in `lib/wallet.ts` — a wallet that answers detection and then goes quiet
      // would otherwise leave this promise, and the button that started it, open forever.
      const got = openModal ? await wallet.connect() : await wallet.currentAddress();
      const passphrase = await wallet.currentNetwork();
      localStorage.setItem(REMEMBERED, "freighter");
      setAddress(got);
      setWalletNetwork(passphrase);
    } catch (cause) {
      // Two things are deliberately not reported. A refused connection is a choice, not a fault.
      // And nothing on the silent path is worth a message: the visitor did not ask for this attempt,
      // so its failure is ours to swallow rather than theirs to read.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (openModal && !/reject|denied|closed/i.test(message)) setError(message);
    } finally {
      setConnecting(false);
    }
  }, []);

  // Reconnect silently on load if a wallet was chosen before. No modal: a page that opens a wallet
  // picker on arrival is asking for permission it has not been invited to ask for.
  useEffect(() => {
    void load(false);
  }, [load]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(REMEMBERED);
    setAddress(null);
    setWalletNetwork(null);
    setError(null);
  }, []);

  return {
    address,
    walletNetwork,
    wrongNetwork: address !== null && walletNetwork !== null && walletNetwork !== want,
    connecting,
    error,
    connect: () => load(true),
    disconnect,
  };
}
