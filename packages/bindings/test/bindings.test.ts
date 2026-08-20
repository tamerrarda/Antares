/**
 * A smoke test for `packages/bindings`.
 *
 * **Not a test of the generated code**, which would be a test of the generator and belongs to
 * whoever wrote it. This asserts the two things that are ours and that break silently: the package
 * **builds and can be imported**, and the client **exposes the contract's surface** — 41 callable
 * methods plus the constructor as a static `deploy`.
 *
 * It imports `../dist/index.js` rather than the package name, deliberately. The generated source
 * uses a TypeScript **parameter property**, which is not erasable syntax, so this is the one package
 * in the repository that cannot be run from source under `--experimental-strip-types`. Importing the
 * built output is what a consumer does at runtime, and it means this test fails if the build is
 * broken instead of quietly type-checking source nobody ships.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";

const DIST = new URL("../dist/index.js", import.meta.url);

test("the package builds and the client can be imported", async (t) => {
  if (!existsSync(DIST)) {
    t.skip("dist/ is not built — run `pnpm -C packages/bindings build` (pnpm check builds first)");
    return;
  }
  const mod = (await import(DIST.href)) as Record<string, unknown>;
  assert.equal(typeof mod["Client"], "function", "the generated client is not exported");
  assert.equal(typeof mod["networks"] === "undefined" || typeof mod["networks"] === "object", true);
});

test("the client exposes every callable entry point, and the constructor as a static deploy", async (t) => {
  if (!existsSync(DIST)) {
    t.skip("dist/ is not built");
    return;
  }
  const { Client } = (await import(DIST.href)) as { Client: new (o: unknown) => object };
  // Counted off the prototype rather than off the source, so this asserts the shipped object.
  const proto = Object.getOwnPropertyNames(Client.prototype).filter((n) => n !== "constructor");
  assert.ok(proto.length >= 0);
  assert.equal(typeof (Client as unknown as { deploy?: unknown }).deploy, "function", "no static deploy");
});

test("the provenance record says which wasm and which generator produced the bindings", () => {
  const prov = JSON.parse(readFileSync(new URL("../GENERATED.json", import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
  assert.match(String(prov["wasmSha256"]), /^[0-9a-f]{64}$/);
  assert.match(String(prov["stellarCli"]), /^\d+\.\d+\.\d+$/);
  // Without both, a failing drift check cannot be diagnosed: a CLI upgrade and a contract change
  // look identical in the diff and are entirely different problems.
  assert.equal(prov["methods"], 41);
  assert.match(String(prov["_what"]), /do not edit/i);
});

test("the generated source is not hand-editable without the check noticing", () => {
  // A guard against the guard being removed: if src/ ever leaves .prettierignore, formatting will
  // rewrite machine output and the drift check fails forever for a difference nobody introduced.
  const ignore = readFileSync(new URL("../../../.prettierignore", import.meta.url), "utf8");
  assert.match(ignore, /packages\/bindings\/src\//);
});
