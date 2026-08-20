/**
 * Tests for `09-DEPLOYMENT.md` §2 step 0.
 *
 * The pins are read from real files, so the fixtures below are real files: each test writes a
 * temporary repository root with the three pin files in it and reads them back. Faking `readPins`
 * would leave the parsing — which is the part that can be wrong — untested, and the parsing is
 * hand-rolled precisely so that an unrecognised shape refuses rather than returning `undefined`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failedIds } from "@antares/common/checks";
import {
  REQUIRED_TARGET,
  ToolchainError,
  checkToolchain,
  exactRequirement,
  parseVersion,
  readPins,
  type Observed,
} from "../lib/toolchain.ts";

const RUST_TOOLCHAIN = `[toolchain]
channel = "1.95.0"
components = ["rustfmt", "clippy"]
targets = ["wasm32v1-none"]
profile = "minimal"
`;

const CARGO = `[workspace]
members = ["contracts/*"]

[workspace.dependencies]
soroban-sdk = "=27.0.6"

[profile.release]
opt-level = "z"
overflow-checks = true

[profile.dev]
overflow-checks = true
`;

const CI = `env:
  STELLAR_CLI_VERSION: "27.1.0"
  STELLAR_CLI_SHA256: "9915fe63"
`;

/** Write a repository root carrying the three pin files, each optionally overridden. */
function pinRoot(over: { toolchain?: string; cargo?: string; ci?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "antares-pins-"));
  writeFileSync(join(root, "rust-toolchain.toml"), over.toolchain ?? RUST_TOOLCHAIN);
  writeFileSync(join(root, "Cargo.toml"), over.cargo ?? CARGO);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), over.ci ?? CI);
  return root;
}

const HEALTHY: Observed = {
  rustc: "rustc 1.95.0 (59807616e 2026-04-14)",
  stellar: "stellar 27.1.0 (8e402ea28202950b272fbabc34caad4d2f64fe87)",
  installedTargets: ["aarch64-apple-darwin", "wasm32v1-none"],
};

// =================================================================================================
// Reading the pins
// =================================================================================================

test("every pin is read from the file that owns it", () => {
  const pins = readPins(pinRoot());
  assert.equal(pins.rust, "1.95.0");
  assert.deepEqual(pins.targets, ["wasm32v1-none"]);
  assert.equal(pins.sorobanSdk, "=27.0.6");
  assert.equal(pins.stellarCli, "27.1.0");
  assert.deepEqual(pins.overflowChecks, { release: true, dev: true });
  // A failure has to name a file to edit, not a value to argue with.
  assert.match(pins.sources["stellarCli"]!, /ci\.yml$/);
  assert.match(pins.sources["rust"]!, /rust-toolchain\.toml$/);
});

test("this repository's own pins parse — the fixtures are not the only thing that works", () => {
  const pins = readPins(new URL("../..", import.meta.url).pathname.replace(/\/$/, ""));
  assert.match(pins.rust, /^\d+\.\d+\.\d+$/);
  assert.ok(pins.targets.includes(REQUIRED_TARGET));
  assert.match(pins.sorobanSdk, /^=/);
  assert.match(pins.stellarCli, /^\d+\.\d+\.\d+$/);
  assert.ok(Object.keys(pins.overflowChecks).length > 0);
});

test("a missing pin file refuses and names what lived there", () => {
  assert.throws(
    () => readPins(join(tmpdir(), "antares-no-such-root-9e1f")),
    (e: unknown) => e instanceof ToolchainError && /where D-23 pins/.test(e.message),
  );
});

test('a channel of "stable" is refused — D-50 cannot consume a moving channel', () => {
  assert.throws(
    () => readPins(pinRoot({ toolchain: '[toolchain]\nchannel = "stable"\n' })),
    /not an exact version/,
  );
});

test("a Cargo.toml with no workspace soroban-sdk refuses", () => {
  assert.throws(() => readPins(pinRoot({ cargo: "[workspace]\n" })), /no workspace soroban-sdk/);
});

test("a CI workflow with no STELLAR_CLI_VERSION refuses rather than defaulting", () => {
  assert.throws(() => readPins(pinRoot({ ci: "env:\n  OTHER: 1\n" })), /no STELLAR_CLI_VERSION/);
});

test("overflow-checks is attributed to the right profile, and a later table does not leak in", () => {
  const cargo = `[workspace.dependencies]
soroban-sdk = "=27.0.6"

[profile.release]
overflow-checks = true

[profile.bench]
opt-level = 3

[workspace.metadata]
overflow-checks = false
`;
  const pins = readPins(pinRoot({ cargo }));
  // `bench` declares none, so it is absent rather than false; the non-profile table is ignored.
  assert.deepEqual(pins.overflowChecks, { release: true });
});

// =================================================================================================
// The gate, in both directions
// =================================================================================================

test("a machine matching every pin passes step 0", () => {
  assert.deepEqual(failedIds(checkToolchain(readPins(pinRoot()), HEALTHY)), []);
});

test("a rustc one patch off fails — D-50 compares a byte", () => {
  const checks = checkToolchain(readPins(pinRoot()), {
    ...HEALTHY,
    rustc: "rustc 1.95.1 (abcdef012 2026-05-01)",
  });
  assert.deepEqual(failedIds(checks), ["toolchain.rustc"]);
  const c = checks.find((x) => x.id === "toolchain.rustc")!;
  assert.equal(c.actual, "1.95.1");
  assert.match(c.note!, /rustup toolchain install 1\.95\.0/);
});

test("a stellar-cli off the CI pin fails, and the note names the file CI reads", () => {
  const checks = checkToolchain(readPins(pinRoot()), {
    ...HEALTHY,
    stellar: "stellar 27.0.0 (deadbeef)",
  });
  assert.deepEqual(failedIds(checks), ["toolchain.stellar_cli"]);
  assert.match(checks.find((x) => x.id === "toolchain.stellar_cli")!.note!, /ci\.yml/);
});

test("a stellar-cli that is not installed fails with what actually answered, not a stack trace", () => {
  const checks = checkToolchain(readPins(pinRoot()), { ...HEALTHY, stellar: "(not installed)" });
  assert.deepEqual(failedIds(checks), ["toolchain.stellar_cli"]);
  assert.equal(checks.find((x) => x.id === "toolchain.stellar_cli")!.actual, "(not installed)");
});

test("the target being pinned and the target being installed are separate failures", () => {
  // Pinned but not installed: a fresh checkout obeys the file; this machine has not run rustup.
  assert.deepEqual(
    failedIds(
      checkToolchain(readPins(pinRoot()), { ...HEALTHY, installedTargets: ["aarch64-apple-darwin"] }),
    ),
    ["toolchain.target_installed"],
  );
  // Installed but not pinned: builds here, and a fresh checkout would build something else.
  const stale = '[toolchain]\nchannel = "1.95.0"\ntargets = ["wasm32-unknown-unknown"]\n';
  assert.deepEqual(failedIds(checkToolchain(readPins(pinRoot({ toolchain: stale })), HEALTHY)), [
    "toolchain.target_pinned",
  ]);
});

test("a caret on soroban-sdk fails — a patch release changes the wasm", () => {
  const cargo = CARGO.replace('soroban-sdk = "=27.0.6"', 'soroban-sdk = "^27.0.6"');
  assert.deepEqual(failedIds(checkToolchain(readPins(pinRoot({ cargo })), HEALTHY)), [
    "toolchain.soroban_sdk_exact",
  ]);
});

test("a profile with overflow-checks off fails, and the failure names it", () => {
  const cargo = CARGO.replace(
    "[profile.dev]\noverflow-checks = true",
    "[profile.dev]\noverflow-checks = false",
  );
  const checks = checkToolchain(readPins(pinRoot({ cargo })), HEALTHY);
  assert.deepEqual(failedIds(checks), ["toolchain.overflow_checks"]);
  assert.match(checks.find((x) => x.id === "toolchain.overflow_checks")!.note!, /Profiles with it off: dev/);
});

test("a Cargo.toml that declares no profile at all fails rather than passing vacuously", () => {
  // The empty-set trap: "every profile sets it" is true of no profiles, and that is exactly the
  // state in which nothing is checked.
  const cargo = '[workspace.dependencies]\nsoroban-sdk = "=27.0.6"\n';
  const checks = checkToolchain(readPins(pinRoot({ cargo })), HEALTHY);
  assert.deepEqual(failedIds(checks), ["toolchain.overflow_checks"]);
  assert.match(checks.find((x) => x.id === "toolchain.overflow_checks")!.note!, /declares no \[profile/);
});

// =================================================================================================
// The two parsers
// =================================================================================================

test("parseVersion reads the banners both tools actually print", () => {
  assert.equal(parseVersion("rustc 1.95.0 (59807616e 2026-04-14)"), "1.95.0");
  assert.equal(parseVersion("stellar 27.1.0 (8e402ea28202950b272fbabc34caad4d2f64fe87)"), "27.1.0");
  // stellar --version prints several lines; only the first is the tool's own version.
  assert.equal(parseVersion("stellar 27.1.0 (abc)\nsoroban-env 22.0.0\n"), "27.1.0");
  assert.equal(parseVersion("(not installed)"), null);
  assert.equal(parseVersion(""), null);
});

test("exactRequirement admits only an exact pin", () => {
  assert.equal(exactRequirement("=27.0.6"), "27.0.6");
  assert.equal(exactRequirement(" = 27.0.6 "), "27.0.6");
  assert.equal(exactRequirement("^27.0.6"), null);
  assert.equal(exactRequirement("27.0.6"), null);
  assert.equal(exactRequirement(">=27.0.6, <28"), null);
});
