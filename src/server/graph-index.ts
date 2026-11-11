// Lightweight index of the published graph (cache until graph.json mtime changes):
//   • symbolAt(file, line) — "Class.method" for a call/endpoint site (dependencies response)
//   • hubs(repo) — architecture hubs instead of the raw degree
import { existsSync, readFileSync } from "node:fs";
import { type CodeGraph, GraphCache } from "./graph-tools.js";
import { join } from "node:path";

interface Node { id: string; label: string; file_type?: string; source_file?: string; source_location?: string; repo?: string; type?: string; metadata?: { kind?: string } }
interface Edge { source: string; target: string; relation: string; source_file?: string; source_location?: string; metadata?: Record<string, unknown>; _origin?: string }

export interface Hub {
  symbol: string; kind: "class" | "function"; at: string; score: number; fanInFiles: number;
  callers: string[]; incomingCrossRepo: Array<{ repo: string; calls: number }>;
}
export interface HubsResult { repo: string; hubs: Hub[]; compositionRoots: string[] }

const lineOf = (n: { source_location?: string }) => Number(String(n.source_location ?? "").replace(/^L/, "")) || 0;
const isMethod = (n: Node) => n.label.startsWith(".");
const isFileNode = (n: Node) => /\.[A-Za-z0-9]{1,6}$/.test(n.label) && n.source_file?.endsWith(n.label);
const isNamespace = (n: Node) => n.type === "namespace" || /namespace/.test(n.metadata?.kind ?? "");
// composition roots and aggregators (spec 03 §4.4 item 2)
const AGGREGATOR_FILE = /(^|\/)(index\.ts|models\.ts|services\.ts|public-api\.ts|[^/]*\.module\.ts)$/;
const COMPOSITION_ROOT = /(^|\/)(Program|Startup)\.(cs|fs)$|(^|\/)main\.tsx?$/;
// behavioral links weigh 1, "type mention only" (references) — 0.5: everyone mentions DTOs, while architecture is held by services and controllers
const BEHAVIOR = new Set(["calls", "implements", "inherits", "extends", "http_calls", "indirect_call", "dispatches_to"]);
const FAN_IN_RELATIONS = new Set([...BEHAVIOR, "references"]);
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|[^/]*\.Tests?|[^/]*\.UnitTests|[^/]*\.IntegrationTests)\/|\.(spec|test)\.[jt]sx?$/i;
const DEFAULT_DENY = [/^System(\.|$)/, /^Microsoft\./, /^@angular\//, /^rxjs/, /^(string|int|bool|object|DateTime|Guid|Task|List|IEnumerable|Dictionary|Promise|Observable|Array|Map|Set)$/];

export class GraphIndex {
  private loaded?: CodeGraph;
  private nodes = new Map<string, Node>();
  private byFile = new Map<string, Node[]>();
  private edges: Edge[] = [];
  private methodOwner = new Map<string, string>();
  private hubCache = new Map<string, HubsResult>();

  /**
   * graph — the process-wide shared graph (GraphCache from graph-tools), or a path to graph.json (tests).
   * source — where a graph `source_file` ("repo/path") lives on disk: a root folder holding the repos, or a resolver.
   */
  constructor(graph: GraphCache | string, source: string | ((sourceFile: string) => string | undefined), private readonly deny: RegExp[] = DEFAULT_DENY) {
    this.cache = typeof graph === "string" ? new GraphCache(graph) : graph;
    this.resolve = typeof source === "string" ? (f) => join(source, f) : source;
  }
  private readonly resolve: (sourceFile: string) => string | undefined;
  private readonly cache: GraphCache;

  private load(): boolean {
    const g = this.cache.get();
    if (!g) return false;
    if (g === this.loaded) return true;
    this.nodes = g.nodes as Map<string, Node>;
    this.byFile = new Map();
    for (const n of this.nodes.values()) if (n.source_file && n.file_type === "code") (this.byFile.get(n.source_file) ?? this.byFile.set(n.source_file, []).get(n.source_file)!).push(n);
    for (const list of this.byFile.values()) list.sort((a, b) => lineOf(a) - lineOf(b));
    this.edges = [];
    for (const [u, m] of g.succ) for (const [v, d] of m) this.edges.push({ ...(d as object), source: u, target: v } as Edge);
    this.methodOwner = new Map(this.edges.filter((e) => e.relation === "method").map((e) => [e.target, e.source]));
    this.hubCache.clear();
    this.loaded = g;
    return true;
  }

  /** "EmployeesState.sendPatch" for repo/path:line; undefined — the file is not in the graph. */
  symbolAt(ref: string): string | undefined {
    if (!this.load()) return undefined;
    const [file, l] = ref.split(/:(?=\d+$)/);
    const line = Number(l ?? 1);
    const list = (this.byFile.get(file) ?? []).filter((n) => lineOf(n) <= line && !isFileNode(n) && !isNamespace(n));
    const method = [...list].reverse().find(isMethod);
    // class — the owner of the method via the `method` edge; otherwise the nearest non-method declared above
    const ownerId = method ? this.methodOwner.get(method.id) : undefined;
    const cls = (ownerId ? this.nodes.get(ownerId) : undefined) ?? [...list].reverse().find((n) => !isMethod(n) && (!method || lineOf(n) <= lineOf(method)));
    const m = method?.label.replace(/^\./, "").replace(/\(\)$/, "");
    return cls && m ? `${cls.label}.${m}` : (m ?? cls?.label);
  }

  private declaredInRepo(n: Node): boolean {
    // framework stubs (DateTime, @angular/core) are bound by Graphify to the first file that mentions them: they are not on the declaration line
    if (!n.source_file || !lineOf(n)) return false;
    const path = this.resolve(n.source_file);
    if (!path || !existsSync(path)) return false;
    const text = readFileSync(path, "utf8").split("\n");
    const lines = text.slice(Math.max(0, lineOf(n) - 1), lineOf(n) + 8).join("\n");   // attributes above class can shift the line
    const name = n.label.replace(/[<(].*$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(String.raw`\b(class|interface|record|struct|enum|type|function|def|member|const|let|var|export|module)\b[^\n]*\b${name}\b`).test(lines);
  }

  hubs(repo: string, limit = 15): HubsResult {
    if (!this.load()) return { repo, hubs: [], compositionRoots: [] };
    const cached = this.hubCache.get(`${repo}:${limit}`);
    if (cached) return cached;
    // node → owner (method → class), so that method fan-in is counted for the class
    const owner = new Map<string, string>();
    for (const e of this.edges) if (e.relation === "method" || e.relation === "defines") owner.set(e.target, e.source);
    const ownerOf = (id: string) => { let cur = id; for (let i = 0; i < 3 && owner.has(cur) && isMethod(this.nodes.get(cur) ?? { label: "" } as Node); i++) cur = owner.get(cur)!; return cur; };

    const fanFiles = new Map<string, Set<string>>();
    const behaviorFiles = new Map<string, Set<string>>();
    const callers = new Map<string, string[]>();
    const crossRepo = new Map<string, Map<string, number>>();
    for (const e of this.edges) {
      if (!FAN_IN_RELATIONS.has(e.relation)) continue;
      const tgt = this.nodes.get(e.target);
      if (!tgt || tgt.repo !== repo) continue;
      const hubId = ownerOf(e.target);
      const src = this.nodes.get(e.source);
      const srcFile = e.source_file ?? src?.source_file;
      const hub = this.nodes.get(hubId);
      if (!srcFile || !hub || srcFile === hub.source_file || TEST_PATH.test(srcFile)) continue;
      (fanFiles.get(hubId) ?? fanFiles.set(hubId, new Set()).get(hubId)!).add(srcFile);
      if (BEHAVIOR.has(e.relation)) (behaviorFiles.get(hubId) ?? behaviorFiles.set(hubId, new Set()).get(hubId)!).add(srcFile);
      const list = callers.get(hubId) ?? callers.set(hubId, []).get(hubId)!;
      if (list.length < 3 && src) {
        const sym = this.symbolAt(`${srcFile}:${e.source_location ? lineOf(e) : lineOf(src)}`) ?? src.label;
        const ref = `${sym} (${srcFile}:${e.source_location ? lineOf(e) : lineOf(src)})`;
        if (!list.some((x) => x.startsWith(`${sym} (`))) list.push(ref);
      }
      if (e.relation === "http_calls" && src?.repo && src.repo !== repo) {
        const m = crossRepo.get(hubId) ?? crossRepo.set(hubId, new Map()).get(hubId)!;
        m.set(src.repo, (m.get(src.repo) ?? 0) + 1);
      }
    }
    const hubs: Hub[] = [];
    const roots = new Set<string>();
    for (const [id, filesSet] of fanFiles) {
      const n = this.nodes.get(id)!;
      if (n.file_type !== "code" || isMethod(n) || isFileNode(n) || isNamespace(n)) continue;
      if (this.deny.some((re) => re.test(n.label))) continue;
      if (n.source_file && (AGGREGATOR_FILE.test(n.source_file) || TEST_PATH.test(n.source_file))) continue;
      if (n.source_file && COMPOSITION_ROOT.test(n.source_file)) { roots.add(`${n.label} (${n.source_file}:${lineOf(n)})`); continue; }
      if (!this.declaredInRepo(n)) continue;
      const cross = crossRepo.get(id);
      const crossCalls = cross ? [...cross.values()].reduce((a, b) => a + b, 0) : 0;
      hubs.push({
        symbol: n.label, kind: /function|def\b/.test(n.label) ? "function" : "class", at: `${n.source_file}:${lineOf(n)}`,
        score: Math.round(((behaviorFiles.get(id)?.size ?? 0) + 0.5 * (filesSet.size - (behaviorFiles.get(id)?.size ?? 0)) + 3 * crossCalls) * 10) / 10,
        fanInFiles: filesSet.size, callers: callers.get(id) ?? [],
        incomingCrossRepo: cross ? [...cross].map(([r, c]) => ({ repo: r, calls: c })) : [],
      });
    }
    hubs.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const res = { repo, hubs: hubs.slice(0, limit), compositionRoots: [...roots].slice(0, 5) };
    this.hubCache.set(`${repo}:${limit}`, res);
    return res;
  }
}
