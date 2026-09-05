/**
 * The one adapter between `@stellar/stellar-sdk` and the shapes this keeper reads.
 *
 * # Why it is a module and not four lines in `index.ts`
 *
 * It was four lines in `index.ts`, and on 2026-09-05 it forwarded the SDK's `xdr.ScVal` objects
 * where {@link RpcLike} promises `scValToNative` output. That **type-checks** — the interface says
 * `unknown[]`, and `unknown[]` accepts anything — and then turns every event in the stream into
 * `<unnameable>` at `eventName`. It was found by a probe that had to *copy* the adapter in order to
 * exercise it, because `index.ts` runs the keeper at import. A seam that can only be tested by
 * copying it is a seam whose copy will drift, and D-91 is the entry about how that fails.
 *
 * So it lives here: importable, callable from a test or a one-off script, and the only place in the
 * project that knows what the SDK's return types look like.
 */

import { rpc, scValToNative } from "@stellar/stellar-sdk";

import type { RpcLike } from "./events-source.ts";

/**
 * `rpc.Server` narrowed to what the archive reads.
 *
 * The SDK types `getEvents`'s argument as a union — `startLedger` **xor** `cursor`, each forbidding
 * the other — while `RpcLike` states both optional so a test double can be one plain object. The
 * union is the more precise type and this call site is the only code that knows which arm it is
 * in, so the split happens here rather than by loosening `events-source.ts`'s interface to match a
 * vendor's shape it does not otherwise depend on.
 */
export function rpcSource(server: rpc.Server): RpcLike {
  return {
    getHealth: async () => {
      const h = await server.getHealth();
      return { oldestLedger: h.oldestLedger, latestLedger: h.latestLedger };
    },
    getEvents: async (request) => {
      const common = {
        filters: request.filters,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      };
      const res = await (request.cursor === undefined
        ? server.getEvents({ startLedger: request.startLedger ?? 0, ...common })
        : server.getEvents({ cursor: request.cursor, ...common }));
      // `RpcLike` promises native values; the SDK returns `xdr.ScVal`. Converting here is the whole
      // job of an adapter, and forwarding instead type-checks — `unknown[]` accepts anything — and
      // then turns every event in the stream into `<unnameable>` at `eventName`.
      return {
        events: res.events.map((e) => ({
          ...(e.contractId === undefined ? {} : { contractId: e.contractId }),
          topic: e.topic.map((t) => scValToNative(t) as unknown),
          value: scValToNative(e.value) as unknown,
          txHash: e.txHash,
          ledger: e.ledger,
        })),
        latestLedger: res.latestLedger,
        ...(res.cursor === undefined ? {} : { cursor: res.cursor }),
      };
    },
  };
}
