"use client";

import { useCallback, useState } from "react";

import type { CallSite } from "../lib/errors.ts";
import { submit, type TxOutcome } from "../lib/tx.ts";
import type { WalletState } from "./useWallet.ts";

/**
 * One place that turns a bindings call into a signed transaction and a sentence.
 *
 * Every write on every page has the same three states — idle, waiting on the wallet, and an outcome
 * that is either a hash or a refusal — and duplicating that across the deposit panel, the claims
 * table and the permissionless card is three chances to report the same event differently.
 */
export function useAction(wallet: WalletState): {
  busy: string | null;
  outcome: TxOutcome<unknown> | null;
  run: (key: string, build: Promise<unknown>, site?: CallSite) => Promise<TxOutcome<unknown> | null>;
  clear: () => void;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TxOutcome<unknown> | null>(null);

  const run = useCallback(
    async (key: string, build: Promise<unknown>, site?: CallSite) => {
      const address = wallet.address;
      if (address === null || wallet.wrongNetwork) return null;
      setBusy(key);
      setOutcome(null);
      try {
        const wk = await import("../lib/wallet.ts");
        const result = await submit(
          build as never,
          {
            address,
            // Freighter's own shape, which is also the SDK's `Signer`. The passphrase comes from the
            // options the SDK passes in rather than from this build's own idea of the network, so a
            // wallet on the wrong chain is refused by the wallet rather than fooled by us.
            signTransaction: async (xdr, opts) => {
              const o = opts as { networkPassphrase?: string } | undefined;
              const signed = await wk.sign(xdr, o?.networkPassphrase ?? "", address);
              return { signedTxXdr: signed, signerAddress: address };
            },
          },
          site,
        );
        setOutcome(result);
        return result;
      } finally {
        setBusy(null);
      }
    },
    [wallet.address, wallet.wrongNetwork],
  );

  return { busy, outcome, run, clear: useCallback(() => setOutcome(null), []) };
}
