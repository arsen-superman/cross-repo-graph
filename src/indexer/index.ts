// Indexer: one graph per scope (default: dev = develop, prod = main / master) over all repositories of a project.
//
//   <index>/index.json                       what was built: mode, scopes, last fetch
//   <index>/scopes/<scope>/graph.json        merged graph of all repos + cross-repo links (the server reads these)
//   <index>/scopes/<scope>/links.json        cross-repo links
//   <index>/scopes/<scope>/repos.json        per repo: branch, commit, where its source is
//   <index>/s/<id>/                          source of one (repo, commit), extracted from git — shared by scopes
//   <index>/g/<id>/graphify-out/graph.json   Graphify's AST graph of that source
//
// Git mode (default) reads each scope's branch from git (origin/<branch> preferred), so what is checked out or
// uncommitted in a clone never leaks into the graph; a (repo, commit) is extracted and parsed once, whichever
// scopes point at it. Working-tree mode (--working-tree) indexes the clones as they are on disk, as one "dev" scope.
// Every output file is replaced atomically; a lock keeps runs from overlapping.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, specFor, type IndexConfig } from "./config.js";
import { candidates, extractCommit, fetchBranches, fetchedAt, resolveRef } from "./git.js";
import { extractRepo, mergeGraphs } from "./graphify.js";
import { applyLinks, linkHttpAll, linkPackages, mergeRepoGraphs, prepareMergedGraph, type CrossLink, type Graph } from "./linker.js";
import { discoverRepos, repoState, type LocalRepo } from "./repos.js";
import { listFiles } from "./files.js";

/** Options of one indexer run. */
export interface IndexOptions {
  projectDir: string;
  indexDir: string;
  /** Index the clones as they are on disk (one "dev" scope) instead of the scope branches from git. */
  workingTree?: boolean;
  /** Fetch the scope branches from origin before indexing (unless config.json says fetch: false). */
  fetch?: boolean;
  /** Skip the fetch if the last one was less than this many minutes ago. */
  fetchMinIntervalMin?: number;
  /** Re-parse every repo even if its commit was parsed before. */
  force?: boolean;
  /** Manual host → repo key entries for the linker (merged over config.json hosts). */
  manualHosts?: Record<string, string>;
  log?: (e: Record<string, unknown>) => void;
}
/** Outcome of a run: 0 — everything indexed, 2 — published without some repos, 1 — nothing published. */
export interface IndexResult { exitCode: 0 | 1 | 2; repos: number; rebuilt: number; failed: number; skippedRun?: "locked" }

interface Item { key: string; repoDir: string; id: string; srcDir: string; branch: string; ref: string; commit: string; committedAt?: string; dirty?: boolean; fingerprint?: string }
interface RepoEntry { key: string; id: string; indexedAt?: string; [k: string]: unknown }

const LOCK_STALE_MS = 30 * 60 * 1000;
const short = (s: string, n = 12) => createHash("sha1").update(s).digest("hex").slice(0, n);
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

/** Indexes the project; returns at once when another run holds the lock. */
export async function runIndex(o: IndexOptions): Promise<IndexResult> {
  const log = o.log ?? ((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), ...e })));
  const indexDir = resolve(o.indexDir);
  mkdirSync(indexDir, { recursive: true });
  const lock = join(indexDir, ".lock");
  if (!acquireLock(lock)) { log({ msg: "another indexer run is in progress; skipped" }); return { exitCode: 0, repos: 0, rebuilt: 0, failed: 0, skippedRun: "locked" }; }
  try {
    return await build(o, indexDir, log);
  } finally {
    rmSync(lock, { force: true });
  }
}

async function build(o: IndexOptions, indexDir: string, log: (e: Record<string, unknown>) => void): Promise<IndexResult> {
  const started = Date.now();
  const cfg = loadConfig(indexDir);
  const repos: LocalRepo[] = discoverRepos(o.projectDir);
  if (!repos.length) { log({ level: "error", msg: "no git repositories found", project: resolve(o.projectDir) }); return { exitCode: 1, repos: 0, rebuilt: 0, failed: 0 }; }
  const mode = o.workingTree ? "working-tree" : "git";
  const scopes = o.workingTree ? ["dev"] : Object.keys(cfg.scopes);
  let lastFetch = readJson<{ lastFetch?: string }>(join(indexDir, "index.json"))?.lastFetch;

  if (!o.workingTree && o.fetch && cfg.fetch) {
    const due = !lastFetch || !o.fetchMinIntervalMin || Date.now() - Date.parse(lastFetch) >= o.fetchMinIntervalMin * 60_000;
    if (due) {
      const results = await Promise.all(repos.map(async (r) => {
        const branches = [...new Set(scopes.flatMap((s) => candidates(r.dir, specFor(cfg, r.key, s))))];
        return { repo: r.key, ...(await fetchBranches(r.dir, branches)) };
      }));
      for (const f of results) if (!f.ok) log({ level: "warn", repo: f.repo, msg: "fetch skipped or failed; indexing local refs", error: f.error });
      log({ msg: "fetched", ok: results.filter((f) => f.ok).length, failed: results.filter((f) => !f.ok).length, ms: Math.max(0, ...results.map((f) => f.ms)) });
      lastFetch = new Date().toISOString();
    } else log({ msg: "fetch skipped (interval)", lastFetch });
  }

  let rebuilt = 0;
  const failedKeys = new Set<string>();
  const used = new Set<string>();
  for (const scope of scopes) {
    const items: Item[] = [];
    const skipped: Array<{ key: string; error: string }> = [];
    for (const r of repos) {
      try {
        const it = o.workingTree ? workingTreeItem(r) : gitItem(r, cfg, scope);
        if (!it) { skipped.push({ key: r.key, error: `no branch matches "${specFor(cfg, r.key, scope)}"` }); continue; }
        it.srcDir ||= join(indexDir, "s", it.id);
        const graphDir = join(indexDir, "g", it.id);
        const fpPath = join(graphDir, "fingerprint");
        const fresh = !o.force && existsSync(join(graphDir, "graphify-out", "graph.json")) && (!it.fingerprint || readJson<string>(fpPath) === it.fingerprint);
        if (!fresh) {
          if (!o.workingTree) extractCommit(r.dir, it.commit, it.srcDir);
          rmSync(graphDir, { recursive: true, force: true });
          mkdirSync(graphDir, { recursive: true });
          extractRepo(it.srcDir, graphDir);
          rmSync(join(graphDir, "graphify-out", "cache"), { recursive: true, force: true });   // Graphify's own incremental cache: unused, ~3x the graph
          if (it.fingerprint) writeFileSync(fpPath, JSON.stringify(it.fingerprint));
          rebuilt++;
        }
        used.add(it.id);
        items.push(it);
        log({ scope, repo: r.key, ref: it.ref, commit: it.commit.slice(0, 8), reused: fresh });
      } catch (err) {
        const error = String(err).slice(0, 800);
        log({ scope, repo: r.key, level: "error", error });
        skipped.push({ key: r.key, error });
        failedKeys.add(r.key);
      }
    }
    if (!items.length) { log({ scope, level: "error", msg: "no graphs built; previous scope index kept" }); continue; }
    publishScope(indexDir, scope, items, skipped, cfg, o, log);
  }

  // drop sources and graphs no scope points at any more (old commits, removed repos) and leftovers of failed runs
  for (const sub of ["s", "g"]) {
    const dir = join(indexDir, sub);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) if (!used.has(d)) rmSync(join(dir, d), { recursive: true, force: true });
  }
  // 0.1.0 layout
  rmSync(join(indexDir, "w"), { recursive: true, force: true });
  for (const f of ["graph.json", "links.json", "hosts.json", "repos.json"]) rmSync(join(indexDir, f), { force: true });

  const published = Object.keys(o.workingTree ? { dev: 1 } : cfg.scopes).filter((s) => existsSync(join(indexDir, "scopes", s, "graph.json")));
  writeJsonAtomic(join(indexDir, "index.json"), { builtAt: new Date().toISOString(), project: resolve(o.projectDir), mode, scopes: published, lastFetch });
  log({ msg: "index done", mode, scopes: published, repos: repos.length, rebuilt, failed: failedKeys.size, seconds: Math.round((Date.now() - started) / 1000) });
  if (!published.length) return { exitCode: 1, repos: repos.length, rebuilt, failed: failedKeys.size };
  return { exitCode: failedKeys.size ? 2 : 0, repos: repos.length, rebuilt, failed: failedKeys.size };
}

function gitItem(r: LocalRepo, cfg: IndexConfig, scope: string): Item | undefined {
  const ref = resolveRef(r.dir, specFor(cfg, r.key, scope));
  return ref && { key: r.key, repoDir: r.dir, id: short(`${r.key}\0${ref.commit}`), srcDir: "", ...ref };
}

function workingTreeItem(r: LocalRepo): Item {
  const st = repoState(r.dir);
  return { key: r.key, repoDir: r.dir, id: `wt${short(r.key, 10)}`, srcDir: r.dir, branch: st.branch, ref: st.branch || "HEAD", commit: st.commit, dirty: st.dirty, fingerprint: st.fingerprint };
}

function publishScope(indexDir: string, scope: string, items: Item[], skipped: Array<{ key: string; error: string }>, cfg: IndexConfig, o: IndexOptions, log: (e: Record<string, unknown>) => void): void {
  const scopeDir = join(indexDir, "scopes", scope);
  mkdirSync(scopeDir, { recursive: true });
  const prev = readJson<{ repos: RepoEntry[] }>(join(scopeDir, "repos.json"));
  const prevByKey = new Map((prev?.repos ?? []).map((r) => [r.key, r]));
  const entries: RepoEntry[] = items.map((it) => {
    const same = prevByKey.get(it.key)?.id === it.id && !it.fingerprint;
    return {
      key: it.key, dir: it.srcDir, repoDir: it.repoDir, id: it.id, branch: it.branch, ref: it.ref, commit: it.commit, committedAt: it.committedAt,
      dirty: it.dirty, fetchedAt: fetchedAt(it.repoDir), indexedAt: same ? prevByKey.get(it.key)?.indexedAt : new Date().toISOString(),
      files: same ? prevByKey.get(it.key)?.files : listFiles(it.srcDir).length, hosts: same ? prevByKey.get(it.key)?.hosts : undefined,
    };
  });
  const unchanged = !o.force && prev && prev.repos.length === items.length && items.every((it) => prevByKey.get(it.key)?.id === it.id && !it.fingerprint)
    && existsSync(join(scopeDir, "graph.json"));
  if (unchanged) {
    writeJsonAtomic(join(scopeDir, "repos.json"), { scope, builtAt: (prev as { builtAt?: string }).builtAt, repos: entries, skipped });
    log({ scope, msg: "scope up to date", repos: items.length });
    return;
  }

  const graphOf = (it: Item) => join(indexDir, "g", it.id, "graphify-out", "graph.json");
  const inputs = items.map((it) => ({ key: it.key, graph: JSON.parse(readFileSync(graphOf(it), "utf8")) }));
  let graphifyMerged: Graph | undefined;
  if (items.length > 1) {
    const merged = join(scopeDir, "merged.raw.json");
    try {
      mergeGraphs(items.map(graphOf), merged);
      graphifyMerged = JSON.parse(readFileSync(merged, "utf8")) as Graph;
    } catch (err) {
      log({ scope, level: "warn", msg: "graphify merge-graphs failed; its cross-repo edges are skipped", error: String(err).slice(0, 300) });
    }
    rmSync(merged, { force: true });
  }
  const { graph: mergedGraph, importedCrossRepo } = mergeRepoGraphs(inputs, graphifyMerged);
  const graph = prepareMergedGraph(mergedGraph, items.map((it) => it.key));
  const repoDirs = items.map((it) => ({ repo: it.key, dir: it.srcDir }));
  const http = linkHttpAll(repoDirs, { ...cfg.hosts, ...(o.manualHosts ?? {}) });
  const links: CrossLink[] = [...http.links, ...linkPackages(repoDirs)];
  const applied = applyLinks(graph, links);
  const hosts = [...http.hosts.values()];
  for (const e of entries) {
    e.files = listFiles(String(e.dir)).length;
    e.hosts = hosts.filter((h) => h.repo === e.key).map((h) => ({ host: h.host, variants: h.variants, source: h.source, votes: h.votes }));
  }

  writeJsonAtomic(join(scopeDir, "graph.json"), graph);
  writeJsonAtomic(join(scopeDir, "links.json"), links);
  writeJsonAtomic(join(scopeDir, "hosts.json"), { scope, builtAt: new Date().toISOString(), hosts });
  writeJsonAtomic(join(scopeDir, "repos.json"), { scope, builtAt: new Date().toISOString(), repos: entries, skipped });
  const usage = { used: links.filter((l) => l.usage !== "declared").length, declared: links.filter((l) => l.usage === "declared").length };
  log({ scope, msg: "scope published", repos: items.length, nodes: graph.nodes.length, edges: graph.links.length, crossLinks: links.length, usage, graphifyCrossRepoEdges: importedCrossRepo, linkedEdges: applied.added, unresolved: applied.unresolved });
}
