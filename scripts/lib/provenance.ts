/**
 * provenance.ts — which source tree actually ran, stated so that it can be checked.
 *
 * **WHY THIS EXISTS: a commit id identifies the code that ran only if the tree was clean.**
 * Otherwise it names code that did not run — well-formed, confident, pointing at the wrong thing.
 * That is the same shape as a wasm hash being mistaken for a transaction hash, and it is worse,
 * because this field is the line that tells a reader whether to believe the rest of the record.
 *
 * It was not hypothetical. Both deploys on 2026-08-20 recorded `deployedAtCommit` as a commit made
 * **after** the deploy ran, from a working tree that was no commit at all. The second record named
 * a tree whose `chain.ts` uses `execFileSync` — which discards stderr, where the transaction hash
 * lives — so it named code that demonstrably could not have produced the transaction array sitting
 * in the same file. The reasonable conclusion available to a reader is that the record was written
 * by hand.
 *
 * **THE CAUSE WAS AN ORDERING, NOT AN ACCIDENT.** Write the deploy code, run it, then commit the
 * code and the record it produced together — and under that order the record can *never* name the
 * tree that produced it, only its parent. It would have been wrong again on the next deploy.
 *
 * **THE RULING IS TO REFUSE, and the cost is smaller than it looks.** `09-DEPLOYMENT.md` §2 is a
 * refusing sequence with no override, and a record is what D2 is evidenced by: an unreproducible
 * record is worse than a deploy that did not happen. The tempting escape — allow it for
 * `--fast-test`, which is stamped economically meaningless anyway — does not survive contact with
 * what that stamp means. It disqualifies a profile from **demand** evidence (Phase 6b); mechanism
 * evidence is exactly what a fast-test cycle is *for*, and D2 is mechanism evidence. So the
 * fast-test record needs to be reproducible too.
 *
 * Refusing does not block a deploy. It reorders one: **commit, then deploy, then commit the
 * record.** Two commits instead of one, which is what "reproducibility over memory" costs.
 *
 * `dirty` is recorded explicitly even when false, so the record states that the check happened
 * rather than leaving a reader to infer it from a field's presence.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { mkCheck, type Check } from "@antares/common/checks";

export interface SourceTree {
  /** `git rev-parse HEAD`, or `(not a git checkout)`. */
  readonly commit: string;
  /** True when anything is modified, staged or untracked-and-not-ignored. */
  readonly dirty: boolean;
  /** Porcelain paths, so a refusal names what to commit rather than saying "something". */
  readonly dirtyPaths: readonly string[];
  /**
   * SHA-256 of `git diff HEAD`, present only when dirty.
   *
   * It does not make a dirty tree reproducible — untracked files contribute no diff — and it is not
   * offered as a substitute for committing. It exists so that two records claiming the same commit
   * can at least be told apart.
   */
  readonly diffSha256?: string;
}

function git(root: string, args: readonly string[]): string | null {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

export function readSourceTree(root: string): SourceTree {
  const head = git(root, ["rev-parse", "HEAD"])?.trim();
  if (head === undefined || head === "") {
    return { commit: "(not a git checkout)", dirty: true, dirtyPaths: ["(no git metadata)"] };
  }
  // `--porcelain` lists modified, staged and untracked files, and honours .gitignore — so an
  // ignored artefact such as a dry run's environment record does not make a tree dirty.
  const status = git(root, ["status", "--porcelain"]) ?? "";
  const dirtyPaths = status
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, ""));
  if (dirtyPaths.length === 0) return { commit: head, dirty: false, dirtyPaths: [] };
  const diff = git(root, ["diff", "HEAD"]) ?? "";
  return {
    commit: head,
    dirty: true,
    dirtyPaths,
    diffSha256: createHash("sha256").update(diff).digest("hex"),
  };
}

/**
 * The gate: a deploy records provenance, so it may only run from a tree whose provenance is a fact.
 *
 * The message names the paths, because "the tree is dirty" sends an operator to `git status` and
 * the next thing they do is decide the changes are unimportant — which is the judgement this check
 * exists to take away from the moment of deploying.
 */
export function checkSourceTree(tree: SourceTree): Check[] {
  return [
    mkCheck(
      "provenance.clean",
      "the deploy runs from a committed tree, so the record can name the code that ran",
      "clean",
      tree.dirty ? tree.dirtyPaths : "clean",
      !tree.dirty,
      "A commit id identifies the code that ran only if the tree was clean; otherwise the record " +
        "names code that did not run. Commit first, then deploy, then commit the record — two " +
        "commits instead of one. Both deploys on 2026-08-20 recorded a commit made AFTER the run, " +
        "and the second named a tree that could not have produced the file it was written into.",
    ),
  ];
}
