/**
 * Sampling the feed σ_realized is computed from.
 *
 * The keeper reads the **same Reflector CEX & DEX feed the round settles against** (D-67) — not a
 * second source that happens to quote XLM. A σ measured against a different feed would be a
 * statement about a price the contract never saw, and the gate it feeds is published as evidence.
 *
 * # Why this samples as the epoch runs rather than fetching afterwards
 *
 * Reflector retains `RECORD_CAP_TICKS` ticks — measured at 255, so ~21 h 15 m at the shipped 300 s
 * resolution (D-69). An epoch is 3 to 14 days. **A multi-day series therefore cannot be
 * reconstructed after the fact**: by expiry the opening ticks are gone from the feed and no amount
 * of care afterwards brings them back. That is the whole reason this duty sits in a long-running
 * service instead of a script someone runs at settlement.
 *
 * Everything here is a read-only `simulateTransaction`. Nothing signs.
 */

import { Contract, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

import { RECORD_CAP_TICKS, reachSeconds } from "@antares/common/oracle";

import type { Sample } from "./sigma.ts";

// RECORD_CAP_TICKS was defined here, in scripts/profile-adapter.ts and in scripts/verify-environment.ts
// — three copies of one measured fact. DEV2 found the third and made the placement argument: the
// duplication spans two packages, so packages/common is the only home that serves both. Re-exported
// rather than dropped so this module's existing consumers do not have to move with it.
export { RECORD_CAP_TICKS };

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

export interface FeedConfig {
  /** Reflector's contract id — the one the adapter is pinned to. */
  readonly feedId: string;
  /** `Asset::Other(SYMBOL)`; XLM on this feed is `Other("XLM")`, verified live in Phase 1 (D-30). */
  readonly assetSymbol: string;
}

export interface FeedShape {
  /** Seconds per tick, read live. D-58: nothing downstream may hold a copy of this. */
  readonly resolution: number;
  /** The feed's own scale. A change mid-epoch invalidates a series rather than rescaling it. */
  readonly decimals: number;
  /** Newest tick the feed has published. */
  readonly lastTimestamp: number;
}

/** A read-only view of one Reflector instance. Signs nothing, holds no key. */
export class Feed {
  readonly #server: rpc.Server;
  readonly #contract: Contract;
  readonly #source: Awaited<ReturnType<rpc.Server["getAccount"]>>;
  readonly #passphrase: string;
  readonly #asset: xdr.ScVal;

  constructor(
    server: rpc.Server,
    source: Awaited<ReturnType<rpc.Server["getAccount"]>>,
    passphrase: string,
    config: FeedConfig,
  ) {
    this.#server = server;
    this.#source = source;
    this.#passphrase = passphrase;
    this.#contract = new Contract(config.feedId);
    this.#asset = xdr.ScVal.scvVec([
      nativeToScVal("Other", { type: "symbol" }),
      nativeToScVal(config.assetSymbol, { type: "symbol" }),
    ]);
  }

  async #call(fn: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(this.#source, {
      fee: "10000000",
      networkPassphrase: this.#passphrase,
    })
      .addOperation(this.#contract.call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.#server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new FeedError(`${fn} did not simulate: ${sim.error}`);
    }
    return sim.result === undefined ? null : scValToNative(sim.result.retval);
  }

  /** Resolution, decimals and the newest tick — all live, none cached (D-58, D-49). */
  async shape(): Promise<FeedShape> {
    const [res, dec, last] = await Promise.all([
      this.#call("resolution"),
      this.#call("decimals"),
      this.#call("last_timestamp"),
    ]);
    const resolution = Number(res);
    const decimals = Number(dec);
    const lastTimestamp = Number(last);
    if (!Number.isFinite(resolution) || resolution <= 0) {
      throw new FeedError(`the feed reported resolution ${String(res)}, which is not a grid`);
    }
    if (!Number.isFinite(decimals) || decimals < 0) {
      throw new FeedError(`the feed reported decimals ${String(dec)}`);
    }
    return { resolution, decimals, lastTimestamp };
  }

  /** Seconds of history the feed still holds — `RECORD_CAP_TICKS × resolution` (D-69). */
  static reachableDepth(resolution: number): number {
    return reachSeconds(resolution);
  }

  /**
   * The price at one tick, or `null` where the feed has no record.
   *
   * A missing tick is an ordinary answer, not an error: the gap rule in `sigma.ts` is what decides
   * what it means for the estimate.
   */
  async priceAt(ts: number): Promise<number | null> {
    const v = await this.#call("price", this.#asset, nativeToScVal(ts, { type: "u64" }));
    if (v === null || v === undefined) return null;
    const record = v as { price?: unknown };
    const raw = record.price;
    if (raw === undefined || raw === null) return null;
    const price = Number(raw);
    // Raw integers at 14 decimals sit around 1.6e13, well inside a double's exact range (2^53).
    // Kept unscaled on purpose: σ takes ratios, so the scale cancels, and dividing by 10^decimals
    // would introduce a rounding step that serves nothing.
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  }

  /**
   * Every tick in `[from, to]` that the feed still holds, sampled on its own grid.
   *
   * Sequential rather than parallel: this is a shared public RPC, and a keeper that fans out 255
   * simulations at once is the reason the next person gets rate-limited. The loop is bounded by the
   * reachable depth, so the worst case is ~255 calls.
   */
  async sampleRange(from: number, to: number, resolution: number): Promise<Sample[]> {
    if (resolution <= 0) throw new FeedError(`resolution must be positive, got ${resolution}`);
    const start = Math.ceil(from / resolution) * resolution;
    const samples: Sample[] = [];
    for (let ts = start; ts <= to; ts += resolution) {
      const price = await this.priceAt(ts);
      if (price !== null) samples.push({ ts, price });
    }
    return samples;
  }
}
