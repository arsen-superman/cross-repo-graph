// Cross-repo linker (spec 03): links BETWEEN repositories that Graphify does not create. Deterministic, no LLM.
// Every link has evidence (file:line on both sides), usage (used / declared) and confidence (EXTRACTED / INFERRED / AMBIGUOUS).
//
// Modules:
//   linker/server.ts     S-1…S-5  ASP.NET Core endpoints (C#, F#), minimal API
//   linker/generated.ts  L-1      generated clients: ng-openapi-gen, OpenAPI spec, NSwag, Refit → used / declared
//   linker/config.ts     L-2/L-3b addresses from appsettings: URL assembly, HTTP method from the call, named HttpClient; C-8 environment*.ts
//   linker/direct.ts     C-1/C-2  direct calls with a literal path
//   linker/link.ts       matching, host catalog (L-3a), external services (L-3c)
// Packages (NuGet / npm) — here. New linkers (docker-compose, k8s, queues, gRPC) are added through the same interface.
import { basename } from "node:path";
import { type ClientCall, type CrossLink, type Endpoint, type RepoMirror, clearCaches, files, read } from "./linker/common.js";
import { extractServerEndpoints } from "./linker/server.js";
import { generatedCalls, generatedOps } from "./linker/generated.js";
import { configUrlCalls, configUrls, namedClientCalls } from "./linker/config.js";
import { directCalls } from "./linker/direct.js";
import { type HostCatalog, externalFromConfig, matchCalls } from "./linker/link.js";

export { normalizeRoute } from "./linker/common.js";
export { extractServerEndpoints } from "./linker/server.js";
export type { CrossLink, RepoMirror } from "./linker/common.js";

export interface GraphNode { id: string; label: string; file_type?: string; source_file?: string; source_location?: string; repo?: string; [k: string]: unknown }
export interface GraphEdge { source: string; target: string; relation: string; confidence: string; source_file?: string; source_location?: string; weight?: number; metadata?: Record<string, unknown>; _origin?: string }
export interface Graph { nodes: GraphNode[]; links: GraphEdge[]; [k: string]: unknown }

/** All client facts of a repo: L-1, L-2, L-3b override direct calls on the same line. */
export function extractClientCalls(m: RepoMirror): ClientCall[] {
  const { genFiles } = generatedOps(m);
  const cfg = configUrls(m);
  const precise = [...generatedCalls(m), ...configUrlCalls(m, cfg), ...namedClientCalls(m, cfg)];
  const at = new Set(precise.filter((c) => c.usage === "used").map((c) => `${c.file}:${c.line}`));
  const direct = directCalls(m, genFiles).filter((c) => !at.has(`${c.file}:${c.line}`));
  return [...precise, ...direct].filter((c) => c.route.length > 0 || c.pattern.startsWith("L-3b"));
}

export interface LinkAllResult { links: CrossLink[]; hosts: HostCatalog; stats: Record<string, number> }

/** HTTP links (used / declared), repo-level links via config, and external services. */
export function linkHttpAll(mirrors: RepoMirror[], manualHosts: Record<string, string> = {}): LinkAllResult {
  clearCaches();
  const servers: Endpoint[] = mirrors.flatMap(extractServerEndpoints);
  const calls = mirrors.flatMap(extractClientCalls);
  const { links, catalog, stats } = matchCalls(mirrors, servers, calls, manualHosts);
  const ext = externalFromConfig(mirrors, catalog);
  // external service — one link per (repo, host, key)
  const seen = new Set(links.filter((l) => l.kind === "depends_on_external").map((l) => `${l.fromRepo}|${l.toRepo}|${String(l.detail.key ?? "")}`));
  for (const l of ext) { const k = `${l.fromRepo}|${l.toRepo}|${String(l.detail.key ?? "")}`; if (!seen.has(k)) { seen.add(k); links.push(l); } }
  return { links, hosts: catalog, stats: { ...stats, servers: servers.length, externalLinks: links.filter((l) => l.kind === "depends_on_external").length } };
}

/** Compatibility with the earlier format: just an array of links. */
export function linkHttp(mirrors: RepoMirror[], manualHosts: Record<string, string> = {}): CrossLink[] {
  return linkHttpAll(mirrors, manualHosts).links;
}

// ---------------------------------------------------------------- packages
export function linkPackages(mirrors: RepoMirror[]): CrossLink[] {
  const producers = new Map<string, { repo: string; file: string }>();
  const consumers: Array<{ repo: string; file: string; pkg: string; version?: string; ecosystem: string }> = [];
  for (const m of mirrors) {
    for (const f of files(m.dir)) {
      if (/\.(cs|fs|vb)proj$/.test(f)) {
        const x = read(m, f);
        const id = /<PackageId>([^<]+)<\/PackageId>/.exec(x)?.[1] ?? /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(x)?.[1] ?? basename(f).replace(/\.\w+proj$/, "");
        const packable = !/<IsPackable>\s*false\s*<\/IsPackable>/i.test(x);
        if (packable) producers.set(`nuget:${id.toLowerCase()}`, { repo: m.repo, file: f });
        for (const r of x.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) {
          consumers.push({ repo: m.repo, file: f, pkg: `nuget:${r[1].toLowerCase()}`, version: r[2], ecosystem: "nuget" });
        }
      } else if (basename(f) === "package.json") {
        try {
          const j = JSON.parse(read(m, f));
          if (j.name) producers.set(`npm:${String(j.name).toLowerCase()}`, { repo: m.repo, file: f });
          for (const sec of ["dependencies", "devDependencies", "peerDependencies"]) {
            for (const [name, ver] of Object.entries<string>(j[sec] ?? {})) {
              consumers.push({ repo: m.repo, file: f, pkg: `npm:${name.toLowerCase()}`, version: ver, ecosystem: "npm" });
            }
          }
        } catch { /* invalid package.json — skip */ }
      }
    }
  }
  const links: CrossLink[] = [];
  for (const c of consumers) {
    const p = producers.get(c.pkg);
    if (!p || p.repo === c.repo) continue;
    links.push({
      kind: "depends_on_package", fromRepo: c.repo, toRepo: p.repo, from: `${c.repo}/${c.file}`, to: `${p.repo}/${p.file}`,
      detail: { package: c.pkg.split(":")[1], ecosystem: c.ecosystem, version: c.version },
    });
  }
  return links;
}

// ---------------------------------------------------------------- merge into graph
/** Preparing the merged graph: source_file with the repo prefix (unambiguous paths for read_file), repository nodes. */
export function prepareMergedGraph(g: Graph, repos: string[]): Graph {
  for (const n of g.nodes) {
    const repo = n.repo ?? n.id.split("::")[0];
    n.repo = repo;
    if (n.source_file && !n.source_file.startsWith(`${repo}/`)) n.source_file = `${repo}/${n.source_file}`;
  }
  for (const e of g.links) {
    const repo = e.source.split("::")[0];
    if (e.source_file && !e.source_file.startsWith(`${repo}/`)) e.source_file = `${repo}/${e.source_file}`;
  }
  for (const r of repos) {
    g.nodes.push({ id: `${r}::__repo__`, label: `repo:${r}`, file_type: "repository", repo: r, source_file: `${r}/`, source_location: "L1", _origin: "linker" });
  }
  return g;
}

/** Finds the deepest graph node enclosing file:line (method → class → file). */
function enclosingNode(g: Graph, byFile: Map<string, GraphNode[]>, fileRef: string): GraphNode | undefined {
  const [file, lineStr] = fileRef.split(/:(?=\d+$)/);
  const line = Number(lineStr ?? 1);
  const cands = (byFile.get(file) ?? []).filter((n) => Number(String(n.source_location ?? "L1").slice(1)) <= line);
  cands.sort((a, b) => Number(String(b.source_location).slice(1)) - Number(String(a.source_location).slice(1)) || (a.label.startsWith(".") ? -1 : 1));
  return cands[0];
}

export function applyLinks(g: Graph, links: CrossLink[]): { added: number; unresolved: number; declaredOnly: number } {
  const byFile = new Map<string, GraphNode[]>();
  for (const n of g.nodes) if (n.source_file) (byFile.get(n.source_file) ?? byFile.set(n.source_file, []).get(n.source_file)!).push(n);
  const ids = new Set(g.nodes.map((n) => n.id));
  let added = 0, unresolved = 0, declaredOnly = 0;
  const seen = new Set<string>();
  for (const l of links) {
    if (l.fromRepo === l.toRepo) continue;
        // external service — node external::<host> (shared across all repos)
    const target = l.kind === "depends_on_external" ? l.toRepo : `${l.toRepo}::__repo__`;
    if (l.kind === "depends_on_external" && !ids.has(target)) {
      ids.add(target);
      g.nodes.push({ id: target, label: target, file_type: "external", repo: "external", source_file: "", source_location: "", category: l.detail.category, _origin: "linker" });
    }
        // repository level — always, also for declared (spec 03 §2: declared stays at the repo level)
    const repoKey = `${l.fromRepo}->${target}:${l.kind}:${l.usage ?? "used"}`;
    if (!seen.has(repoKey)) {
      seen.add(repoKey);
      g.links.push({ source: `${l.fromRepo}::__repo__`, target, relation: `repo_${l.kind}${l.usage === "declared" ? "_declared" : ""}`, confidence: "INFERRED", weight: 1, _origin: "linker", metadata: { example: l.detail } });
      added++;
    }
        // symbol level — only http_calls with a call site (usage=used); declared and config_http_calls — no
    if (l.kind !== "http_calls") continue;
    if (l.usage === "declared") { declaredOnly++; continue; }
    const a = enclosingNode(g, byFile, l.from), b = enclosingNode(g, byFile, l.to);
    if (!a || !b) { unresolved++; continue; }
    const [file, line] = l.from.split(/:(?=\d+$)/);
    g.links.push({
      source: a.id, target: b.id, relation: "http_calls",
      confidence: l.confidence ?? (Number(l.detail.candidates) > 1 ? "AMBIGUOUS" : "INFERRED"),
      source_file: file, source_location: `L${line}`, weight: 1, _origin: "linker", metadata: { ...l.detail, usage: l.usage },
    });
    added++;
  }
  return { added, unresolved, declaredOnly };
}

// ---------------------------------------------------------------- lossless merge of per-repo graphs
/**
 * Lossless merge of repository graphs: the `<repo>::` prefix on ids, concatenation of nodes and edges,
 * edge direction is kept as is (directed).
 *
 * Why not just `graphify merge-graphs`: it composes into an UNdirected nx.Graph, so opposite edges
 * (A→B and B→A, e.g. mutual recursion) and different edges between the same pair of nodes collapse into one
 * (verified on 0.9.66). For impact analysis ("who calls me") this loses callers.
 * On the other hand, merge-graphs in 0.9.66 can append ITS OWN cross-repo edges (shared types, member calls
 * via a package — #3007/#3152), so we take them from its result (`graphifyMerged`) if present.
 */
export function mergeRepoGraphs(
  inputs: Array<{ key: string; graph: { nodes: GraphNode[]; edges?: GraphEdge[]; links?: GraphEdge[] } }>,
  graphifyMerged?: { nodes: GraphNode[]; links?: GraphEdge[]; edges?: GraphEdge[] },
): { graph: Graph; importedCrossRepo: number } {
  const nodes: GraphNode[] = [];
  const links: GraphEdge[] = [];
  const keys = new Set(inputs.map((i) => i.key));
  for (const { key, graph } of inputs) {
    for (const n of graph.nodes) nodes.push({ ...n, id: `${key}::${n.id}`, repo: key, local_id: n.id });
    for (const e of graph.edges ?? graph.links ?? []) links.push({ ...e, source: `${key}::${e.source}`, target: `${key}::${e.target}` });
  }
  let importedCrossRepo = 0;
  if (graphifyMerged) {
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of graphifyMerged.links ?? graphifyMerged.edges ?? []) {
      const a = e.source.split("::")[0], b = e.target.split("::")[0];
            // only edges between different repos, and only if graphify tags = our keys (otherwise ids will not match)
      if (a === b || !keys.has(a) || !keys.has(b) || !ids.has(e.source) || !ids.has(e.target)) continue;
      links.push({ ...e, _origin: e._origin ?? "graphify-merge" });
      importedCrossRepo++;
    }
  }
  return { graph: { directed: true, multigraph: false, graph: {}, hyperedges: [], nodes, links }, importedCrossRepo };
}
