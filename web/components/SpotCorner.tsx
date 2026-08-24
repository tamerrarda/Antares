"use client";

import { useEffect, useState } from "react";

import { deployment } from "../lib/deployment.ts";
import { readConfig, readSpot, vaultClient } from "../lib/vault.ts";

/**
 * What the vault's own oracle says the underlying is worth, in the header.
 *
 * **Not a market ticker, and the difference is the reason this is here at all.** The price shown is
 * read from `Config.oracle` — the contract this vault will actually consult when it sets a strike
 * and when it settles. On a real deployment that is Reflector's aggregated CEX & DEX feed, so the
 * number *is* the market. On a fast-test instance it is the mock, and then this shows whatever the
 * mock shows: a corner that quietly substituted a real exchange price would be telling a depositor
 * their strike comes from somewhere it does not.
 *
 * **And it says so, in the corner, not in a tooltip.** The first version did not, and read as a
 * market price while showing a number somebody had typed into a mock an hour earlier — caught on
 * 2026-08-24 by the first person to look at it who knew what XLM was worth. `deployment.ts` already
 * states the rule this broke: *"a UI that renders a fast-test round without saying so is doing
 * exactly that presentation."* Nobody reads a `title` attribute; the marker has to be on screen.
 *
 * **A dash is a real state.** `reading()` answers `Unusable` or `OutOfReach` when the window it
 * needs is not there, which is exactly what settlement would meet, and there is no honest number to
 * put in its place. Hovering says which.
 *
 * Thirty seconds, not one: this is a simulation against a public RPC, the underlying TWAP is a
 * fifteen-minute average on a real deployment, and a per-second ticker would be animating precision
 * the number does not have.
 */
const REFRESH_MS = 30_000;
const PRECISION = 10_000_000;

export function SpotCorner() {
  const [spot, setSpot] = useState<bigint | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const env = { NETWORK: process.env["NEXT_PUBLIC_NETWORK"] };
        const config = await readConfig(vaultClient(env));
        const price = await readSpot(config, env);
        if (live) {
          setSpot(price);
          setAsked(true);
        }
      } catch {
        // A failed read is the same to a reader as an unusable window: no price. The vault page
        // reports chain failures properly; the header is not the place to say it twice.
        if (live) {
          setSpot(null);
          setAsked(true);
        }
      }
    };
    void read();
    const id = setInterval(() => void read(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (!asked) return null;

  // Not "is this a test network" — this vault's oracle specifically. A real instance on testnet
  // reads the live feed and its number needs no qualifier.
  const mock = deployment().economicallyMeaningless;

  return (
    <span
      className="price"
      title={
        spot === null
          ? "This vault's oracle has no usable price right now — the window it reads is unusable or out of reach. Settlement would meet the same answer."
          : mock
            ? "Not a market price. This is a fast-test instance, so its oracle is a mock and this number is whatever was put into it — the same number that would set its strike."
            : "Read from this vault's own oracle: Reflector's aggregated CEX & DEX feed, the contract that sets its strike and decides its settlement."
      }
    >
      XLM {spot === null ? <b aria-label="no price">—</b> : <b>${(Number(spot) / PRECISION).toFixed(4)}</b>}
      {mock && spot !== null && <em> · mock</em>}
    </span>
  );
}
