"use client";

import type { ConfigView, EpochInfo, Position } from "@antares/bindings";
import { useEffect, useState } from "react";

import { readConfig, readEpoch, readPosition, vaultClient } from "../lib/vault.ts";

export interface VaultRead {
  readonly epoch: EpochInfo | null;
  readonly config: ConfigView | null;
  /** Null until a wallet is connected — and null is not the same as an empty position. */
  readonly position: Position | null;
  /** Re-read after a write of our own. Nothing else triggers it; see the note on polling. */
  readonly reload: () => void;
  readonly error: string | null;
  /** Wall clock in unix seconds, ticking, so every countdown on the page moves together. */
  readonly now: number;
}

/**
 * One read of the two views the page is built from, plus a clock.
 *
 * Deliberately not polling on a timer. A round at instance A lasts a week and nothing on this page
 * changes without a transaction, so re-fetching every few seconds would spend somebody's RPC quota
 * to redraw the same numbers. The clock ticks locally; the chain is read on mount and after any
 * write the page itself makes.
 *
 * The failure path is a first-class return rather than a thrown promise: a visitor whose RPC is
 * blocked should be told that, not shown an empty vault.
 */
export function useVault(address: string | null, suffix?: string): VaultRead {
  const [epoch, setEpoch] = useState<EpochInfo | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let live = true;
    // `void`, not `.catch`: the rejection IS handled — inside, into `setError` — and the operator
    // is what tells the linter that the effect deliberately does not await its own body.
    void (async () => {
      try {
        const client = vaultClient({ NETWORK: process.env["NEXT_PUBLIC_NETWORK"] }, suffix);
        const [e, c] = await Promise.all([readEpoch(client), readConfig(client)]);
        if (!live) return;
        setEpoch(e);
        setConfig(c);
        // The position is read separately and its failure is not the page's failure: a visitor with
        // no wallet has no position, and an archived entry is a state the panel renders rather than
        // an error the page reports.
        if (address !== null) {
          const pos = await readPosition(client, address).catch(() => null);
          if (live) setPosition(pos);
        } else {
          setPosition(null);
        }
      } catch (cause) {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      live = false;
    };
    // `suffix` belongs here, and leaving it out is not a lint nit. The picker changed the URL and
    // the highlighted button while every figure on the page stayed the vault you had left — which
    // reads as "these two vaults have identical terms" rather than as a control that did nothing.
    // Measured on the deployed build the day the picker shipped.
  }, [address, nonce, suffix]);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return { epoch, config, position, error, now, reload: () => setNonce((n) => n + 1) };
}
