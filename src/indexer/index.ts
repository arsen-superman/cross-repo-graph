// Indexer: builds <indexDir>/graph.json, links.json, hosts.json and repos.json for all repositories of a project.
//   • repos whose fingerprint (HEAD + uncommitted changes) is unchanged reuse their graph from the previous run;
//   • Graphify extracts the AST graph of each changed repo (w/<hash of key>/graphify-out/graph.json);
//   • the per-repo graphs are merged losslessly, the cross-repo linker adds HTTP / config / package links;
//   • every output file is replaced atomically, so a running server never reads a half-written index.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractRepo, mergeGraphs } from "./graphify.js";
import { applyLinks, linkHttpAll, linkPackages, mergeRepoGraphs, prepareMergedGraph, type CrossLink, type Graph } from "./linker.js";
import { discoverRepos, repoState, type LocalRepo } from "./repos.js";
import { listFiles } from "./files.js";

/** Options of one indexer run. */
export interface IndexOptions {
  projectDir: string;
  indexDir: string;
  /** Re-extract every repo even if its fingerprint is unchanged. */
  force?: boolean;
  /** Manual host → repo key entries for the linker's host catalog. */
  manualHosts?: Record<string, string>;
  log?: (e: Record<string, unknown>) => void;
}
/** Outcome of a run: 0 — everything indexed, 2 — published without some repos, 1 — nothing published. */
export interface IndexResult { exitCode: 0 | 1 | 2; repos: number; rebuilt: number; failed: number; skippedRun?: "locked" | "up-to-date" }

const LOCK_STALE_MS = 30 * 60 * 1000;
// Graphify's cache paths are long (64-char hashes); a short per-repo folder keeps them under Windows' MAX_PATH.
const workName = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 10);
const writeJsonAtomic = (path: string, data: unknown) => { writeFileSync(`${path}.tmp`, JSON.stringify(data)); renameSync(`${path}.tmp`, path); };
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };

function acquireLock(lock: string): boolean {
  try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { /* exists */ }
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
    rmSync(lock, { force: true });
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch { return false; }
}

/** Indexes the project; returns quickly when another run holds the lock or nothing changed. */
export function runIndex(o: IndexOptions): IndexResult {
  const log = o.log ?? ((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), ...e })));
  const indexDir = resolve(o.indexDir);
  const workDir = join(indexDir, "w");
  mkdirSync(workDir, { recursive: true });
  const lock = join(indexDir, ".lock");
  if (!acquireLock(lock)) { log({ msg: "another indexer run is in progress; skipped" }); return { exitCode: 0, repos: 0, rebuilt: 0, failed: 0, skippedRun: "locked" }; }
  try {
    return build(o, indexDir, workDir, log);
  } finally {
    rmSync(lock, { force: true });
  }
}

function build(o: IndexOptions, indexDir: string, workDir: string, log: (e: Record<string, unknown>) => void): IndexResult {
  const started = Date.now();
  const repos: LocalRepo[] = discoverRepos(o.projectDir);
  if (!repos.length) { log({ level: "error", msg: "no git repositories found", project: resolve(o.projectDir) }); return { exitCode: 1, repos: 0, rebuilt: 0, failed: 0 }; }

  const prev = readJson<{ repos: Array<{ key: string; fingerprint?: string; indexedAt?: string }> }>(join(indexDir, "repos.json"));
  const prevFp = new Map((prev?.repos ?? []).map((r) => [r.key, r.fingerprint]));
  const manifest: Array<Record<string, unknown>> = [];
  const skipped: Array<{ key: string; dir: string; error: string }> = [];
  const graphs: Array<{ key: string; path: string }> = [];
  let rebuilt = 0;

  for (const repo of repos) {
    try {
      const state = repoState(repo.dir);
      const out = join(workDir, workName(repo.key));
      const graphPath = join(out, "graphify-out", "graph.json");
      const fresh = !o.force && prevFp.get(repo.key) === state.fingerprint && existsSync(graphPath);
      if (!fresh) {
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
        extractRepo(repo.dir, out);
        rebuilt++;
      }
      if (existsSync(graphPath)) graphs.push({ key: repo.key, path: graphPath });
      manifest.push({ key: repo.key, dir: repo.dir, branch: state.branch, commit: state.commit, dirty: state.dirty, fingerprint: state.fingerprint, indexedAt: fresh ? undefined : new Date().toISOString(), status: "ok" });
      log({ repo: repo.key, branch: state.branch, commit: state.commit.slice(0, 8), dirty: state.dirty, reused: fresh });
    } catch (err) {
      const error = String(err).slice(0, 800);
      log({ repo: repo.key, level: "error", error });
      skipped.push({ key: repo.key, dir: repo.dir, error });
    }
  }
  if (!graphs.length) { log({ level: "error", msg: "no graphs built; previous index kept" }); return { exitCode: 1, repos: repos.length, rebuilt, failed: skipped.length }; }

  const keys = new Set(graphs.map((g) => g.key));
  const keepKeys = manifest.filter((m) => keys.has(String(m.key)));
  if (!rebuilt && !o.force && prev && keepKeys.length === prev.repos.length && existsSync(join(indexDir, "graph.json"))) {
    log({ msg: "index is up to date", repos: keepKeys.length });
    return { exitCode: skipped.length ? 2 : 0, repos: repos.length, rebuilt: 0, failed: skipped.length, skippedRun: "up-to-date" };
  }
  const prevIndexed = new Map((prev?.repos ?? []).map((r) => [r.key, r.indexedAt]));
  for (const m of keepKeys) m.indexedAt ??= prevIndexed.get(String(m.key)) ?? new Date().toISOString();

  // Merge: our own lossless, directed merge; Graphify's merge-graphs only contributes the cross-repo edges it finds
  const inputs = graphs.map((g) => ({ key: g.key, graph: JSON.parse(readFileSync(g.path, "utf8")) }));
  let graphifyMerged: Graph | undefined;
  if (graphs.length > 1) {
    const merged = join(workDir, "merged.raw.json");
    try {
      mergeGraphs(graphs.map((g) => g.path), merged);
      graphifyMerged = JSON.parse(readFileSync(merged, "utf8")) as Graph;
    } catch (err) {
      log({ level: "warn", msg: "graphify merge-graphs failed; its cross-repo edges are skipped", error: String(err).slice(0, 300) });
    }
    rmSync(merged, { force: true });
  }
  const { graph: mergedGraph, importedCrossRepo } = mergeRepoGraphs(inputs, graphifyMerged);
  const graph = prepareMergedGraph(mergedGraph, [...keys]);

  const repoDirs = keepKeys.map((m) => ({ repo: String(m.key), dir: String(m.dir) }));
  const http = linkHttpAll(repoDirs, o.manualHosts ?? {});
  const links: CrossLink[] = [...http.links, ...linkPackages(repoDirs)];
  const applied = applyLinks(graph, links);
  const hosts = [...http.hosts.values()];
  for (const m of keepKeys) {
    m.files = listFiles(String(m.dir)).length;
    m.hosts = hosts.filter((h) => h.repo === m.key).map((h) => ({ host: h.host, variants: h.variants, source: h.source, votes: h.votes }));
  }

  writeJsonAtomic(join(indexDir, "graph.json"), graph);
  writeJsonAtomic(join(indexDir, "links.json"), links);
  writeJsonAtomic(join(indexDir, "hosts.json"), { builtAt: new Date().toISOString(), hosts });
  writeJsonAtomic(join(indexDir, "repos.json"), { builtAt: new Date().toISOString(), project: resolve(o.projectDir), repos: keepKeys, skipped });
  for (const k of repos.map((r) => r.key)) if (!keys.has(k)) rmSync(join(workDir, workName(k)), { recursive: true, force: true });

  const usage = { used: links.filter((l) => l.usage !== "declared").length, declared: links.filter((l) => l.usage === "declared").length };
  log({ msg: "index published", repos: keepKeys.length, rebuilt, nodes: graph.nodes.length, edges: graph.links.length, crossLinks: links.length, usage, graphifyCrossRepoEdges: importedCrossRepo, linkedEdges: applied.added, unresolved: applied.unresolved, seconds: Math.round((Date.now() - started) / 1000) });
  return { exitCode: skipped.length ? 2 : 0, repos: repos.length, rebuilt, failed: skipped.length };
}
