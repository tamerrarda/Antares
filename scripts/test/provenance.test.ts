/**
 * Tests for the source-tree gate — `09-DEPLOYMENT.md` §2 step 0.
 *
 * Against **real git repositories**, created and dirtied in a temp directory, because the thing
 * under test is what `git status --porcelain` reports and a stub of that would be a stub of the
 * only thing that can be wrong. The gate exists because a commit id names the code that ran only
 * when the tree was clean, and both deploys on 2026-08-20 recorded a commit made after the run.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failedIds } from "@antares/common/checks";
import { checkSourceTree, readSourceTree } from "../lib/provenance.ts";

function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A real repository with one commit in it. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "antares-prov-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  return root;
}

test("a clean tree reports its commit and says so explicitly", () => {
  const root = repo();
  const tree = readSourceTree(root);
  assert.match(tree.commit, /^[0-9a-f]{40}$/);
  // Recorded even when false, so the record STATES that the check happened rather than leaving a
  // reader to infer it from a field's absence.
  assert.equal(tree.dirty, false);
  assert.deepEqual(tree.dirtyPaths, []);
  assert.equal(tree.diffSha256, undefined);
  assert.deepEqual(failedIds(checkSourceTree(tree)), []);
});

test("a modified tracked file is dirty, and the refusal names the file", () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "two\n");
  const tree = readSourceTree(root);
  assert.equal(tree.dirty, true);
  assert.deepEqual(tree.dirtyPaths, ["a.txt"]);
  assert.match(tree.diffSha256!, /^[0-9a-f]{64}$/);

  const checks = checkSourceTree(tree);
  assert.deepEqual(failedIds(checks), ["provenance.clean"]);
  // Naming the paths matters: "the tree is dirty" sends an operator to `git status`, and the next
  // thing they do is decide the changes are unimportant.
  assert.deepEqual(checks[0]!.actual, ["a.txt"]);
  assert.match(checks[0]!.note!, /Commit first, then deploy/);
});

test("an untracked file is dirty too — it is code that would run and is in no commit", () => {
  const root = repo();
  writeFileSync(join(root, "new-step.ts"), "export const x = 1;\n");
  const tree = readSourceTree(root);
  assert.equal(tree.dirty, true);
  assert.deepEqual(tree.dirtyPaths, ["new-step.ts"]);
  assert.deepEqual(failedIds(checkSourceTree(tree)), ["provenance.clean"]);
});

test("a staged-but-uncommitted change is dirty — `git add` is not a commit", () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "three\n");
  git(root, "add", "-A");
  assert.equal(readSourceTree(root).dirty, true);
});

test("an IGNORED artefact does not make a tree dirty", () => {
  // A dry run's environment record lands in deployments/ and is gitignored. If that counted, the
  // gate would refuse after every rehearsal and be routed around within a day.
  const root = repo();
  writeFileSync(join(root, ".gitignore"), "*.dryrun.json\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ignore");
  writeFileSync(join(root, "env.dryrun.json"), "{}\n");
  const tree = readSourceTree(root);
  assert.equal(tree.dirty, false, "an ignored file must not refuse a deploy");
  assert.deepEqual(failedIds(checkSourceTree(tree)), []);
});

test("committing the change makes the tree clean again — the refusal is one commit away", () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "four\n");
  assert.equal(readSourceTree(root).dirty, true);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "second");
  const tree = readSourceTree(root);
  assert.equal(tree.dirty, false);
  // And the commit it now names is the one carrying the change, which is the whole point.
  assert.notEqual(tree.commit, "");
  assert.deepEqual(failedIds(checkSourceTree(tree)), []);
});

test("two dirty trees at the same commit are distinguishable by their diff hash", () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "alpha\n");
  const one = readSourceTree(root);
  writeFileSync(join(root, "a.txt"), "beta\n");
  const two = readSourceTree(root);
  assert.equal(one.commit, two.commit);
  assert.notEqual(one.diffSha256, two.diffSha256);
  // It does not make either reproducible — untracked files contribute no diff — and it is not
  // offered as a substitute for committing. Both still fail the gate.
  assert.deepEqual(failedIds(checkSourceTree(one)), ["provenance.clean"]);
  assert.deepEqual(failedIds(checkSourceTree(two)), ["provenance.clean"]);
});

test("a directory that is not a git checkout refuses rather than reporting a clean tree", () => {
  const root = mkdtempSync(join(tmpdir(), "antares-nogit-"));
  mkdirSync(join(root, "sub"));
  const tree = readSourceTree(root);
  assert.equal(tree.dirty, true, "unknown provenance is not clean provenance");
  assert.deepEqual(failedIds(checkSourceTree(tree)), ["provenance.clean"]);
});
