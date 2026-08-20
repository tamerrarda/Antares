/**
 * Tests for the bindings drift check.
 *
 * The generation itself needs the pinned CLI and is exercised by `pnpm bindings:check` on every
 * gate run. What is tested here is the **judgement** — which of three quite different problems a
 * failure reports — because that is what makes the check actionable rather than merely red.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { failedIds } from "@antares/common/checks";
import {
  checkBindings,
  countMethods,
  newestSource,
  repoRoot,
  type BindingsCheckInput,
} from "../generate-bindings.ts";

const SOURCE = [
  "export class Client {",
  "  deposit: (args: {from: string}) => void = null as never;",
  "  epoch: () => void = null as never;",
  "  config: () => void = null as never;",
  "}",
].join("\n");

const base: BindingsCheckInput = {
  committed: SOURCE,
  regenerated: SOURCE,
  committedProvenance: {
    wasmSha256: "a".repeat(64),
    stellarCli: "27.1.0",
    generatedAt: "",
    methods: 3,
    _what: "",
  },
  localCli: "stellar 27.1.0 (abc)",
  pinnedCli: "27.1.0",
  wasmSha256: "a".repeat(64),
  wasmExports: 4,
  wasmMtimeMs: 2_000,
  newestSource: { path: "contracts/antares-vault/src/vault.rs", mtimeMs: 1_000 },
};

test("committed bindings identical to a fresh generation pass", () => {
  assert.deepEqual(failedIds(checkBindings(base)), []);
});

test("a single changed byte is drift — the comparison is bytes, not a parse", () => {
  // A generator that reorders its output has changed the artefact even when the interface it
  // describes is identical, and pinning is a claim about the artefact.
  const checks = checkBindings({ ...base, regenerated: `${SOURCE}\n` });
  assert.deepEqual(failedIds(checks), ["bindings.no_drift"]);
  assert.match(checks.find((c) => c.id === "bindings.no_drift")!.note!, /worse than no binding/);
});

test("a drift and a CLI mismatch are separate findings, because they are separate problems", () => {
  // The whole point of reporting them apart: 'the contract changed' and 'the generator changed'
  // produce an identical diff and want opposite responses.
  const checks = checkBindings({ ...base, localCli: "stellar 27.0.0 (x)", regenerated: `${SOURCE}\n` });
  assert.deepEqual(failedIds(checks), ["bindings.generator_pinned", "bindings.no_drift"]);
});

test("missing bindings are reported as missing and nothing further is claimed about them", () => {
  const checks = checkBindings({ ...base, committed: null });
  assert.deepEqual(failedIds(checks), ["bindings.present"]);
  // No drift or surface verdict on a file that does not exist — those would be findings about
  // nothing, and a reader would go looking for a cause.
  assert.equal(
    checks.some((c) => c.id === "bindings.no_drift"),
    false,
  );
  assert.equal(
    checks.some((c) => c.id === "bindings.surface"),
    false,
  );
});

test("the surface is counted against the wasm's exports, not against a document's sentence", () => {
  // 42 entry points = 41 callable + __constructor, which the client exposes as a static `deploy`.
  const checks = checkBindings({ ...base, wasmExports: 9 });
  assert.deepEqual(failedIds(checks), ["bindings.surface"]);
  const c = checks.find((x) => x.id === "bindings.surface")!;
  assert.equal(c.expected, 8);
  assert.equal(c.actual, 3);
});

test("a recorded wasm that is not the one built is its own finding", () => {
  const checks = checkBindings({ ...base, wasmSha256: "b".repeat(64) });
  assert.deepEqual(failedIds(checks), ["bindings.wasm_recorded"]);
});

// --- the precondition, which is the one that decides whether the rest means anything -------------
//
// Every assertion above compares against a wasm READ OFF THE DISK. If that artefact predates the
// contract, all of them can pass while describing a build nobody ships — measured on 2026-08-20,
// when this check reported five green assertions against a `vault.rs` that had since changed.

test("a wasm older than a source that can change it is refused", () => {
  const checks = checkBindings({ ...base, wasmMtimeMs: 500 });
  assert.deepEqual(failedIds(checks), ["bindings.wasm_fresh"]);
});

test("equal mtimes pass — a build is not stale for finishing in the same millisecond", () => {
  assert.deepEqual(failedIds(checkBindings({ ...base, wasmMtimeMs: 1_000 })), []);
});

test("with no sources to compare against, freshness is not claimed either way", () => {
  const checks = checkBindings({ ...base, newestSource: null, wasmMtimeMs: 0 });
  assert.deepEqual(failedIds(checks), []);
  const fresh = checks.find((c) => c.id === "bindings.wasm_fresh");
  assert.match(String(fresh?.expected), /no contract sources/);
});

test("staleness is reported separately from drift, because the fixes differ", () => {
  // Stale wasm AND a hand edit: `stellar contract build` fixes one and `bindings:write` the
  // other, and a reader who sees only one of them applies the wrong remedy.
  const checks = checkBindings({ ...base, wasmMtimeMs: 500, regenerated: `${SOURCE}\n` });
  assert.deepEqual(failedIds(checks).sort(), ["bindings.no_drift", "bindings.wasm_fresh"]);
});

test("newestSource finds the contract sources it claims to, and never looks in target/", () => {
  const newest = newestSource(repoRoot());
  if (newest === null) throw new Error("contracts/ has sources; finding none means the walk is broken");
  assert.doesNotMatch(newest.path, /[/\\]target[/\\]/);
  assert.match(newest.path, /\.(rs|toml|lock)$/);
});

test("countMethods counts client methods and not the noise around them", () => {
  assert.equal(countMethods(SOURCE), 3);
  assert.equal(countMethods(""), 0);
  // Indentation is the discriminator: nested object literals and top-level declarations are not
  // methods, and a looser match would inflate the surface count into always agreeing.
  assert.equal(countMethods("  deposit: (a) => void\n      nested: (b) => void\ntop: (c) => void"), 1);
});
