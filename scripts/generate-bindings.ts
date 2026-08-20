/**
 * generate-bindings.ts — `packages/bindings` is machine output, and this is what keeps it so.
 *
 * OWNER: DEV3. IP-5 waits on the bindings existing; this exists so that their existing means
 * something.
 *
 * **A BINDING THAT HAS DRIFTED FROM THE CONTRACT IS WORSE THAN NO BINDING.** No binding fails at
 * the boundary, immediately, with a version mismatch a reader can act on. A drifted one fails at
 * the *call site* with a shape error — a field that decodes to `undefined`, an argument in the
 * wrong position — far from the cause, and it does so only on the path that happens to touch the
 * changed entry point. So the question this script answers is not "can we generate bindings" but
 * "are the committed ones still the ones the contract implies", and it answers it by regenerating
 * and comparing **bytes**.
 *
 * That is D-50's shape applied to an interface rather than to a wasm: the artefact is pinned by
 * comparison against a fresh production of it, not by anybody remembering to rerun a command.
 *
 * **WHAT IS PINNED IS `src/index.ts` AND NOTHING ELSE.** The generator also emits a `package.json`,
 * a `tsconfig.json`, a README and a `.gitignore`; those are scaffolding, ours to own, and replaced.
 * Comparing them would make the check fail on our own workspace wiring, which is the fastest way to
 * teach somebody to pass `--write` without reading the diff.
 *
 * **THE GENERATOR'S VERSION IS PINNED LIKE EVERY OTHER VERSION.** It is the `stellar` CLI, whose
 * exact patch lives in `.github/workflows/ci.yml` (D-23), and this script refuses to generate
 * unless the local binary matches — reusing `readPins`, so there is still exactly one home for the
 * number. `GENERATED.json` then records which version produced the committed output, which is what
 * makes a failing check *diagnosable*: a drift caused by a CLI upgrade and a drift caused by a
 * contract change look identical in the diff and are entirely different problems.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { allPassed, failedIds, mkCheck, renderChecks, type Check } from "@antares/common/checks";
import { parseVersion, readPins } from "./lib/toolchain.ts";
import { sha256 } from "./lib/wasm.ts";

/** The one generated file this repository pins. Everything else the generator emits is scaffolding. */
export const GENERATED_FILE = "src/index.ts";

/** Where the provenance of the committed output is recorded. */
export const PROVENANCE_FILE = "GENERATED.json";

export interface BindingProvenance {
  /** The wasm the bindings describe — the same value D-50's gate compares. */
  readonly wasmSha256: string;
  /** The exact `stellar` CLI that produced them. */
  readonly stellarCli: string;
  readonly generatedAt: string;
  /** Callable entry points. The contract's surface is 42, of which one is `__constructor`. */
  readonly methods: number;
  readonly _what: string;
}

export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the repository root.");
}

/** Callable methods in the generated client — one per contract entry point except the constructor. */
export function countMethods(source: string): number {
  return [...source.matchAll(/^ {2}[a-z_]+: \(/gm)].length;
}

/**
 * The newest file that can change `antares_vault.wasm`: every `.rs` and `Cargo.toml` under
 * `contracts/`, plus the workspace manifests and the toolchain pin.
 *
 * This exists because the check below **reads a wasm off the disk rather than building one**, and a
 * stale artefact makes every other assertion here vacuous in the passing direction: the committed
 * bindings really are byte-identical to a fresh generation from *that* wasm, and that wasm is not
 * the contract. Measured 2026-08-20, and by Tamer rather than by me — reviewing this file with an
 * older `vault.rs` still compiled into `target/`, the check reported all five assertions green.
 *
 * So the precondition is enforced here instead of being written down. It is the same shape as the
 * finding that produced it: a guarantee that is declared and has no runner is green for the wrong
 * reason, and nobody can tell from the output.
 *
 * mtime rather than content, because content would mean building — which is the thing this check is
 * cheap enough to run without. It errs toward refusing: a `git checkout` restamps sources and makes
 * an otherwise-current wasm look stale, and the answer to that is `stellar contract build`, which
 * is what the check would have wanted anyway.
 *
 * # What it does NOT catch, which is the other half of the door
 *
 * A **stale** artefact and a **wrong** artefact are different failures and this one only sees the
 * first. `stellar contract build --out-dir X` leaves the raw cargo output at the default path and
 * puts the optimized build in `X` — and the raw one is *newer*, so freshness passes it. It also
 * exports the same 42 functions, so `bindings.surface` passes, and the bindings generated from it
 * are byte-identical, so `bindings.no_drift` reports zero difference. **The only assertion that
 * separates them is `bindings.wasm_recorded`, which compares the SHA-256.** Measured 2026-08-20,
 * and by walking into it twice: once here, and once again while checking the first.
 */
export function newestSource(root: string): { path: string; mtimeMs: number } | null {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "target" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name.endsWith(".rs") || entry.name === "Cargo.toml") files.push(path);
    }
  };
  const contracts = join(root, "contracts");
  if (existsSync(contracts)) walk(contracts, 0);
  for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) {
    const path = join(root, name);
    if (existsSync(path)) files.push(path);
  }

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const path of files) {
    const mtimeMs = statSync(path).mtimeMs;
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest;
}

function localStellarVersion(): string {
  try {
    return execFileSync("stellar", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "(stellar did not answer)";
  }
}

/**
 * Generate into a fresh temporary directory and return the one file that matters.
 *
 * Always to a temp directory, even when writing: producing the new output before touching the
 * committed one means a failed generation leaves the repository as it was rather than half-updated.
 */
export function generate(root: string, wasmPath: string): string {
  const parent = mkdtempSync(join(tmpdir(), "antares-bindings-"));
  // The generator derives an npm package name from the output directory's BASENAME and rejects
  // anything that is not a legal one — measured 2026-08-20: "basename 'antares-bindings-dOOG55' is
  // not a valid npm package name … contains invalid character 'O'". `mkdtempSync` suffixes with
  // mixed case, so passing its path directly fails on roughly the runs where the random suffix
  // happens to contain a capital. That is an intermittently failing check, which teaches people to
  // rerun rather than to read — so the directory handed to the generator has a fixed lowercase name
  // and the random part stays in its parent.
  const out = join(parent, "antares-bindings");
  try {
    execFileSync(
      "stellar",
      ["contract", "bindings", "typescript", "--wasm", wasmPath, "--output-dir", out, "--overwrite"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return readFileSync(join(out, GENERATED_FILE), "utf8");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

export interface BindingsCheckInput {
  /** The committed `src/index.ts`, or `null` when the package does not exist yet. */
  readonly committed: string | null;
  /** A freshly generated one. */
  readonly regenerated: string;
  readonly committedProvenance: BindingProvenance | null;
  /** `stellar --version` as it answers on this machine. */
  readonly localCli: string;
  /** The pinned version, from `.github/workflows/ci.yml`. */
  readonly pinnedCli: string;
  /** SHA-256 of the wasm the fresh generation was made from. */
  readonly wasmSha256: string;
  /** Wasm exports, so the surface can be checked rather than assumed. */
  readonly wasmExports: number;
  /** The wasm artefact's own mtime. */
  readonly wasmMtimeMs: number;
  /** The newest source that can change it, or `null` when there are none to compare against. */
  readonly newestSource: { readonly path: string; readonly mtimeMs: number } | null;
}

/**
 * Every assertion, so that a failure says which of three quite different things went wrong: the
 * generator moved, the contract moved, or somebody edited machine output by hand.
 */
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000", "");

export function checkBindings(input: BindingsCheckInput): Check[] {
  const checks: Check[] = [];
  const local = parseVersion(input.localCli);

  checks.push(
    mkCheck(
      "bindings.generator_pinned",
      "the generator is the exact stellar-cli D-23 pins",
      input.pinnedCli,
      local ?? input.localCli.split("\n")[0],
      local === input.pinnedCli,
      "The generator's version is pinned like every other version, and read from the same home CI " +
        "reads it from. A binding generated by a different CLI may differ for reasons that have " +
        "nothing to do with the contract.",
    ),
  );

  // Second, and before anything is claimed about the artefact: a stale wasm makes every
  // assertion below it green for the wrong reason. See `newestSource` for how that was measured.
  const newest = input.newestSource;
  checks.push(
    mkCheck(
      "bindings.wasm_fresh",
      "the wasm these bindings were generated from is newer than every source that can change it",
      newest === null ? "(no contract sources to compare against)" : `>= ${iso(newest.mtimeMs)}`,
      `${iso(input.wasmMtimeMs)}${newest === null ? "" : ` vs ${newest.path}`}`,
      newest === null || input.wasmMtimeMs >= newest.mtimeMs,
      "This check reads a wasm off the disk rather than building one, so an artefact older than " +
        "the contract makes no_drift, surface and wasm_recorded vacuous — they would compare the " +
        "committed bindings against a build nobody is shipping and pass. Run `stellar contract " +
        "build` (or `--package antares-vault`) and run this again. A checkout restamps sources, " +
        "so this can fire on a wasm that was current a moment ago; the fix is the same either way. " +
        "It catches a STALE artefact and not a WRONG one — a --out-dir build leaves a newer raw " +
        "artefact at this path, which this passes and bindings.wasm_recorded is what refuses.",
    ),
  );

  checks.push(
    mkCheck(
      "bindings.present",
      "the generated bindings are committed",
      GENERATED_FILE,
      input.committed === null ? "(missing)" : `${input.committed.length} bytes`,
      input.committed !== null,
      "IP-5 waits on these existing. `pnpm bindings:write` produces them.",
    ),
  );
  if (input.committed === null) return checks;

  // The load-bearing one. Bytes, not a parse: a generator that reorders its output has changed the
  // artefact even when the interface it describes is identical, and pinning is a claim about the
  // artefact.
  const drifted = input.committed !== input.regenerated;
  checks.push(
    mkCheck(
      "bindings.no_drift",
      "the committed bindings are byte-identical to a fresh generation from the built wasm",
      `sha256 ${sha256(new TextEncoder().encode(input.regenerated)).slice(0, 16)}…`,
      `sha256 ${sha256(new TextEncoder().encode(input.committed)).slice(0, 16)}…`,
      !drifted,
      "A drifted binding is worse than no binding: no binding fails at the boundary with a version " +
        "mismatch, a drifted one fails at the CALL SITE with a shape error, far from the cause and " +
        "only on the path that touches the changed entry point. If the interface changed " +
        "deliberately, run `pnpm bindings:write` and commit the result WITH the contract change, so " +
        "the two never sit in the repository disagreeing. If it did not, check " +
        "bindings.generator_pinned first — a CLI upgrade and a contract change look identical here.",
    ),
  );

  // The surface, checked against the wasm rather than against the CHANGELOG's sentence. `42 entry
  // points` is 41 callable plus `__constructor`, which the client exposes as a static `deploy`
  // rather than as a method.
  const methods = countMethods(input.committed);
  checks.push(
    mkCheck(
      "bindings.surface",
      "every callable entry point in the wasm has a method in the bindings",
      input.wasmExports - 1,
      methods,
      methods === input.wasmExports - 1,
      "Counted from the wasm's own export section, not from a document. The constructor is a " +
        "static `deploy` on the client rather than a method, which is the one that does not match.",
    ),
  );

  if (input.committedProvenance !== null) {
    checks.push(
      mkCheck(
        "bindings.wasm_recorded",
        "the recorded wasm is the one the bindings were generated from",
        input.wasmSha256,
        input.committedProvenance.wasmSha256,
        input.committedProvenance.wasmSha256 === input.wasmSha256,
        "Recorded so a drift is diagnosable: this says WHICH contract build the committed bindings " +
          "describe, which is the difference between 'the contract changed' and 'the generator did'.",
      ),
    );
  }

  return checks;
}

// =================================================================================================
// CLI
// =================================================================================================

export async function main(argv: readonly string[]): Promise<number> {
  const write = argv.includes("--write");
  const root = repoRoot();
  const pkg = join(root, "packages", "bindings");
  const wasmPath = join(root, "target", "wasm32v1-none", "release", "antares_vault.wasm");

  if (!existsSync(wasmPath)) {
    console.error(
      `\nNo wasm at ${wasmPath}. Bindings are generated from the artefact this repository builds, ` +
        `not from a deployed contract id — so that generating them needs no network and describes ` +
        `the code in this checkout. Run \`stellar contract build\` first.\n`,
    );
    return 2;
  }

  const pins = readPins(root);
  const localCli = localStellarVersion();
  const wasmBytes = readFileSync(wasmPath);
  const { exportedFunctions } = await import("./lib/wasm.ts");

  const regenerated = generate(root, wasmPath);
  const committedPath = join(pkg, GENERATED_FILE);
  const committed = existsSync(committedPath) ? readFileSync(committedPath, "utf8") : null;
  const provPath = join(pkg, PROVENANCE_FILE);
  const committedProvenance = existsSync(provPath)
    ? (JSON.parse(readFileSync(provPath, "utf8")) as BindingProvenance)
    : null;

  const newest = newestSource(root);
  const checks = checkBindings({
    committed,
    regenerated,
    committedProvenance,
    localCli,
    pinnedCli: pins.stellarCli,
    wasmSha256: sha256(wasmBytes),
    wasmExports: exportedFunctions(wasmBytes).length,
    wasmMtimeMs: statSync(wasmPath).mtimeMs,
    newestSource: newest === null ? null : { path: relative(root, newest.path), mtimeMs: newest.mtimeMs },
  });

  // Nothing is written unless the generator itself is the pinned one: regenerating with the wrong
  // CLI would replace a correct artefact with one nobody asked for and call it an update. The same
  // argument covers a stale wasm, and more sharply — writing from one commits bindings that do not
  // describe the contract AND a `wasmSha256` asserting they do, so the next run of this check reads
  // green. A refusal falls through to the report below, which says which precondition failed.
  const passed = (id: string): boolean => checks.find((c) => c.id === id)?.ok === true;
  if (write && passed("bindings.generator_pinned") && passed("bindings.wasm_fresh")) {
    writeFileSync(committedPath, regenerated);
    const provenance: BindingProvenance = {
      wasmSha256: sha256(wasmBytes),
      stellarCli: parseVersion(localCli) ?? "(unknown)",
      generatedAt: new Date().toISOString(),
      methods: countMethods(regenerated),
      _what:
        "GENERATED — do not edit src/index.ts. It is byte-compared against a fresh generation by " +
        "`pnpm bindings:check`, so a hand edit is indistinguishable from drift and is reported as " +
        "drift. Regenerate with `pnpm bindings:write` and commit the result WITH the contract " +
        "change that caused it. wasmSha256 says which build these describe; stellarCli says which " +
        "generator produced them, because a CLI upgrade and a contract change look identical in " +
        "the diff and are entirely different problems.",
    };
    writeFileSync(provPath, `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(`wrote ${committedPath} and ${provPath}`);
    return 0;
  }

  console.log(
    renderChecks("packages/bindings — generated, and checked against a fresh generation", checks).join("\n"),
  );
  if (!allPassed(checks)) {
    console.error(`\nREFUSED: ${failedIds(checks).join(", ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith("generate-bindings.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
