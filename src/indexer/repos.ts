// Repositories of a project folder and the fingerprint that decides whether a repo needs re-indexing.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** A repository found in the project folder. */
export interface LocalRepo { key: string; dir: string }
/** Git state of a repository: HEAD, branch, uncommitted changes and their fingerprint. */
export interface RepoState { commit: string; branch: string; dirty: boolean; fingerprint: string }

// worktrees/ holds task worktrees of repos that are already indexed from their main clone
const SKIP = new Set(["worktrees", "node_modules", "bin", "obj", "dist", "build", "out"]);
const isRepo = (dir: string) => existsSync(join(dir, ".git"));
const subdirs = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => join(dir, e.name));
  } catch { return []; }
};

/**
 * Repositories of a project: every folder with `.git` one or two levels below the project folder (not under
 * worktrees/). If there are none and the project folder is itself a repository, the project is a single repo.
 * Keys are folder names; a clash is resolved with the parent folder name (`parent-name`).
 */
export function discoverRepos(projectDir: string): LocalRepo[] {
  const root = resolve(projectDir);
  const found: string[] = [];
  for (const d1 of subdirs(root)) {
    if (isRepo(d1)) { found.push(d1); continue; }
    for (const d2 of subdirs(d1)) if (isRepo(d2)) found.push(d2);
  }
  if (!found.length && isRepo(root)) found.push(root);
  const byName = new Map<string, number>();
  for (const d of found) byName.set(basename(d).toLowerCase(), (byName.get(basename(d).toLowerCase()) ?? 0) + 1);
  const repos = found.map((dir) => ({
    key: (byName.get(basename(dir).toLowerCase())! > 1 ? `${basename(dirname(dir))}-${basename(dir)}` : basename(dir)).replace(/[^A-Za-z0-9._-]/g, "_"),
    dir,
  }));
  const keys = new Set<string>();
  for (const r of repos) {
    if (keys.has(r.key.toLowerCase())) throw new Error(`Two repositories map to the key "${r.key}"; rename one of the folders.`);
    keys.add(r.key.toLowerCase());
  }
  return repos.sort((a, b) => a.key.localeCompare(b.key));
}

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");

/**
 * HEAD, branch and a fingerprint of the working tree: HEAD + staged/unstaged diff + untracked files (size, mtime).
 * The same fingerprint means the repo's graph from the previous run is still valid.
 */
export function repoState(dir: string): RepoState {
  let commit = "";
  try { commit = git(dir, ["rev-parse", "HEAD"]).trim(); } catch { commit = "no-commits"; }
  let branch = "";
  try { branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(); } catch { /* no commits yet */ }
  const status = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const h = createHash("sha1").update(commit).update("\0").update(status);
  if (status) {
    try { h.update(git(dir, ["diff", "HEAD", "--no-color", "--no-ext-diff"])); } catch { /* no HEAD yet */ }
    for (const entry of status.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      try { const s = statSync(join(dir, entry.slice(3))); h.update(`${entry}:${s.size}:${s.mtimeMs}`); } catch { /* removed meanwhile */ }
    }
  }
  return { commit, branch, dirty: status.length > 0, fingerprint: h.digest("hex") };
}
