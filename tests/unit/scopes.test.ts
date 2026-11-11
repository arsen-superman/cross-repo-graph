import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIndex } from "../../src/indexer/index.js";
import { fetchBranches, resolveRef } from "../../src/indexer/git.js";

process.env.CRG_GRAPHIFY = JSON.stringify([process.execPath, resolve("tests/fixtures/fake-graphify.mjs")]);
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]).toString().trim();
const silent = (e: Record<string, unknown>) => { if (process.env.DEBUG_IDX) console.error(JSON.stringify(e)); };

/** origin (bare) with main = prod code and develop = one commit ahead; a clone with a local feature branch and an uncommitted edit. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "scopes-"));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "Prod.cs"), "class Prod {}");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "prod");
  git(seed, "checkout", "-q", "-b", "develop");
  writeFileSync(join(seed, "Dev.cs"), "class Dev {}");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "dev");
  git(seed, "checkout", "-q", "main");
  execFileSync("git", ["clone", "-q", "--bare", seed, join(root, "origin.git")]);
  const proj = join(root, "proj");
  mkdirSync(proj);
  execFileSync("git", ["clone", "-q", join(root, "origin.git"), join(proj, "api")]);
  const api = join(proj, "api");
  git(api, "checkout", "-q", "-b", "feature/x");
  writeFileSync(join(api, "Feature.cs"), "class Feature {}");
  return { proj, api };
}

test("git mode: dev = origin/develop, prod = origin/HEAD; the clone's branch and uncommitted files never reach the graph", async () => {
  const { proj, api } = project();
  const statusBefore = git(api, "status", "--porcelain");
  const r = await runIndex({ projectDir: proj, indexDir: join(proj, ".ai", ".index"), log: silent });
  assert.equal(r.exitCode, 0);
  const idx = join(proj, ".ai", ".index");
  const files = (scope: string) => JSON.parse(readFileSync(join(idx, "scopes", scope, "graph.json"), "utf8")).nodes.map((n: { source_file?: string }) => n.source_file).filter(Boolean).sort();
  assert.deepEqual(files("dev"), ["api/", "api/Dev.cs", "api/Prod.cs"]);
  assert.deepEqual(files("prod"), ["api/", "api/Prod.cs"]);
  const repos = JSON.parse(readFileSync(join(idx, "scopes", "dev", "repos.json"), "utf8")).repos;
  assert.equal(repos[0].ref, "origin/develop");
  assert.equal(git(api, "status", "--porcelain"), statusBefore, "the clone is untouched");
  assert.equal(git(api, "rev-parse", "--abbrev-ref", "HEAD"), "feature/x");
  assert.deepEqual(JSON.parse(readFileSync(join(idx, "index.json"), "utf8")).scopes, ["dev", "prod"]);
});

test("a commit shared by two scopes is extracted and parsed once; an unchanged rerun rebuilds nothing", async () => {
  const { proj, api } = project();
  git(api, "push", "-q", "origin", "origin/develop:refs/heads/main", "--force");   // main == develop
  git(api, "fetch", "-q", "origin");
  const idx = join(proj, ".ai", ".index");
  const first = await runIndex({ projectDir: proj, indexDir: idx, log: silent });
  assert.equal(first.rebuilt, 1);
  const again = await runIndex({ projectDir: proj, indexDir: idx, log: silent });
  assert.equal(again.rebuilt, 0);
});

test("working-tree mode indexes the clone as it is, as one dev scope", async () => {
  const { proj } = project();
  const idx = join(proj, ".ai", ".index");
  await runIndex({ projectDir: proj, indexDir: idx, workingTree: true, log: silent });
  const nodes = JSON.parse(readFileSync(join(idx, "scopes", "dev", "graph.json"), "utf8")).nodes.map((n: { source_file?: string }) => n.source_file);
  assert.ok(nodes.includes("api/Feature.cs"));
  assert.ok(!existsSync(join(idx, "scopes", "prod")));
});

test("resolveRef: a local branch is used when origin has no such branch; a missing branch resolves to nothing", () => {
  const { api } = project();
  git(api, "branch", "-q", "release");
  assert.equal(resolveRef(api, "release")?.ref, "release");
  assert.equal(resolveRef(api, "nope"), undefined);
  assert.equal(resolveRef(api, "nope|default")?.ref, "origin/main");
  assert.equal(resolveRef(api, "main|master|default")?.ref, "origin/main");
});

test("fetchBranches updates origin/<branch> refs only; a missing origin branch can't fail the fetch", async () => {
  const { proj, api } = project();
  const other = join(proj, "..", "other");
  execFileSync("git", ["clone", "-q", "-b", "develop", join(proj, "..", "origin.git"), other]);
  writeFileSync(join(other, "New.cs"), "class New {}");
  git(other, "add", "."); git(other, "commit", "-q", "-m", "new"); git(other, "push", "-q", "origin", "develop");
  const before = git(api, "rev-parse", "origin/develop");
  const r = await fetchBranches(api, ["develop", "main", "does-not-exist"]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.branches, ["develop", "main"]);
  assert.notEqual(git(api, "rev-parse", "origin/develop"), before);
  assert.equal(git(api, "rev-parse", "--abbrev-ref", "HEAD"), "feature/x");
});
