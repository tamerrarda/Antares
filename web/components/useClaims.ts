"use client";

import { useCallback, useEffect, useState } from "react";

import { readClaims, type ClaimsRead } from "../lib/claims.ts";
import { readEpoch, vaultClient } from "../lib/vault.ts";

/**
 * One bidder's fills, round by round.
 *
 * Deliberately independent of the event window. `bidder_position` is a view, so this answers for
 * every round the contract still holds — which is the whole reason 08-OFFCHAIN §3's warning about
 * a bidder "who looked a round late" finding an empty page does not apply here.
 */
export function useClaims(bidder: string | null): {
  data: ClaimsRead | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<ClaimsRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (bidder === null) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    void (async () => {
      try {
        const env = { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] };
        const epoch = await readEpoch(vaultClient(env));
        const out = await readClaims(bidder, epoch.round, env);
        if (live) setData(out);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [bidder, nonce]);

  return { data, loading, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}
