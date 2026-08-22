"use client";

import type { EpochInfo, Position } from "@antares/bindings";
import { useEffect, useState } from "react";

import { instances, type Instance } from "../lib/deployment.ts";
import { clientFor, readPosition } from "../lib/vault.ts";

export interface FleetRow {
  readonly instance: Instance;
  readonly epoch: EpochInfo | null;
  readonly position: Position | null;
  readonly error: string | null;
}

/**
 * Every deployed vault, read together.
 *
 * One instance's failure is not the page's failure — a node that times out on the third vault
 * should not blank the two that answered. So each row carries its own error and the page renders
 * around it.
 */
export function useFleet(address: string | null): { rows: readonly FleetRow[]; loading: boolean } {
  const [rows, setRows] = useState<readonly FleetRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void (async () => {
      const env = { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] };
      const out = await Promise.all(
        instances().map(async (instance): Promise<FleetRow> => {
          try {
            const client = clientFor(instance.vaultId, env);
            const epoch = (await client.epoch()).result;
            const position = address === null ? null : await readPosition(client, address).catch(() => null);
            return { instance, epoch, position, error: null };
          } catch (cause) {
            return {
              instance,
              epoch: null,
              position: null,
              error: cause instanceof Error ? cause.message : String(cause),
            };
          }
        }),
      );
      if (live) {
        setRows(out);
        setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [address]);

  return { rows, loading };
}
