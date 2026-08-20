/**
 * wasm.ts — what a contract's bytes say about it, for `09-DEPLOYMENT.md` §2 steps 1, 2 and 4.
 *
 * TWO FACTS, BOTH READ FROM BYTES RATHER THAN FROM OUR SOURCE TREE.
 *
 * **The hash** is D-50's whole gate. The rule is *"the mainnet wasm hashes identically to the
 * audited testnet one"*, and it compares a byte and nothing else — so the value has to be computed
 * from the artefact, both the local one about to be uploaded and, after the deploy, the one the
 * network serves back. `profile-adapter.ts` already does the second half against the live adapter,
 * and its record shows why it matters: the point of fetching the code back is that **anyone can
 * then check the claim without our repository.**
 *
 * **The export surface** is §2 step 2's assertion about the oracle adapter: its exported functions
 * are *"exactly `PriceSource` + `supports_round` + the constructor: **no admin, no upgrade, no
 * setter**"*. `04-ORACLE.md` §1 is the single home for why, and the reason is not hygiene — an
 * adapter with an admin is *"a second, undisclosed trust concentration"*. The vault's whole trust
 * story is that the price it settles against cannot be changed by anyone, and an adapter carrying
 * a setter would make that false while every other document still said it.
 *
 * **The assertion is set equality, not a blocklist.** Naming `set_admin`, `upgrade` and friends
 * would pass an adapter exporting `rotate_feed`, and the list of things somebody might call a
 * setter is not enumerable. What *is* enumerable is the interface the vault calls, so the check is
 * that the adapter exports that and nothing else — a surface that grew is a finding whatever the
 * new function is named.
 */

import { createHash } from "node:crypto";

import { mkCheck, type Check } from "./checks.ts";

export class WasmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmError";
  }
}

/** D-50's value: the SHA-256 of the artefact, hex. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The exported **function** names, parsed off the module's export section.
 *
 * Hand-rolled rather than via `WebAssembly.Module.exports`, for a reason worth stating: the
 * built-in requires the engine to *compile* the module, which is both far more work and a
 * different question. This walks the section headers, reads the one export section and stops —
 * the same walk `profile-adapter.ts` performs against the bytes the network served, so a surface
 * asserted at deploy time and a surface measured later are produced by the same code.
 *
 * Non-function exports (`memory`, globals, tables) are excluded: the claim §2 step 2 makes is
 * about callable entry points.
 */
export function exportedFunctions(bytes: Uint8Array): string[] {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new WasmError("Not a WebAssembly module: the \\0asm magic is missing.");
  }
  const out: string[] = [];
  let i = 8;

  const leb = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (i >= bytes.length) throw new WasmError("Truncated LEB128 length: the module ends mid-number.");
      byte = bytes[i++]!;
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };

  while (i < bytes.length) {
    const id = bytes[i++]!;
    const size = leb();
    const sectionEnd = i + size;
    if (sectionEnd > bytes.length) {
      throw new WasmError(`Section ${id} claims ${size} bytes and the module has fewer.`);
    }
    if (id === 7) {
      const count = leb();
      for (let n = 0; n < count; n += 1) {
        const nameLen = leb();
        const name = new TextDecoder().decode(bytes.subarray(i, i + nameLen));
        i += nameLen;
        const kind = bytes[i++]!;
        leb(); // the index, which we do not need
        if (kind === 0x00) out.push(name);
      }
      // One export section per module; nothing after it changes the answer.
      return out.sort();
    }
    i = sectionEnd;
  }
  return out.sort();
}

// =================================================================================================
// Step 2 — the adapter's surface
// =================================================================================================

/**
 * The functions a `PriceSource` adapter is allowed to export, and every one of them is required.
 *
 * `contracts/price-source-api/src/lib.rs` is the interface's single home; this is that trait plus
 * the constructor Soroban emits. It is a constant rather than something derived from the built
 * wasm on purpose — deriving the expectation from the artefact under test is how a check comes to
 * agree with whatever it was given.
 */
export const ADAPTER_SURFACE = ["__constructor", "reading", "spot_check", "supports_round"] as const;

/**
 * §2 step 2's assertion: the deployed adapter exports exactly the interface and nothing else.
 *
 * Reported as three checks rather than one, because "missing" and "extra" are different failures
 * with different responses — a missing entry point is a wasm that will not serve the vault, and an
 * extra one is a trust concentration nobody disclosed. The second is the one 04-ORACLE §1 is about
 * and the one that must never be waved through as cosmetic.
 */
export function checkAdapterSurface(exports: readonly string[]): Check[] {
  const allowed = new Set<string>(ADAPTER_SURFACE);
  const found = new Set(exports);
  const missing = ADAPTER_SURFACE.filter((n) => !found.has(n));
  const extra = exports.filter((n) => !allowed.has(n));

  return [
    mkCheck(
      "adapter.surface_complete",
      "the adapter exports the whole PriceSource interface",
      [...ADAPTER_SURFACE],
      exports,
      missing.length === 0,
      `Missing: ${missing.join(", ")}. The vault calls these; an adapter without them cannot serve a round.`,
    ),
    mkCheck(
      "adapter.no_extra_exports",
      "the adapter exports nothing beyond the interface — no admin, no upgrade, no setter",
      "(nothing)",
      extra,
      extra.length === 0,
      `Extra: ${extra.join(", ")}. 04-ORACLE §1: an adapter with an admin is a second, undisclosed ` +
        `trust concentration. This is set equality rather than a list of forbidden names, because ` +
        `the things somebody might call a setter are not enumerable and the interface is.`,
    ),
    mkCheck(
      "adapter.surface_exact",
      "the surface is exactly the interface",
      [...ADAPTER_SURFACE],
      exports,
      missing.length === 0 && extra.length === 0,
    ),
  ];
}

/** D-50, stated as a comparison: the bytes about to be uploaded and the bytes the network serves. */
export function checkWasmHash(id: string, localSha: string, onChainSha: string, what: string): Check {
  return mkCheck(
    id,
    what,
    localSha,
    onChainSha,
    localSha === onChainSha,
    "D-50 compares a byte and nothing else. A mismatch means the deployed code is not the code " +
      "that was reviewed, and no amount of matching source proves otherwise.",
  );
}
