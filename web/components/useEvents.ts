"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchEvents, type EventPage } from "../lib/events.ts";

/**
 * The vault's event history, read once.
 *
 * The read costs about a dozen RPC round-trips because `getEvents` scans forward in ~10 000-ledger
 * pages and the retention window is seven days of them. That is a few seconds, and it is why this
 * is not on a timer: the history only changes when a round ends.
 */
export function useEvents(): { page: EventPage | null; error: string | null; reload: () => void } {
  const [page, setPage] = useState<EventPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const p = await fetchEvents({ NETWORK: process.env["NEXT_PUBLIC_NETWORK"] });
        if (live) setPage(p);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, [nonce]);

  return {
    page,
    error,
    reload: useCallback(() => {
      setError(null);
      setPage(null);
      setNonce((n) => n + 1);
    }, []),
  };
}
