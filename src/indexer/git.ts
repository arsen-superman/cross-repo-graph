// Git plumbing for the indexer: which commit a scope points at, extracting that commit's tree without touching the
// repository's working copy, index or HEAD, and a non-interactive fetch of the scope branches.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const BUF = 256 * 1024 * 1024;

export const git = (dir: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git", ["-C", dir, ...args], { maxBuffer: BUF, stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : undefined }).toString("utf8").trim();
const tryGit = (dir: string, args: string[]) => { try { return git(dir, args); } catch { return undefined; } };

const hasRemote = (dir: string, remote = "origin") => tryGit(dir, ["remote"])?.split(/\r?\n/).includes(remote) ?? false;
const refExists = (dir: string, ref: string) => tryGit(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== undefined;

/** The default branch name: origin/HEAD, else main / master, else the checked-out branch. */
export function defaultBranch(dir: string): string {
  const head = tryGit(dir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (refExists(dir, `refs/remotes/origin/${b}`) || refExists(dir, `refs/heads/${b}`)) return b;
  return tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
}

/** Branch names a spec stands for: "develop|default" → ["develop", "<default branch>"]. */
export function candidates(dir: string, spec: string): string[] {
  return [...new Set(spec.split("|").map((s) => s.trim()).filter(Boolean).map((s) => (s === "default" ? defaultBranch(dir) : s)))];
}

/** A resolved scope source: the ref used (remote-tracking preferred over a local branch) and its commit. */
export interface ResolvedRef { branch: string; ref: string; commit: string; committedAt: string }

/** First candidate that exists, preferring origin/<branch> (what was last fetched) over the local branch. */
export function resolveRef(dir: string, spec: string): ResolvedRef | undefined {
  for (const branch of candidates(dir, spec)) {
    for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
      if (!refExists(dir, ref)) continue;
      const commit = git(dir, ["rev-parse", `${ref}^{commit}`]);
      return { branch, ref: ref.replace(/^refs\/(remotes|heads)\//, ""), commit, committedAt: git(dir, ["show", "-s", "--format=%cI", commit]) };
    }
  }
  return undefined;
}

/**
 * Writes the tree of `commit` into `dest` through a temporary index (read-tree + checkout-index): no hooks run,
 * and the repository's HEAD, index and working copy stay untouched. Atomic: extracted into `<dest>.tmp`, then renamed.
 */
export function extractCommit(dir: string, commit: string, dest: string): void {
  if (existsSync(dest)) return;
  const tmp = `${dest}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const indexFile = join(tmp, "..", `${dest.split(/[\\/]/).pop()}.idx`);
  try {
    git(dir, ["read-tree", commit], { GIT_INDEX_FILE: indexFile });
    git(dir, ["-c", "core.longpaths=true", `--work-tree=${tmp}`, "checkout-index", "-a", "-f"], { GIT_INDEX_FILE: indexFile });
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`cannot extract ${commit.slice(0, 10)}: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 400)}`);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** When this repository last fetched (FETCH_HEAD mtime), or undefined if it never did. */
export function fetchedAt(dir: string): string | undefined {
  const p = tryGit(dir, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  if (!p) return undefined;
  const full = isAbsolute(p) ? p : join(dir, p);
  try { return statSync(full).mtime.toISOString(); } catch { return undefined; }
}

/** Outcome of fetching one repository. */
export interface FetchResult { ok: boolean; branches: string[]; error?: string; ms: number }

/**
 * `git fetch origin <branches> --prune --no-tags`, never interactive: no credential or passphrase prompts
 * (an SSH agent still signs), a timeout per repo. Only branches that already exist as origin/<name> are fetched,
 * so a missing branch can't fail the whole fetch.
 */
export async function fetchBranches(dir: string, branches: string[], timeoutMs = 20_000): Promise<FetchResult> {
  const started = Date.now();
  if (!hasRemote(dir)) return { ok: false, branches: [], error: "no origin remote", ms: 0 };
  const names = branches.filter((b) => refExists(dir, `refs/remotes/origin/${b}`));
  if (!names.length) return { ok: false, branches: [], error: "no origin/<branch> refs to update", ms: 0 };
  const ssh = tryGit(dir, ["config", "core.sshCommand"]) || "ssh";
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes -o ConnectTimeout=10`,
  };
  try {
    await execFileP("git", ["-C", dir, "fetch", "--quiet", "--prune", "--no-tags", "origin", ...names], { env, timeout: timeoutMs, maxBuffer: BUF, windowsHide: true });
    return { ok: true, branches: names, ms: Date.now() - started };
  } catch (e) {
    const err = e as { killed?: boolean; stderr?: string; message?: string };
    return { ok: false, branches: names, error: err.killed ? `timed out after ${timeoutMs / 1000}s` : String(err.stderr || err.message).trim().slice(0, 300), ms: Date.now() - started };
  }
}
