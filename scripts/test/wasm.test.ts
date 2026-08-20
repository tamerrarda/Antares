/**
 * Tests for `09-DEPLOYMENT.md` §2 steps 1 and 2 — the wasm hash and the adapter's export surface.
 *
 * Two kinds of fixture, deliberately. **Synthetic modules** exercise the parser's edges, including
 * the ones no real artefact would ever show it: a truncated section, a multi-byte length, a
 * non-function export. **The repository's own built artefacts** exercise it against reality, and
 * one of them is the point of the whole file — `mock-price-source` exports eight setters, so a
 * surface check that cannot refuse it is a surface check that does nothing.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";

import { failedIds } from "@antares/common/checks";
import {
  ADAPTER_SURFACE,
  WasmError,
  checkAdapterSurface,
  checkWasmHash,
  exportedFunctions,
  sha256,
} from "../lib/wasm.ts";

// =================================================================================================
// Synthetic modules
// =================================================================================================

function leb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

/** A minimal module carrying one export section. `kind` 0 is a function, 2 a memory. */
function synth(exports: readonly (readonly [string, number])[], extra: readonly number[] = []): Uint8Array {
  const body: number[] = [...leb(exports.length)];
  for (const [name, kind] of exports) {
    const bytes = [...new TextEncoder().encode(name)];
    body.push(...leb(bytes.length), ...bytes, kind, 0);
  }
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0, ...extra, 7, ...leb(body.length), ...body]);
}

test("the parser reads function exports and sorts them", () => {
  assert.deepEqual(
    exportedFunctions(
      synth([
        ["spot_check", 0],
        ["reading", 0],
        ["__constructor", 0],
      ]),
    ),
    ["__constructor", "reading", "spot_check"],
  );
});

test("non-function exports are excluded — the claim is about callable entry points", () => {
  assert.deepEqual(
    exportedFunctions(
      synth([
        ["memory", 2],
        ["reading", 0],
        ["__table", 1],
      ]),
    ),
    ["reading"],
  );
});

test("a section before the export section is skipped rather than misread", () => {
  // A custom section (id 0) of four bytes sitting where the walk starts.
  assert.deepEqual(exportedFunctions(synth([["reading", 0]], [0, 4, 1, 2, 3, 4])), ["reading"]);
});

test("a name longer than 127 bytes is read — the length is LEB128, not a byte", () => {
  const long = "f".repeat(200);
  assert.deepEqual(exportedFunctions(synth([[long, 0]])), [long]);
});

test("bytes that are not a module are refused, not parsed into nonsense", () => {
  assert.throws(() => exportedFunctions(Uint8Array.from([1, 2, 3])), WasmError);
  assert.throws(
    () => exportedFunctions(Uint8Array.from([0x00, 0x61, 0x73, 0x00, 1, 0, 0, 0])),
    /magic is missing/,
  );
});

test("a section claiming more bytes than the module has is refused", () => {
  const m = synth([["reading", 0]]);
  const truncated = m.subarray(0, m.length - 3);
  assert.throws(() => exportedFunctions(truncated), /has fewer|ends mid-number/);
});

test("a module with no export section yields nothing rather than throwing", () => {
  assert.deepEqual(exportedFunctions(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0])), []);
});

// =================================================================================================
// The surface assertion
// =================================================================================================

test("exactly the interface passes", () => {
  assert.deepEqual(failedIds(checkAdapterSurface([...ADAPTER_SURFACE])), []);
});

test("a missing entry point and an extra one are separate failures", () => {
  const missing = checkAdapterSurface(ADAPTER_SURFACE.filter((n) => n !== "spot_check"));
  assert.deepEqual(failedIds(missing), ["adapter.surface_complete", "adapter.surface_exact"]);

  const extra = checkAdapterSurface([...ADAPTER_SURFACE, "set_admin"]);
  assert.deepEqual(failedIds(extra), ["adapter.no_extra_exports", "adapter.surface_exact"]);
  assert.match(extra.find((c) => c.id === "adapter.no_extra_exports")!.note!, /Extra: set_admin/);
});

test("a setter nobody thought to blocklist is still refused — this is why it is set equality", () => {
  // `rotate_feed` appears on no list of forbidden names, and it would let whoever holds the key
  // change the price the vault settles against. 04-ORACLE §1's second trust concentration.
  const checks = checkAdapterSurface([...ADAPTER_SURFACE, "rotate_feed"]);
  assert.deepEqual(failedIds(checks), ["adapter.no_extra_exports", "adapter.surface_exact"]);
});

test("an empty surface fails as missing rather than passing for having no extras", () => {
  assert.deepEqual(failedIds(checkAdapterSurface([])), ["adapter.surface_complete", "adapter.surface_exact"]);
});

test("checkWasmHash states D-50 as a comparison", () => {
  assert.equal(checkWasmHash("x", "aa", "aa", "w").ok, true);
  const bad = checkWasmHash("x", "aa", "bb", "w");
  assert.equal(bad.ok, false);
  assert.match(bad.note!, /compares a byte/);
});

// =================================================================================================
// The repository's own artefacts
// =================================================================================================

const WASM_DIR = new URL("../../target/wasm32v1-none/release/", import.meta.url).pathname;
const built = (name: string): string => `${WASM_DIR}${name}.wasm`;

test("the real adapter's surface is exactly the interface", (t) => {
  if (!existsSync(built("reflector_adapter"))) {
    t.skip("reflector_adapter.wasm is not built — run `stellar contract build` (09-DEPLOYMENT §2 step 1)");
    return;
  }
  const exports = exportedFunctions(readFileSync(built("reflector_adapter")));
  assert.deepEqual(exports, [...ADAPTER_SURFACE]);
  assert.deepEqual(failedIds(checkAdapterSurface(exports)), []);
});

test("mock-price-source is REFUSED by the surface check, and that is the check working", (t) => {
  // The mock exports eight setters, because a mock is for driving a test. §2 step 2 admits it only
  // for `--fast-test` profiles, and this is the mechanical reason those profiles can never be
  // presented as anything but mechanism testing: the adapter behind them fails 04-ORACLE §1.
  if (!existsSync(built("mock_price_source"))) {
    t.skip("mock_price_source.wasm is not built — run `stellar contract build`");
    return;
  }
  const exports = exportedFunctions(readFileSync(built("mock_price_source")));
  const checks = checkAdapterSurface(exports);
  assert.deepEqual(failedIds(checks), ["adapter.no_extra_exports", "adapter.surface_exact"]);
  assert.match(checks.find((c) => c.id === "adapter.no_extra_exports")!.note!, /set_price/);
});

test("the local adapter build is byte-identical to the wasm serving on testnet (D-50)", (t) => {
  const record = new URL("../../deployments/adapter-testnet.json", import.meta.url).pathname;
  if (!existsSync(built("reflector_adapter")) || !existsSync(record)) {
    t.skip("needs both the built adapter and deployments/adapter-testnet.json");
    return;
  }
  const recorded = JSON.parse(readFileSync(record, "utf8")) as {
    deployment: { wasmSha256OnChain: string };
  };
  // Not a tautology: the recorded hash was measured by fetching the code back off the network
  // (profile-adapter.ts), and this one is computed from bytes this checkout produced. Equal means
  // D-50's gate holds end to end for the artefact actually serving.
  assert.equal(
    sha256(readFileSync(built("reflector_adapter"))),
    recorded.deployment.wasmSha256OnChain,
    "the local build no longer reproduces the deployed adapter — D-50's gate is red",
  );
});
