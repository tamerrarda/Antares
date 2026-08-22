"use client";

import type { EpochInfo } from "@antares/bindings";

import { amount, clockOf, duration } from "../lib/format.ts";

/**
 * The one object on this page no competitor has: Ribbon runs its auction off-chain among
 * whitelisted market makers, and Lusty sets the price itself.
 *
 * Drawn from the round's own snapshotted parameters — linear decay from `premium_start_bps` to
 * `premium_floor_bps` across `auction_duration`. The shaded wedge is the argument: a rational
 * bidder acts only while the asking price is below what the option is worth, and that is a small
 * fraction of the window. Every "why did nothing happen" question this project will be asked is
 * answered by it.
 *
 * Fair value is NOT read from the chain — the contract does not compute one — so it is passed in
 * by the caller or omitted, and when it is omitted the wedge is omitted with it rather than drawn
 * against a guess.
 */
export function AuctionCurve({ epoch, now, fairBps }: { epoch: EpochInfo; now: number; fairBps?: number }) {
  const p = epoch.params;
  const start = p.premium_start_bps;
  const floor = p.premium_floor_bps;
  const span = Number(p.auction_duration);
  const openedAt = Number(epoch.opened_at);
  const elapsed = Math.max(0, Math.min(span, now - openedAt));

  const W = 560;
  const H = 240;
  const L = 6;
  const R = W - 64;
  const TOP = 34;
  const BOT = H - 30;
  const x = (t: number) => L + (t / span) * (R - L);
  const y = (b: number) => BOT - (b / (start * 1.04)) * (BOT - TOP);
  const n = (v: number) => Math.round(v * 10) / 10;

  const bpsAt = (t: number) => start - ((start - floor) * t) / span;
  const crossAt = fairBps === undefined ? null : ((start - fairBps) * span) / (start - floor);
  const remaining = duration(openedAt + span - now);

  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ height: H }}>
      <path
        className="under"
        d={`M ${n(x(0))} ${n(y(start))} L ${n(x(span))} ${n(y(floor))} L ${n(x(span))} ${n(BOT)} L ${n(x(0))} ${n(BOT)} Z`}
      />
      {crossAt !== null && fairBps !== undefined && crossAt < span && (
        <path
          className="live"
          d={`M ${n(x(crossAt))} ${n(y(fairBps))} L ${n(x(span))} ${n(y(fairBps))} L ${n(x(span))} ${n(y(floor))} Z`}
        />
      )}
      <line className="axis" x1={L} y1={n(BOT)} x2={n(R)} y2={n(BOT)} />
      {fairBps !== undefined && (
        <line className="fair" x1={L} y1={n(y(fairBps))} x2={n(R)} y2={n(y(fairBps))} />
      )}
      <path className="line" d={`M ${n(x(0))} ${n(y(start))} L ${n(x(span))} ${n(y(floor))}`} />

      <text x={L} y={n(y(start) - 10)}>
        asking {start} bps · {amount(epoch.notional_offered)} XLM covered
      </text>
      {fairBps !== undefined && (
        <text x={L} y={n(y(fairBps) - 9)}>
          fair value · {fairBps} bps
        </text>
      )}

      <line className="now" x1={n(x(elapsed))} y1={n(TOP)} x2={n(x(elapsed))} y2={n(BOT)} />
      <circle cx={n(x(elapsed))} cy={n(y(bpsAt(elapsed)))} r={4} fill="#ff6b3d" />
      <text className="hot" x={n(x(elapsed) - 10)} y={n(TOP + 10)} textAnchor="end">
        now · {n(bpsAt(elapsed))} bps
      </text>

      <text x={L} y={n(H - 7)}>
        opened {clockOf(openedAt)}
      </text>
      <text x={n(R)} y={n(H - 7)} textAnchor="end">
        {remaining === null ? `closed · floor ${floor} bps` : `${remaining} left · floor ${floor} bps`}
      </text>
    </svg>
  );
}
