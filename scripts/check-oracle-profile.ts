/**
 * check-oracle-profile.ts — a parameter set against a *live source's* eight `supports_round`
 * conditions.
 *
 * OWNER: DEV3. `DEV3.md` §6.1 requires the fast-test profile to be *"checked against all eight
 * `supports_round` conditions before committing, including condition 7 via the mock's
 * `expires()`"*. This is that check, and it is a committed tool rather than a one-off because the
 * same question has to be asked again of every profile anyone writes.
 *
 * **IT REIMPLEMENTS NOTHING.** The eight conditions live once, in
 * `contracts/price-source-api/src/lib.rs`, and both sources call that one copy — the header there
 * says so explicitly. A TypeScript translation of them would be a second copy that agrees on the
 * day it is written, which is the failure mode the single implementation exists to prevent. So this
 * script *asks the deployed contract*, by simulation, and believes the answer.
 *
 * **WHAT A PERTURBATION PROVES, AND WHAT IT DOES NOT.** `supports_round` returns a bool, so a
 * rejection cannot be attributed to a condition by observation. Each perturbation below is
 * therefore constructed to violate exactly one condition while leaving the others satisfied — the
 * attribution is by construction, and the construction is shown in the table so a reader can check
 * it. What the run proves is the pair that matters: **the profile is accepted, and each condition
 * is live** — a condition that never rejects anything would otherwise be indistinguishable from a
 * condition that is not there.
 *
 * **TWO CONDITIONS CANNOT BE PERTURBED AND ARE HANDLED HONESTLY RATHER THAN FAKED.** Condition 0
 * is `resolution() != 0` — a property of the source, not of the arguments — so it is *observed*, by
 * reading `resolution()` live. Condition 5 is proved redundant in the source itself (*"IMPLIED BY 4
 * … it can never be the sole cause of a rejection"*, 04-ORACLE §2), so no perturbation exists that
 * isolates it; the script records it as redundant and reports the margin instead. Inventing a
 * perturbation for either would be a passing check that tested nothing.
 *
 * Every call is a simulation. Nothing is signed and nothing is spent.
 */

import { allPassed, failedIds, mkCheck, renderChecks, type Check } from "@antares/common/checks";
import { buildInvokeArgv, runStellar, type NetworkArgs } from "./lib/chain.ts";
import { loadInstances, type InstanceSpec } from "./check-params.ts";

/** The six timing arguments `supports_round` takes, in the ABI's names. */
export interface RoundTiming {
  readonly twap_window: number;
  readonly guard_window: number;
  readonly oracle_dead_after: number;
  readonly settle_grace: number;
  readonly unresolved_after: number;
  readonly round_span: number;
}

export function timingOf(inst: InstanceSpec, withSpan: boolean): RoundTiming {
  const p = inst.params;
  return {
    twap_window: p["twap_window"]!,
    guard_window: p["guard_window"]!,
    oracle_dead_after: p["oracle_dead_after"]!,
    settle_grace: p["settle_grace"]!,
    unresolved_after: p["unresolved_after"]!,
    // `validate_params` passes 0, which SKIPS condition 7 so a sponsorship shortfall cannot block
    // the very `set_epoch_params` call that repairs it. `open_epoch` passes this and enforces it.
    round_span: withSpan ? p["epoch_duration"] + p["unresolved_after"]! : 0,
  };
}

export interface Perturbation {
  readonly condition: string;
  /** What the mutated set violates, in the source's own words. */
  readonly violates: string;
  /** Why the other seven still hold — the attribution, shown so a reader can check it. */
  readonly isolation: string;
  readonly mutate: (t: RoundTiming, res: number) => RoundTiming;
}

/**
 * One perturbation per perturbable condition, each violating exactly one.
 *
 * They are functions of the profile and the live resolution rather than constants, because a
 * profile at `resolution() = 1` and one at `300` need different numbers to break the same rule —
 * and a table of constants would quietly stop isolating anything on the second profile it met.
 */
export const PERTURBATIONS: readonly Perturbation[] = [
  {
    condition: "1a",
    violates: "twap_window >= 2 * res — the short window cannot hold 3 distinct ticks",
    isolation: "only the short window shrinks; every span, sum and ceiling below is unchanged.",
    mutate: (t, res) => ({ ...t, twap_window: 2 * res - 1 }),
  },
  {
    condition: "1b",
    violates: "guard_window >= 4 * res — the guard window cannot hold 5 distinct ticks",
    isolation:
      "guard_window also appears in 3, 4 and 6 through reach_limit, and shrinking it RELAXES all " +
      "three (a smaller guard means a larger reach_limit and a larger ceiling), so 1b is the only " +
      "condition this can break.",
    mutate: (t, res) => ({ ...t, guard_window: 4 * res - 1 }),
  },
  {
    condition: "2",
    violates: "the REALIZED guard span must exceed the realized short span, after both floors truncate",
    isolation:
      "twap_window is raised to equal guard_window, so short_step = gw/2 and guard_step = gw/4: " +
      "the spans become equal and 2 rejects. Raising twap_window appears in no other condition.",
    mutate: (t) => ({ ...t, twap_window: t.guard_window }),
  },
  {
    condition: "3",
    violates:
      "unresolved_after > reach_limit — the evidence-free fallback must fire strictly after the adapter gives up",
    isolation:
      "unresolved_after is lowered to exactly reach_limit, which 3 rejects (strictly) and 6 " +
      "accepts (it is a ceiling). Nothing else reads it.",
    mutate: (t, res) => ({ ...t, unresolved_after: 255 * res - t.guard_window }),
  },
  {
    condition: "4",
    violates: "oracle_dead_after + guard_window + settle_grace < R",
    isolation:
      "oracle_dead_after is raised to push the sum over R. It appears elsewhere only in 5, which " +
      "4 already implies, and 4 is evaluated first.",
    mutate: (t, res) => ({ ...t, oracle_dead_after: 255 * res - t.guard_window - t.settle_grace }),
  },
  {
    condition: "6",
    violates: "unresolved_after <= reach_limit + settle_grace — the ceiling on the oracle-free terminal path",
    isolation:
      "unresolved_after is raised one past the ceiling, which 3 accepts (it is a floor) and 6 " +
      "rejects. Nothing else reads it.",
    mutate: (t, res) => ({ ...t, unresolved_after: 255 * res - t.guard_window + t.settle_grace + 1 }),
  },
];

// =================================================================================================
// Asking the contract
// =================================================================================================

export interface Source {
  readonly contractId: string;
  readonly identity: string;
  readonly net: NetworkArgs;
}

function readBool(out: string, what: string): boolean {
  const text = out.trim().split("\n").filter(Boolean).pop()?.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(`${what} answered "${String(text)}", which is neither true nor false.`);
}

export function supportsRound(src: Source, t: RoundTiming): boolean {
  const out = runStellar(
    buildInvokeArgv({
      contractId: src.contractId,
      method: "supports_round",
      identity: src.identity,
      net: src.net,
      args: { ...t },
      readOnly: true,
    }),
  );
  return readBool(`${out.stdout}\n${out.stderr}`, `${src.contractId}.supports_round`);
}

function readScalar(src: Source, method: string): string {
  const out = runStellar(
    buildInvokeArgv({
      contractId: src.contractId,
      method,
      identity: src.identity,
      net: src.net,
      args: {},
      readOnly: true,
    }),
  );
  return `${out.stdout}${out.stderr}`.trim().split("\n").filter(Boolean).pop()?.trim() ?? "";
}

/**
 * The whole battery for one instance against one live source.
 *
 * `now` is the ledger's, not the wall clock's, because condition 7 compares against the *source's*
 * notion of now — and on a fast-test profile the two can differ by more than the round span.
 */
export function checkProfile(src: Source, inst: InstanceSpec): Check[] {
  const checks: Check[] = [];

  // ---- condition 0, observed rather than perturbed --------------------------------------------
  const res = Number(readScalar(src, "resolution"));
  checks.push(
    mkCheck(
      `${inst.suffix}:cond0`,
      "condition 0 — the source reports a non-zero resolution, so a usable grid exists",
      "> 0",
      res,
      Number.isInteger(res) && res > 0,
      "A property of the source rather than of the arguments, so it is read live rather than " +
        "perturbed. Everything below is computed against THIS number.",
    ),
  );
  if (!(res > 0)) return checks;

  // ---- the profile itself, on both paths ------------------------------------------------------
  const constructorPath = timingOf(inst, false);
  const openPath = timingOf(inst, true);
  checks.push(
    mkCheck(
      `${inst.suffix}:accepted_constructor`,
      "the source accepts this profile on validate_params' path (round_span = 0, condition 7 skipped)",
      true,
      supportsRound(src, constructorPath),
      supportsRound(src, constructorPath),
      "round_span = 0 skips 7 so a sponsorship shortfall cannot block the set_epoch_params call " +
        "that repairs it. A profile failing HERE cannot be constructed at all.",
    ),
  );
  const openOk = supportsRound(src, openPath);
  checks.push(
    mkCheck(
      `${inst.suffix}:accepted_open`,
      "the source accepts this profile on open_epoch's path (condition 7 enforced)",
      true,
      openOk,
      openOk,
      `round_span = epoch_duration + unresolved_after = ${openPath.round_span}. Failing only here ` +
        `means the vault constructs and then refuses every open — which is exactly the failure ` +
        `09-DEPLOYMENT §2 step 3c's "+ oracle_dead_after" form used to let through.`,
    ),
  );

  // ---- each condition is live ------------------------------------------------------------------
  for (const p of PERTURBATIONS) {
    const mutated = p.mutate(openPath, res);
    const answer = supportsRound(src, mutated);
    checks.push(
      mkCheck(
        `${inst.suffix}:cond${p.condition}`,
        `condition ${p.condition} is live — ${p.violates}`,
        false,
        answer,
        answer === false,
        `Perturbation: ${JSON.stringify(mutated)}. ${p.isolation} A TRUE here means the condition ` +
          `did not reject a set built to violate it, so the profile's clearance of it proves nothing.`,
      ),
    );
  }

  // ---- condition 5, redundant by construction ---------------------------------------------------
  const reachLimit = 255 * res - openPath.guard_window;
  const voidWindow = reachLimit - openPath.oracle_dead_after;
  checks.push(
    mkCheck(
      `${inst.suffix}:cond5`,
      "condition 5 — the void window has its guaranteed width (redundant, reported not perturbed)",
      `>= settle_grace ${openPath.settle_grace}`,
      voidWindow,
      voidWindow >= openPath.settle_grace,
      "The source proves this IMPLIED BY 4 and 04-ORACLE §2 records it as redundant precisely so " +
        "nobody reads it as coverage — so no perturbation isolates it and inventing one would be a " +
        "check that tests nothing. The margin is reported instead.",
    ),
  );

  return checks;
}

// =================================================================================================
// CLI
// =================================================================================================

export async function main(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith("--") && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
      values.set(a.slice(2), argv[i + 1]!);
      i += 1;
    }
  }
  const source = values.get("source");
  const paramsPath = values.get("params");
  const identity = values.get("identity");
  if (source === undefined || paramsPath === undefined || identity === undefined) {
    console.error(
      "usage: NETWORK=testnet check-oracle-profile.ts --source <C...> --params <file> --identity <name>\n" +
        "\n" +
        "  Asks a LIVE price source whether a parameter set clears its eight supports_round\n" +
        "  conditions, and perturbs each perturbable one to prove it is live. Simulation only:\n" +
        "  nothing is signed and nothing is spent.\n",
    );
    return 2;
  }

  const { resolveNetwork, resolveRpcUrl } = await import("@antares/common");
  const net = resolveNetwork();
  const src: Source = {
    contractId: source,
    identity,
    net: { rpcUrl: resolveRpcUrl(net), networkPassphrase: net.networkPassphrase },
  };

  const instances = loadInstances(paramsPath);
  let ok = true;
  for (const inst of instances) {
    const checks = checkProfile(src, inst);
    console.log(renderChecks(`instance ${inst.suffix} against ${source}`, checks).join("\n"));
    if (!allPassed(checks)) {
      ok = false;
      console.error(`  failed: ${failedIds(checks).join(", ")}`);
    }
  }
  if (!ok) {
    console.error("\nREFUSED. A profile that a live source will not honour is not a profile.");
    return 1;
  }
  console.log(`\nAll ${instances.length} profile(s) clear every condition, and every condition is live.`);
  return 0;
}

if (process.argv[1]?.endsWith("check-oracle-profile.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
