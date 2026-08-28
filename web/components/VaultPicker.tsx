"use client";

import { vaultName } from "../lib/vault-name.ts";
import type { Instance } from "../lib/deployment.ts";

/**
 * Which of the running vaults this page is about.
 *
 * Rendered only when there is more than one, because a chooser with a single option is furniture
 * that teaches nothing. The label is each vault's own terms rather than its letter: `-A` means
 * nothing to a reader, "7-day · 3%" is the entire difference between the instances and the only
 * thing worth choosing between.
 */
export function VaultPicker({
  all,
  current,
  onSelect,
}: {
  all: readonly Instance[];
  current: Instance;
  onSelect: (suffix: string) => void;
}) {
  if (all.length < 2) return null;
  return (
    <div className="picker" role="group" aria-label="Which vault">
      {all.map((i) => {
        const here = i.tokenSuffix === current.tokenSuffix;
        return (
          <button
            key={i.tokenSuffix}
            type="button"
            className={here ? "pill hot" : "pill"}
            aria-current={here ? "true" : undefined}
            onClick={() => onSelect(i.tokenSuffix)}
          >
            {vaultName(i.epochDuration, i.strikeBpsOtm)}
          </button>
        );
      })}
    </div>
  );
}
