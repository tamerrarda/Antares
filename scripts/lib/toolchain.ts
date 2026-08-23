/**
 * toolchain.ts — `09-DEPLOYMENT.md` §2 **step 0**, the toolchain gate.
 *
 * **THE STEP'S OWN SENTENCE IS THE DESIGN: *"D-23 is the single home for every version number and
 * this step asserts them rather than restating them."*** So there is not one version literal in
 * this file. Every pin is read from the committed artefact that owns it:
 *
 * | Pin | Read from | Why there |
 * |---|---|---|
 * | Rust version, build target | `rust-toolchain.toml` | the file a fresh checkout obeys; D-23 commits it so the version is not inherited from whoever builds |
 * | `soroban-sdk` | workspace `Cargo.toml` | `=27.0.6`, exact rather than a caret, for the same reason |
 * | `stellar-cli` | `.github/workflows/ci.yml` (`STELLAR_CLI_VERSION`) | D-23: *"pins the exact `stellar-cli` patch version **in CI** and in `deployments/<network>.json`"* |
 *
 * Reading the CLI pin out of a CI workflow looks odd for about a second, and then it is the only
 * defensible place: **it means CI and a deploy cannot disagree about which binary produced a
 * wasm.** A copy of `27.1.0` in this file would be a second home for the number, and the failure
 * mode of a second home is that it stays at 27.1.0 through the upgrade that moves the first.
 *
 * WHY A DEPLOY GATES ON THIS AT ALL. D-50 requires the mainnet wasm to hash identically to the
 * audited testnet one, and the comparison is a byte. A deploy performed with a different `rustc`
 * produces a different hash from the same source, so the artefact on record can never again be
 * reproduced — not detectably wrong, just permanently unverifiable. D-23 says it plainly: without
 * exact pins the reproducible-build gate *"is otherwise theatre"*.
 *
 * The step also asserts `overflow-checks = true` in **all** profiles, which D-23 requires and which
 * nothing else in the deploy path checks. It is the difference between a wrapped multiplication in
 * release mode and a panic, and it is set in a file that is easy to add a profile to.
 */

import { readFileSync } from "node:fs";

import { mkCheck, type Check } from "@antares/common/checks";

export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolchainError";
  }
}

/**
 * The host a build ran on, as `${process.platform}-${process.arch}`.
 *
 * It belongs beside the version pins because it is one: measured on this repository, the same
 * commit under the same pinned Rust and the same pinned CLI compiles to a different SHA-256 on
 * macOS than on Linux (O-7). Two records carry a build hash — the deployment record and
 * `packages/bindings/GENERATED.json` — and a hash without its host tells a reviewer to expect
 * bytes they will not get. One spelling, so the two records cannot drift apart on the name.
 */
export function buildHost(): string {
  return `${process.platform}-${process.arch}`;
}

export interface Pins {
  /** Exact Rust version, e.g. `1.95.0`. */
  readonly rust: string;
  /** Build targets `rust-toolchain.toml` names; `wasm32v1-none` must be among them. */
  readonly targets: readonly string[];
  /** The `soroban-sdk` requirement as written, e.g. `=27.0.6`. */
  readonly sorobanSdk: string;
  /** Exact `stellar-cli` version, e.g. `27.1.0`. */
  readonly stellarCli: string;
  /** Every `[profile.*]` table that sets `overflow-checks`, and what it set it to. */
  readonly overflowChecks: Readonly<Record<string, boolean>>;
  /** Where each pin came from, so a failure names a file to edit rather than a value to argue with. */
  readonly sources: Readonly<Record<string, string>>;
}

/** D-23's build target. Named once, here, because it is the value the pin files are searched *for*. */
export const REQUIRED_TARGET = "wasm32v1-none";

function readOrThrow(path: string, why: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ToolchainError(
      `Cannot read ${path}, which is where D-23 pins ${why}. A deploy cannot assert a pin whose ` +
        `home is missing, and guessing the value here would recreate exactly the drift D-23 exists ` +
        `to stop.`,
    );
  }
}

/**
 * Parse the three committed pin files.
 *
 * Hand-rolled line parsing rather than a TOML/YAML dependency. The three values are single scalar
 * assignments in files this repository controls, and each is parsed strictly enough that a shape it
 * does not recognise is a refusal rather than an `undefined` — which is the only property a real
 * parser would buy here, at the cost of a dependency in the deploy path.
 */
export function readPins(root: string): Pins {
  const toolchainPath = `${root}/rust-toolchain.toml`;
  const cargoPath = `${root}/Cargo.toml`;
  const ciPath = `${root}/.github/workflows/ci.yml`;

  const toolchain = readOrThrow(toolchainPath, "the Rust version and the build target");
  const cargo = readOrThrow(cargoPath, "soroban-sdk and overflow-checks");
  const ci = readOrThrow(ciPath, "the stellar-cli version");

  const rust = /^\s*channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1];
  if (rust === undefined) {
    throw new ToolchainError(`${toolchainPath} has no [toolchain] channel = "..." line.`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(rust)) {
    throw new ToolchainError(
      `${toolchainPath} pins channel "${rust}", which is not an exact version. D-23: "Rust stable" ` +
        `is a moving channel, and D-50's gate compares a byte produced by a specific compiler.`,
    );
  }

  const targetsRaw = /^\s*targets\s*=\s*\[([^\]]*)\]/m.exec(toolchain)?.[1] ?? "";
  const targets = [...targetsRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

  const sorobanSdk = /^\s*soroban-sdk\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  if (sorobanSdk === undefined) {
    throw new ToolchainError(`${cargoPath} has no workspace soroban-sdk = "..." requirement.`);
  }

  const stellarCli = /^\s*STELLAR_CLI_VERSION:\s*"?([0-9][^"\s]*)"?/m.exec(ci)?.[1];
  if (stellarCli === undefined) {
    throw new ToolchainError(
      `${ciPath} has no STELLAR_CLI_VERSION. D-23 pins the CLI in CI, and this step reads it from ` +
        `there precisely so that CI and a deploy cannot disagree about which binary built a wasm.`,
    );
  }

  // Every `[profile.<name>]` table, and whether it set `overflow-checks`. Absence is reported as
  // absence rather than as `false`, because "the profile does not mention it" and "the profile
  // turned it off" want different sentences in a failure.
  const overflowChecks: Record<string, boolean> = {};
  let current: string | null = null;
  for (const line of cargo.split("\n")) {
    const header = /^\s*\[profile\.([A-Za-z0-9_.-]+)\]/.exec(line);
    if (header !== null) {
      current = header[1]!;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const oc = /^\s*overflow-checks\s*=\s*(true|false)/.exec(line);
    if (oc !== null && current !== null) overflowChecks[current] = oc[1] === "true";
  }

  return {
    rust,
    targets,
    sorobanSdk,
    stellarCli,
    overflowChecks,
    sources: {
      rust: toolchainPath,
      targets: toolchainPath,
      sorobanSdk: cargoPath,
      stellarCli: ciPath,
      overflowChecks: cargoPath,
    },
  };
}

// =================================================================================================
// What the machine actually has
// =================================================================================================

export interface Observed {
  /** Raw `rustc --version`, e.g. `rustc 1.95.0 (59807616e 2026-04-14)`. */
  readonly rustc: string;
  /** Raw `stellar --version` first line, e.g. `stellar 27.1.0 (8e402ea…)`. */
  readonly stellar: string;
  /** `rustup target list --installed`, one per line. */
  readonly installedTargets: readonly string[];
}

/**
 * The version out of a `<tool> <semver> (...)` banner.
 *
 * Returns `null` rather than throwing, so a banner this does not recognise becomes a **failed
 * check naming what it saw** instead of an exception with a stack trace. An operator whose deploy
 * stopped needs to know which binary answered, and a `TypeError` does not tell them.
 */
export function parseVersion(banner: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(banner.split("\n")[0] ?? "")?.[1] ?? null;
}

/** The exact version a `=x.y.z` requirement admits, or `null` if the requirement is a range. */
export function exactRequirement(req: string): string | null {
  const m = /^\s*=\s*(\d+\.\d+\.\d+)\s*$/.exec(req);
  return m?.[1] ?? null;
}

// =================================================================================================
// The gate
// =================================================================================================

/**
 * Step 0, as comparisons.
 *
 * `expectedProfiles` is the set of `[profile.*]` tables D-23's *"in **all** profiles"* is measured
 * against. It is a parameter rather than a constant because the profiles a workspace has are a
 * property of `Cargo.toml`, and the caller has already read it — but the **rule** is not a
 * parameter: any profile that is missing `overflow-checks`, or sets it to `false`, fails.
 */
export function checkToolchain(pins: Pins, observed: Observed): Check[] {
  const checks: Check[] = [];

  const rustc = parseVersion(observed.rustc);
  checks.push(
    mkCheck(
      "toolchain.rustc",
      "the local rustc is the exact version D-23 pins",
      pins.rust,
      rustc ?? observed.rustc.split("\n")[0],
      rustc === pins.rust,
      `Pinned in ${pins.sources["rust"]!}. D-50 compares a byte, and a different compiler produces ` +
        `a different byte from identical source — so a wasm built here would be permanently ` +
        `unreproducible rather than detectably wrong. \`rustup toolchain install ${pins.rust}\`.`,
    ),
  );

  const stellar = parseVersion(observed.stellar);
  checks.push(
    mkCheck(
      "toolchain.stellar_cli",
      "the local stellar-cli is the exact version D-23 pins",
      pins.stellarCli,
      stellar ?? observed.stellar.split("\n")[0],
      stellar === pins.stellarCli,
      `Pinned in ${pins.sources["stellarCli"]!} as STELLAR_CLI_VERSION, which is the same value CI ` +
        `installs — read from there so a deploy and CI cannot disagree about which binary built a wasm.`,
    ),
  );

  checks.push(
    mkCheck(
      "toolchain.target_pinned",
      `rust-toolchain.toml names ${REQUIRED_TARGET}`,
      REQUIRED_TARGET,
      pins.targets,
      pins.targets.includes(REQUIRED_TARGET),
      "D-23: the current Soroban target. Docs naming wasm32-unknown-unknown are stale.",
    ),
  );
  checks.push(
    mkCheck(
      "toolchain.target_installed",
      `${REQUIRED_TARGET} is installed on this machine`,
      REQUIRED_TARGET,
      observed.installedTargets,
      observed.installedTargets.includes(REQUIRED_TARGET),
      `\`rustup target add ${REQUIRED_TARGET}\`. Pinned in a file a fresh checkout obeys is not the ` +
        `same as present on the machine about to build.`,
    ),
  );

  const exact = exactRequirement(pins.sorobanSdk);
  checks.push(
    mkCheck(
      "toolchain.soroban_sdk_exact",
      "soroban-sdk is pinned exactly rather than by a caret",
      "=<x.y.z>",
      pins.sorobanSdk,
      exact !== null,
      `In ${pins.sources["sorobanSdk"]!}. A caret admits a patch release, and a patch release ` +
        `changes the wasm — which is D-50's gate comparing two hashes that were never obliged to match.`,
    ),
  );

  // D-23: `overflow-checks = true` in **all** profiles. Absence and `false` are separate sentences
  // because they are separate mistakes — one is a profile somebody added, the other is one somebody
  // edited — and both produce a release binary that wraps instead of panicking.
  const profiles = Object.keys(pins.overflowChecks);
  const off = profiles.filter((p) => !pins.overflowChecks[p]);
  checks.push(
    mkCheck(
      "toolchain.overflow_checks",
      "every profile that Cargo.toml declares sets overflow-checks = true",
      "every profile true",
      pins.overflowChecks,
      profiles.length > 0 && off.length === 0,
      profiles.length === 0
        ? `${pins.sources["overflowChecks"]!} declares no [profile.*] table setting overflow-checks. ` +
            `D-23 requires it in all profiles; nothing else in the deploy path checks it.`
        : `Profiles with it off: ${off.join(", ")}. In release mode that is a wrapping ` +
            `multiplication where the contract expects a panic.`,
    ),
  );

  return checks;
}
