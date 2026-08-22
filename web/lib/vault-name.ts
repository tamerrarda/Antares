/**
 * What a vault is called, from its own parameters.
 *
 * Two axes and no jargon: how long money is committed, and how far the price can rise before the
 * depositor stops keeping the gain. `08-OFFCHAIN §3` is explicit that the five instances are
 * compared on those and **never** on `epoch_duration`/`strike_bps_otm` — and that the second axis
 * says "keep the gain", never "sell", because settlement is in cash and the depositor parts with
 * no XLM at all. Teaching "sold" on the one label a person reads while choosing between vaults
 * describes physical settlement, which is precisely what this protocol is not.
 */
export function lengthLabel(seconds: number): string {
  if (seconds >= 86400) {
    const d = Math.round(seconds / 86400);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (seconds >= 3600) {
    const h = Math.round(seconds / 3600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  // Rounding 30 s up to "1 minute" overstates a guarantee. A fast-test instance's window really is
  // half a minute wide, and a page that rounds it is describing a different vault.
  return `${Math.round(seconds)} second${Math.round(seconds) === 1 ? "" : "s"}`;
}

/** "7-day · 3%" — the short form, for a heading or a table cell. */
export function vaultName(epochSeconds: number, otmBps: number): string {
  const s = epochSeconds;
  const length =
    s >= 86400
      ? `${Math.round(s / 86400)}-day`
      : s >= 3600
        ? `${Math.round(s / 3600)}-hour`
        : `${Math.round(s / 60)}-minute`;
  return `${length} · ${otmBps / 100}%`;
}

/** "up to 3% higher" — the cap, said as a depositor experiences it. */
export function capLabel(otmBps: number): string {
  return `up to ${otmBps / 100}% higher`;
}
