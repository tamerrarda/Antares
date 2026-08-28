"use client";

import { useCallback, useEffect, useState } from "react";

import { instances, type Instance } from "../lib/deployment.ts";

/** The query key the selection lives under. Short, because it ends up in links people paste. */
const KEY = "v";

/**
 * Which vault the page is looking at, kept in the URL rather than in a component.
 *
 * Three instances run side by side and they exist to be compared, so "which one" has to survive
 * being sent to somebody: a bidder who finds A's terms interesting needs a link that opens A, not a
 * link that opens the first vault and an instruction to click twice. It is a query parameter for
 * that reason and not a route, because `output: "export"` prerenders routes at build time and the
 * set of vaults is read from a record that changes without a rebuild.
 *
 * Read from `window` in an effect rather than through `useSearchParams`, which in this Next version
 * forces the whole page under a Suspense boundary to stay statically exportable. The cost is one
 * render at the default before the URL is consulted, which is the same first paint every visitor
 * without a selection gets anyway.
 */
export function useInstance(): {
  readonly all: readonly Instance[];
  readonly current: Instance;
  readonly select: (suffix: string) => void;
} {
  const all = instances();
  const [suffix, setSuffix] = useState<string | null>(null);

  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get(KEY);
    if (asked !== null && all.some((i) => i.tokenSuffix === asked)) setSuffix(asked);
  }, [all]);

  const select = useCallback(
    (next: string) => {
      setSuffix(next);
      const url = new URL(window.location.href);
      // `replaceState`, not `push`: switching vault is changing what you are looking at, not
      // navigating somewhere you would expect Back to undo one step at a time.
      if (next === all[0]?.tokenSuffix) url.searchParams.delete(KEY);
      else url.searchParams.set(KEY, next);
      window.history.replaceState(null, "", url.toString());
    },
    [all],
  );

  const current = all.find((i) => i.tokenSuffix === suffix) ?? all[0]!;
  return { all, current, select };
}
