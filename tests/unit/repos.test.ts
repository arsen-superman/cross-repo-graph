import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepos, repoState } from "../../src/indexer/repos.js";

const gitRepo = (dir: string) => { mkdirSync(dir, { recursive: true }); execFileSync("git", ["init", "-q", dir]); };

test("discoverRepos: repos one and two levels deep, worktrees/ skipped, name clashes get the parent prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  gitRepo(join(root, "api"));
  gitRepo(join(root, "frontend", "web"));
  gitRepo(join(root, "worktrees", "api--KEY-1"));
  gitRepo(join(root, "a", "shared"));
  gitRepo(join(root, "b", "shared"));
  assert.deepEqual(discoverRepos(root).map((r) => r.key), ["a-shared", "api", "b-shared", "web"]);
});

test("discoverRepos: a project folder that is itself the only repo", () => {
  const root = mkdtempSync(join(tmpdir(), "single-"));
  gitRepo(root);
  assert.equal(discoverRepos(root).length, 1);
});

test("repoState: the fingerprint changes with uncommitted edits and untracked files", () => {
  const root = mkdtempSync(join(tmpdir(), "state-"));
  gitRepo(root);
  const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
  writeFileSync(join(root, "A.cs"), "class A {}");
  g("add", "."); g("commit", "-q", "-m", "init");
  const clean = repoState(root);
  assert.equal(clean.dirty, false);
  assert.equal(repoState(root).fingerprint, clean.fingerprint);
  writeFileSync(join(root, "A.cs"), "class A { int x; }");
  const edited = repoState(root);
  assert.equal(edited.dirty, true);
  assert.notEqual(edited.fingerprint, clean.fingerprint);
  writeFileSync(join(root, "B.cs"), "class B {}");
  assert.notEqual(repoState(root).fingerprint, edited.fingerprint);
});
