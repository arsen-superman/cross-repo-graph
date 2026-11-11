// Copyright 2026 Arsen Superman. Licensed under the Apache License, Version 2.0.
// Graph query semantics ported from Graphify's graphify.serve 0.9.66 (https://github.com/Graphify-Labs/graphify,
// Apache-2.0): Python → TypeScript, run against our merged multi-repo graph. Modifications: see NOTICE.
//
// The semantics repeat Graphify so that answers match what its own MCP server would return:
//   • graph.json is read as a networkx DiGraph: parallel edges u→v collapse (the last one wins), unknown edge ends
//     become "implicit" nodes; degree = incoming + outgoing;
//   • _score_query ranking: exact / prefix / substring label match × IDF, term coverage, full query,
//     file path match; _pick_seeds seed nodes (20% gap, ≤ 3 + one per term, no duplicate labels);
//   • BFS/DFS traversal over the undirected view with the true edge direction (_src/_tgt), context filter (call, import…),
//     hubs (p99 degree, ≥ 50) are not expanded; text fitted to a token budget (~3 characters per token), seed nodes are not truncated;
//   • node lookup for get_node / get_neighbors — tiers source_exact > exact > prefix > substring, ambiguity between files.
// Not ported: community, attributes, rationale, learning overlay, Chinese segmentation via jieba (bigrams instead,
// as Graphify's own fallback).
import { existsSync, readFileSync, statSync } from "node:fs";

interface NodeData { id: string; label?: string; file_type?: string; source_file?: string; source_location?: string; [k: string]: unknown }
interface EdgeData { relation?: string; confidence?: string; context?: string; source_file?: string; source_location?: string; _src?: string; _tgt?: string; [k: string]: unknown }

const CONTROL = /[\x00-\x1f\x7f]/g;
export const sanitize = (t: unknown) => (t === undefined || t === null ? "" : String(t).replace(CONTROL, "").slice(0, 256));
const stripDiacritics = (t: unknown) => String(t ?? "").normalize("NFKD").replace(/\p{Mn}/gu, "");
/** _search_tokens: split into words without punctuation and "_" (snake_case ≡ kebab-case), without diacritics, lower-cased. */
export const searchTokens = (t: unknown) => stripDiacritics(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const QUERY_STOPWORDS = new Set([
  "how", "what", "why", "when", "where", "which", "who", "whom", "whose", "does", "did", "is", "are", "was", "were", "be", "been", "being",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must", "has", "have", "had", "the", "and", "but", "not", "for", "from", "with",
  "without", "into", "onto", "off", "that", "this", "these", "those", "there", "here", "its", "their", "them", "they", "about", "any", "all", "some",
  "work", "works", "working",
  "der", "die", "das", "den", "dem", "ein", "eine", "und", "oder", "nicht", "wie", "wer", "wann", "wo", "warum", "wieso", "welche", "welcher", "welches",
  "ist", "sind", "wird", "wurde", "hat", "haben", "kann", "koennen", "können", "soll", "muss", "sich", "bei", "mit", "von", "fuer", "für", "ueber", "über",
  "nach", "aus", "gibt", "es", "funktioniert", "geaendert", "geändert", "aendert", "ändert",
  "pourquoi", "quand", "quel", "quelle", "quels", "quelles", "quoi", "qui", "que", "est", "sont", "fonctionne", "cette", "dans", "avec", "où",
  "cómo", "como", "qué", "cuál", "cuáles", "cuándo", "dónde", "donde", "porque", "por", "para", "funciona", "está", "están", "hay",
  "qual", "quais", "quando", "onde", "são", "estão", "tem", "uma", "não",
  "perché", "cosa", "quale", "quali", "dove", "funziona", "sono", "che", "della",
]);
const RELATIONAL_INTENT = new Set(["call", "calls", "called", "caller", "callers", "invoke", "invokes", "invoked", "use", "uses", "used", "using",
  "import", "imports", "imported", "export", "exports", "exported", "extend", "extends", "extended", "implement", "implements", "implemented",
  "depend", "depends", "reference", "references", "referenced"]);
const CONTEXT_HINTS: Array<[string, string[]]> = [
  ["call", ["call", "calls", "called", "caller", "callers", "invoke", "invokes", "invoked"]],
  ["import", ["import", "imports", "imported", "module", "modules"]],
  ["field", ["field", "fields", "member", "members", "property", "properties"]],
  ["parameter_type", ["parameter", "parameters", "param", "params", "argument", "arguments"]],
  ["return_type", ["return", "returns", "returned"]],
  ["generic_arg", ["generic", "generics", "template", "templates"]],
];
const CONTEXT_ALIASES: Record<string, string> = {
  param: "parameter_type", params: "parameter_type", parameter: "parameter_type", parameters: "parameter_type", argument: "parameter_type",
  arguments: "parameter_type", arg: "parameter_type", args: "parameter_type", return: "return_type", returns: "return_type", returned: "return_type",
  generic: "generic_arg", generics: "generic_arg", template: "generic_arg", templates: "generic_arg", annotation: "attribute", annotations: "attribute",
  decorator: "attribute", decorators: "attribute", calls: "call", called: "call", invoke: "call", invocation: "call", fields: "field", property: "field",
  properties: "field", member: "field", members: "field", imports: "import", imported: "import", module: "import", modules: "import",
  exports: "export", exported: "export",
};
const EXACT = 1000, PREFIX = 100, SUBSTRING = 1, SOURCE = 0.5;

const hasChinese = (t: string) => [...t].some((c) => c >= "一" && c <= "鿿");
const isSearchable = (t: string) => (/^[a-z]+$/.test(t) ? t.length > 2 : true);
/** _query_terms: query terms without stop words (EN/DE/FR/ES/PT/IT); if only stop words remain — all of them. */
export function queryTerms(question: string): string[] {
  const terms: string[] = [];
  for (const raw of question.split(/\s+/).filter(Boolean)) {
    if (hasChinese(raw)) {
      const s = raw.toLowerCase().trim();
      const segs = s.length > 1 ? [...Array(s.length - 1).keys()].map((i) => s.slice(i, i + 2)) : [s];
      if (s.length > 1 && !segs.includes(s)) segs.push(s);
      for (const seg of segs) if (seg.trim() && isSearchable(seg.trim())) terms.push(seg.trim());
    } else {
      for (const tok of raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) if (isSearchable(tok)) terms.push(tok);
    }
  }
  const content = terms.filter((t) => !QUERY_STOPWORDS.has(t));
  return content.length ? content : terms;
}

// ---------------------------------------------------------------- graph
type Adj = Map<string, Map<string, EdgeData>>;

export class CodeGraph {
  readonly nodes = new Map<string, NodeData>();
  readonly order: string[] = [];
  readonly succ: Adj = new Map();
  readonly pred: Adj = new Map();
  private idf = new Map<string, number>();
  private views = new Map<string, UGraph>();
  /** Undirected view for traversal — cached per graph generation and set of context filters. */
  view(filters: string[]): UGraph {
    const k = [...filters].sort().join(",");
    let v = this.views.get(k);
    if (!v) { v = new UGraph(this, new Set(filters)); this.views.set(k, v); }
    return v;
  }
  private norm = new Map<string, { label: string; bare: string; tokens: string; source: string; sourceTokens: string; nidLower: string }>();

  static fromJson(data: { nodes: NodeData[]; links?: Array<EdgeData & { source: string; target: string }>; edges?: Array<EdgeData & { source: string; target: string }> }): CodeGraph {
    const g = new CodeGraph();
    for (const n of data.nodes) g.addNode(n.id, n);
    for (const e of data.links ?? data.edges ?? []) {
      const { source, target, ...attrs } = e;
      g.addNode(source); g.addNode(target);
      // DiGraph: a repeated edge u→v overwrites attributes (networkx update), the position in adjacency stays
      const prev = g.succ.get(source)!.get(target);
      const merged = prev ? { ...prev, ...attrs } : attrs;
      g.succ.get(source)!.set(target, merged);
      g.pred.get(target)!.set(source, merged);
    }
    return g;
  }
  private addNode(id: string, data?: NodeData) {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, data ?? { id });
      this.order.push(id);
      this.succ.set(id, new Map());
      this.pred.set(id, new Map());
    } else if (data) this.nodes.set(id, { ...this.nodes.get(id), ...data });
  }
  degree(id: string) { return (this.succ.get(id)?.size ?? 0) + (this.pred.get(id)?.size ?? 0); }
  label(id: string) { const l = this.nodes.get(id)?.label; return l === undefined || l === null ? id : String(l); }
  get edgeCount() { let n = 0; for (const m of this.succ.values()) n += m.size; return n; }
  /** Normalized fields for search (cached for the graph lifetime). */
  n(id: string) {
    let v = this.norm.get(id);
    if (!v) {
      const d = this.nodes.get(id)!;
      const label = stripDiacritics(d.label ?? "").toLowerCase();
      v = {
        label, bare: label.replace(/[()]+$/, ""), tokens: searchTokens(d.label ?? "").join(" "),
        source: String(d.source_file ?? "").toLowerCase(), sourceTokens: searchTokens(d.source_file ?? "").join(" "), nidLower: id.toLowerCase(),
      };
      this.norm.set(id, v);
    }
    return v;
  }
  idfOf(terms: string[]): Map<string, number> {
    const N = this.nodes.size || 1;
    const todo = terms.filter((t) => !this.idf.has(t));
    if (todo.length) {
      const df = new Map(todo.map((t) => [t, 0]));
      for (const id of this.order) { const l = this.n(id).label; for (const t of todo) if (l.includes(t)) df.set(t, df.get(t)! + 1); }
      for (const t of todo) this.idf.set(t, Math.log(1 + N / (1 + df.get(t)!)));
    }
    return new Map(terms.map((t) => [t, this.idf.get(t) ?? Math.log(1 + N)]));
  }
}

/** Undirected view for traversal (_traversal_view): each edge with the true direction _src/_tgt; opposite arcs merge. */
class UGraph {
  readonly adj: Adj = new Map();
  constructor(readonly g: CodeGraph, filters?: Set<string>) {
    for (const id of g.order) this.adj.set(id, new Map());
    // like nx.Graph.add_edge: the opposite arc UPDATES attributes (merge), the position in adjacency — from the first one
    for (const u of g.order) for (const [v, d] of g.succ.get(u)!) {
      const prev = this.adj.get(u)!.get(v);
      const e = { ...(prev ?? {}), ...d, _src: d._src ?? u, _tgt: d._tgt ?? v };
      this.adj.get(u)!.set(v, e);
      this.adj.get(v)!.set(u, e);
    }
    // context filter — after the merge, like _filter_graph_by_context(_traversal_view(G))
    if (filters && filters.size) {
      for (const [a, m] of this.adj) for (const [b, e] of m) if (!filters.has(String(e.context))) { m.delete(b); this.adj.get(b)?.delete(a); }
    }
  }
  degree(id: string) { const m = this.adj.get(id)!; return m.size + (m.has(id) ? 1 : 0); }
  private hub?: number;
  hubThreshold() {
    if (this.hub === undefined) {
      const ds = [...this.adj.keys()].map((n) => this.degree(n)).sort((a, b) => a - b);
      this.hub = ds.length ? Math.max(50, ds[Math.floor(ds.length * 0.99)]) : 50;
    }
    return this.hub;
  }
}

// ---------------------------------------------------------------- ranking
interface Scored { ranked: Array<[number, string]>; bestSeedByTerm: Map<string, string> }
function scoreQuery(g: CodeGraph, terms: string[], perTerm: boolean): Scored {
  const normTerms = [...new Set(terms.flatMap((t) => searchTokens(t)))];
  const nTerms = normTerms.length;
  const idf = g.idfOf(normTerms);
  const joined = normTerms.join(" ");
  const joinedW = normTerms.length ? Math.max(...normTerms.map((t) => idf.get(t) ?? 1)) : 1;
  const scored: Array<[number, string]> = [];
  const best = new Map<string, { key: [number, number, number, string]; id: string }>();
  const lt = (a: [number, number, number, string], b: [number, number, number, string]) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] !== b[2] ? a[2] < b[2] : a[3] < b[3];
  for (const id of g.order) {
    const v = g.n(id);
    let score = 0;
    if (joined) {
      if ([v.label, v.bare, v.tokens, v.nidLower].includes(joined)) score += EXACT * 10 * joinedW;
      else if (v.label.startsWith(joined) || v.bare.startsWith(joined) || v.tokens.startsWith(joined)) score += PREFIX * 10 * joinedW;
    }
    let matched = 0, tiered = 0;
    for (const t of normTerms) {
      const w = idf.get(t) ?? 1;
      let tier = 0, substr = 0, src = 0;
      if (t === v.label || t === v.bare) { tier = EXACT * w; matched++; }
      else if (v.label.startsWith(t) || v.bare.startsWith(t)) { tier = PREFIX * w; matched++; }
      else if (v.label.includes(t)) { substr = SUBSTRING * w; score += substr; matched++; }
      if (v.source.includes(t)) { src = SOURCE * w; score += src; }
      tiered += tier;
      if (perTerm) {
        let single = [v.label, v.bare, v.tokens, v.nidLower].includes(t) ? EXACT * 10 * w
          : v.label.startsWith(t) || v.bare.startsWith(t) || v.tokens.startsWith(t) ? PREFIX * 10 * w : 0;
        single += tier + substr + src;
        if (single > 0) {
          const key: [number, number, number, string] = [-single, -g.degree(id), g.label(id).length, id];
          const cur = best.get(t);
          if (!cur || lt(key, cur.key)) best.set(t, { key, id });
        }
      }
    }
    if (tiered) score += tiered * (matched / nTerms) ** 2;
    if (score > 0) scored.push([score, id]);
  }
  scored.sort((a, b) => b[0] - a[0] || g.label(a[1]).length - g.label(b[1]).length || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return { ranked: scored, bestSeedByTerm: new Map([...best].map(([t, b]) => [t, b.id])) };
}

function pickSeeds(g: CodeGraph, scored: Array<[number, string]>, bestByTerm: Map<string, string>, maxK = 3, gap = 0.2): string[] {
  if (!scored.length) return [];
  const key = (id: string) => g.n(id).label || id;
  const top = scored[0][0];
  const seeds: string[] = [], seen = new Set<string>();
  for (const [s, id] of scored) {
    if (seeds.length >= maxK) break;
    if (seeds.length && s < top * gap) break;
    const k = key(id);
    if (seen.has(k)) continue;
    seen.add(k); seeds.push(id);
  }
  for (const t of [...bestByTerm.keys()].sort()) {
    const id = bestByTerm.get(t)!, k = key(id);
    if (!seeds.includes(id) && !seen.has(k)) { seen.add(k); seeds.push(id); }
  }
  return seeds;
}

function contextFilters(question: string, explicit?: string[]): { filters: string[]; source?: string } {
  const norm = (explicit ?? []).map((v) => stripDiacritics(v).trim().toLowerCase()).filter(Boolean).map((k) => CONTEXT_ALIASES[k] ?? k);
  const uniq = [...new Set(norm)];
  if (uniq.length) return { filters: uniq, source: "explicit" };
  const words = new Set(question.replace(/[?,]/g, " ").split(/\s+/).filter(Boolean).map((w) => stripDiacritics(w).toLowerCase()));
  const inferred = CONTEXT_HINTS.filter(([, hints]) => hints.some((h) => words.has(h))).map(([c]) => c);
  return inferred.length ? { filters: inferred, source: "heuristic" } : { filters: [] };
}

// ---------------------------------------------------------------- traversal
type EdgeList = Array<[string, string]>;
function completeInduced(u: UGraph, visited: Set<string>, edges: EdgeList) {
  const k = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const seen = new Set(edges.map(([a, b]) => k(a, b)));
  for (const a of [...visited].sort()) for (const b of u.adj.get(a)!.keys()) {
    if (a === b || !visited.has(b)) continue;
    const key = k(a, b);
    if (seen.has(key)) continue;
    seen.add(key); edges.push([a, b]);
  }
}
function bfs(u: UGraph, starts: string[], depth: number): { nodes: Set<string>; edges: EdgeList } {
  const hub = u.hubThreshold(), seeds = new Set(starts);
  const visited = new Set(starts); let frontier = new Set(starts);
  const edges: EdgeList = [];
  for (let i = 0; i < depth; i++) {
    const next = new Set<string>();
    for (const n of frontier) {
      if (!seeds.has(n) && u.degree(n) >= hub) continue;
      for (const nb of u.adj.get(n)!.keys()) if (!visited.has(nb)) { next.add(nb); edges.push([n, nb]); }
    }
    for (const x of next) visited.add(x);
    frontier = next;
  }
  completeInduced(u, visited, edges);
  return { nodes: visited, edges };
}
function dfs(u: UGraph, starts: string[], depth: number): { nodes: Set<string>; edges: EdgeList } {
  const hub = u.hubThreshold(), seeds = new Set(starts);
  const visited = new Set<string>(); const edges: EdgeList = [];
  const stack: Array<[string, number]> = [...starts].reverse().map((n) => [n, 0]);
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (visited.has(n) || d > depth) continue;
    visited.add(n);
    if (!seeds.has(n) && u.degree(n) >= hub) continue;
    for (const nb of u.adj.get(n)!.keys()) if (!visited.has(nb)) { stack.push([nb, d + 1]); edges.push([n, nb]); }
  }
  completeInduced(u, visited, edges);
  return { nodes: visited, edges };
}

function subgraphText(u: UGraph, nodes: Set<string>, edges: EdgeList, budget: number, seeds: string[]): string {
  const g = u.g, charBudget = budget * 3;
  const seedHits = seeds.filter((s) => nodes.has(s)), seedSet = new Set(seeds);
  // order: seed nodes, then by distance from seed (both directions), degree, id — so that the response survives truncation
  const dist = new Map(seedHits.map((s) => [s, 0]));
  let frontier = seedHits, hop = 0;
  while (frontier.length) {
    hop++;
    const nxt: string[] = [];
    for (const n of frontier) {
      for (const nb of u.adj.get(n)!.keys()) if (nodes.has(nb) && !dist.has(nb)) { dist.set(nb, hop); nxt.push(nb); }
    }
    frontier = nxt;
  }
  const rest = [...nodes].filter((n) => !seedSet.has(n)).sort((a, b) =>
    (dist.get(a) ?? 2 ** 30) - (dist.get(b) ?? 2 ** 30) || u.degree(b) - u.degree(a) || (a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [];
  for (const id of [...seedHits, ...rest]) {
    const d = g.nodes.get(id)!;
    lines.push(`NODE ${sanitize(g.label(id))} [src=${sanitize(d.source_file ?? "")} loc=${sanitize(d.source_location ?? "")}]`);
  }
  for (const [a, b] of edges) {
    if (!nodes.has(a) || !nodes.has(b)) continue;
    const d = u.adj.get(a)!.get(b)!;
    let src = d._src ?? a, tgt = d._tgt ?? b;
    if (!((src === a && tgt === b) || (src === b && tgt === a))) { src = a; tgt = b; }
    const ctx = d.context ? ` context=${sanitize(d.context)}` : "";
    const at = d.source_location ? ` at=${sanitize(d.source_file ?? "")}:${sanitize(d.source_location)}` : "";
    lines.push(`EDGE ${sanitize(g.label(src))} --${sanitize(d.relation ?? "")} [${sanitize(d.confidence ?? "")}${ctx}]--> ${sanitize(g.label(tgt))}${at}`);
  }
  let out = lines.join("\n");
  if (out.length <= charBudget) return out;
  let cut = out.slice(0, charBudget).lastIndexOf("\n");
  cut = cut > 0 ? cut : charBudget;
  if (seedHits.length) {
    const seedEnd = seedHits.reduce((s, _x, i) => s + lines[i].length + 1, 0) - 1;
    cut = Math.max(cut, Math.min(seedEnd, out.length));
  }
  const totalNodes = lines.filter((l) => l.startsWith("NODE ")).length;
  const shown = (out.slice(0, cut).match(/\nNODE /g) ?? []).length + (out.startsWith("NODE ") ? 1 : 0);
  const cutCount = totalNodes - shown;
  if (cutCount === 0) {
    const totalEdges = lines.filter((l) => l.startsWith("EDGE ")).length;
    return `[i] Complete answer over budget: all ${totalNodes} nodes and ${totalEdges} edges shown (~${Math.floor(out.length / 3)} tokens vs the requested ~${budget}-token budget). `
      + "This is already the full answer. Narrow with context_filter=['call'] or use get_node for a specific symbol to reduce size.\n\n" + out;
  }
  out = `[!] TRUNCATED: showing ${shown} of ${totalNodes} nodes (~${budget}-token budget). The answer may be among the ${cutCount} cut nodes — `
    + "raise token_budget or narrow the query (context_filter=['call'], or get_node for a specific symbol).\n\n"
    + out.slice(0, cut)
    + `\n... (truncated — ${cutCount} more nodes cut by ~${budget}-token budget. Narrow with context_filter=['call'] or use get_node for a specific symbol)`;
  return out;
}

function cutLines(lines: string[], budget: number, hint: string): string {
  const out = lines.join("\n"), cb = budget * 3;
  if (out.length <= cb) return out;
  let cut = out.slice(0, cb).lastIndexOf("\n");
  cut = cut > 0 ? cut : cb;
  const kept = out.slice(0, cut);
  const shown = kept.split("\n").length;
  return `[!] TRUNCATED: showing ${shown} of ${lines.length} lines (~${budget}-token budget). ${hint}\n\n${kept}\n... (truncated — ${lines.length - shown} more lines cut by ~${budget}-token budget. ${hint})`;
}

// ---------------------------------------------------------------- node lookup (get_node / get_neighbors)
function findNodeTiers(g: CodeGraph, label: string): [string[], string[], string[], string[]] {
  const term = searchTokens(label).join(" ");
  const normQuery = stripDiacritics(label).toLowerCase().trim();
  if (label.includes("::")) {
    const literal = g.order.some((id) => { const v = g.n(id); return [v.label, v.bare, v.tokens, v.nidLower].includes(term) || [v.label, v.bare, v.nidLower].includes(normQuery); });
    const [pathPart, ...restParts] = label.split("::");
    const symbolPart = restParts.join("::").trim();
    if (!literal && pathPart.trim() && symbolPart) {
      const pathTokens = searchTokens(pathPart).join(" "), normPath = stripDiacritics(pathPart).toLowerCase().trim();
      const symTerm = searchTokens(symbolPart).join(" "), normSym = stripDiacritics(symbolPart).toLowerCase().trim();
      const scoped = g.order.filter((id) => {
        const v = g.n(id), normSource = stripDiacritics(g.nodes.get(id)!.source_file ?? "").toLowerCase().trim();
        const pathOk = v.sourceTokens === pathTokens || normSource === normPath || (normPath && normSource.endsWith(`/${normPath}`)) || (pathTokens && v.sourceTokens.endsWith(` ${pathTokens}`));
        return pathOk && ([v.label, v.bare, v.tokens, v.nidLower].includes(symTerm) || [v.label, v.bare].includes(normSym));
      });
      if (scoped.length) return [scoped, [], [], []];
    }
  }
  if (!term) return [[], [], [], []];
  const sourceExact: string[] = [], exact: string[] = [], prefix: string[] = [], substring: string[] = [];
  for (const id of g.order) {
    const v = g.n(id);
    if (term === v.sourceTokens) sourceExact.push(id);
    else if ([v.label, v.bare, v.tokens, v.nidLower].includes(term) || [v.label, v.bare, v.nidLower].includes(normQuery)) exact.push(id);
    else if (v.label.startsWith(term) || v.bare.startsWith(term) || v.tokens.startsWith(term) || v.nidLower.startsWith(term) || v.label.startsWith(normQuery) || v.bare.startsWith(normQuery)) prefix.push(id);
    else if (v.label.includes(term) || v.tokens.includes(term) || v.label.includes(normQuery)) substring.push(id);
  }
  if (sourceExact.length) {
    const base = stripDiacritics(label.split(/[\\/]/).pop() ?? "").toLowerCase();
    const preferred = sourceExact.filter((id) => String(g.nodes.get(id)!.source_location ?? "") === "L1"
      && (() => { const l = stripDiacritics(g.label(id)).toLowerCase(); return l === base || l.endsWith(`/${base}`); })());
    if (preferred.length === 1) sourceExact.splice(0, sourceExact.length, preferred[0], ...sourceExact.filter((x) => x !== preferred[0]));
  }
  return [sourceExact, exact, prefix, substring];
}
function resolveSingle(g: CodeGraph, label: string): { id?: string; error?: string } {
  const tiers = findNodeTiers(g, label);
  const all = tiers.flat();
  if (!all.length) return { error: `No node matching '${label}' found.` };
  for (const tier of tiers) {
    if (!tier.length) continue;
    const bySource = new Map<string, string>();
    for (const id of tier) { const s = String(g.nodes.get(id)!.source_file ?? ""); if (!bySource.has(s)) bySource.set(s, id); }
    if (bySource.size > 1) {
      const listing = [...bySource.values()].map((r) => `  ${g.nodes.get(r)!.source_file || r}\n    id: ${r}`).join("\n");
      return { error: `Ambiguous: '${label}' matches ${bySource.size} nodes in different files.\n${listing}\nRetry with path::symbol using one of the paths above (e.g. <path>::${label}) or the full node id.` };
    }
    break;
  }
  return { id: all[0] };
}

// ---------------------------------------------------------------- tools
export function queryGraph(g: CodeGraph, a: { question: string; mode?: "bfs" | "dfs"; depth?: number; token_budget?: number; context_filter?: string[] }): string {
  const mode = a.mode ?? "bfs", depth = Math.min(a.depth ?? 3, 6), budget = a.token_budget ?? 2000;
  const terms = queryTerms(a.question);
  const qs = scoreQuery(g, terms, true);
  let best = qs.bestSeedByTerm;
  const intent = [...best.keys()].filter((t) => RELATIONAL_INTENT.has(t));
  if (intent.length && terms.some((t) => !RELATIONAL_INTENT.has(t))) best = new Map([...best].filter(([t]) => !intent.includes(t)));
  const seeds = pickSeeds(g, qs.ranked, best);
  if (!seeds.length) return "No matching nodes found.";
  const { filters, source } = contextFilters(a.question, a.context_filter);
  const u = g.view(filters);
  const { nodes, edges } = mode === "dfs" ? dfs(u, seeds, depth) : bfs(u, seeds, depth);
  const header = [
    `Graph: ${g.nodes.size} nodes`, `Traversal: ${mode.toUpperCase()} depth=${depth}`,
    `Start: [${seeds.map((s) => `'${g.label(s)}'`).join(", ")}]`,
    ...(filters.length ? [`Context: ${filters.join(", ")} (${source})`] : []), `${nodes.size} nodes found`,
  ].join(" | ");
  return `${header}\n\n${subgraphText(u, nodes, edges, budget, seeds)}`;
}

export function getNode(g: CodeGraph, a: { label?: string; node_id?: string }): string {
  const raw = a.label || a.node_id || "";
  if (!raw) return "Provide a node label or id (accepted keys: label, node_id).";
  const { id, error } = resolveSingle(g, raw.toLowerCase());
  if (error) return error;
  const d = g.nodes.get(id!)!;
  return [
    `Node: ${sanitize(g.label(id!))}`, `  ID: ${sanitize(id)}`,
    `  Source: ${sanitize(d.source_file ?? "")} ${sanitize(d.source_location ?? "")}`,
    `  Type: ${sanitize(d.file_type ?? "")}`, `  Repo: ${sanitize(d.repo ?? "")}`, `  Degree: ${g.degree(id!)}`,
  ].join("\n");
}

export function getNeighbors(g: CodeGraph, a: { label?: string; node_id?: string; relation_filter?: string; token_budget?: number }): string {
  const raw = a.label || a.node_id || "";
  if (!raw) return "Provide a node label or id (accepted keys: label, node_id).";
  const { id, error } = resolveSingle(g, raw.toLowerCase());
  if (error) return error;
  const rel = (a.relation_filter ?? "").toLowerCase();
  const at = (d: EdgeData) => (d.source_location ? ` at=${sanitize(d.source_file ?? "")}:${sanitize(d.source_location)}` : "");
  const lines = [`Neighbors of ${sanitize(g.label(id!))}:`];
  for (const [nb, d] of g.succ.get(id!)!) if (!rel || String(d.relation ?? "").toLowerCase().includes(rel)) lines.push(`  --> ${sanitize(g.label(nb))} [${sanitize(d.relation ?? "")}] [${sanitize(d.confidence ?? "")}]${at(d)}`);
  for (const [nb, d] of g.pred.get(id!)!) if (!rel || String(d.relation ?? "").toLowerCase().includes(rel)) lines.push(`  <-- ${sanitize(g.label(nb))} [${sanitize(d.relation ?? "")}] [${sanitize(d.confidence ?? "")}]${at(d)}`);
  return cutLines(lines, a.token_budget ?? 2000, "Narrow with relation_filter or use get_node for a specific symbol");
}

/** BFS shortest path with a deterministic neighbor order (sorted) — like nx.shortest_path on a sorted graph. */
function bfsPath(adj: Map<string, string[]>, s: string, t: string): string[] | undefined {
  const prev = new Map<string, string>([[s, s]]);
  let frontier = [s];
  while (frontier.length && !prev.has(t)) {
    const next: string[] = [];
    for (const n of frontier) for (const nb of adj.get(n) ?? []) if (!prev.has(nb)) { prev.set(nb, n); next.push(nb); }
    frontier = next;
  }
  if (!prev.has(t)) return undefined;
  const path = [t];
  while (path[0] !== s) path.unshift(prev.get(path[0])!);
  return path;
}

export function shortestPath(g: CodeGraph, a: { source: string; target: string; max_hops?: number; undirected?: boolean }): string {
  const split = (s: string) => s.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  const src = scoreQuery(g, split(a.source), false).ranked, tgt = scoreQuery(g, split(a.target), false).ranked;
  if (!src.length) return `No node matching source '${a.source}' found.`;
  if (!tgt.length) return `No node matching target '${a.target}' found.`;
  const endpoint = (scored: Array<[number, string]>, q: string) => {
    const qt = new Set(searchTokens(q));
    if (!qt.size) return scored[0][1];
    for (const [, id] of scored) { const lt = new Set(searchTokens(g.label(id))); if ([...qt].every((t) => lt.has(t))) return id; }
    return scored[0][1];
  };
  const s = endpoint(src, a.source), t = endpoint(tgt, a.target);
  if (s === t) return `'${a.source}' and '${a.target}' both resolved to the same node '${s}'. Use a more specific label or the exact node ID.`;
  const warnings: string[] = [];
  for (const [name, scored, id] of [["source", src, s], ["target", tgt, t]] as const) {
    if (scored.length >= 2 && id === scored[0][1]) {
      const top = scored[0][0], runner = scored[1][0];
      if (top > 0 && (top - runner) / top < 0.1) warnings.push(`warning: ${name} match was ambiguous (top score ${+top.toPrecision(6)}, runner-up ${+runner.toPrecision(6)})`);
    }
  }
  const maxHops = a.max_hops ?? 8;
  const adj = new Map<string, Set<string>>();
  const add = (x: string, y: string) => (adj.get(x) ?? adj.set(x, new Set()).get(x)!).add(y);
  for (const u of g.order) for (const [v, d] of g.succ.get(u)!) {
    if (a.undirected) { add(u, v); add(v, u); } else add(d._src ?? u, d._tgt ?? v);
  }
  const sorted = new Map([...adj].map(([k, v]) => [k, [...v].sort()]));
  const path = bfsPath(sorted, s, t);
  if (!path) return a.undirected ? `No path found between '${g.label(s)}' and '${g.label(t)}'.`
    : `No directed path found between '${g.label(s)}' and '${g.label(t)}'. Retry with undirected=true to search ignoring edge direction.`;
  const hops = path.length - 1;
  if (hops > maxHops) return `Path exceeds max_hops=${maxHops} (${hops} hops found).`;
  const segs: string[] = [g.label(path[0])];
  for (let i = 0; i < hops; i++) {
    const u = path[i], v = path[i + 1];
    const fwd: EdgeData[] = [], bwd: EdgeData[] = [];
    for (const [x, y] of [[u, v], [v, u]]) { const d = g.succ.get(x)!.get(y); if (d) ((d._src ?? x) === u ? fwd : bwd).push(d); }
    const datas = fwd.length ? fwd : bwd;
    const rels = [...new Set(datas.map((d) => d.relation).filter(Boolean))].sort();
    const confs = [...new Set(datas.map((d) => d.confidence).filter(Boolean))].sort();
    const rel = rels.length ? rels.join("/") : "related", conf = confs.length ? ` [${confs.join("/")}]` : "";
    segs.push(fwd.length ? `--${rel}${conf}--> ${g.label(v)}` : `<--${rel}${conf}-- ${g.label(v)}`);
  }
  return `${warnings.length ? `${warnings.join("\n")}\n` : ""}Shortest path (${hops} hops):\n  ${segs.join(" ")}`;
}

/** Graph from disk, cached until graph.json's mtime changes (the indexer publishes atomically = hot reload). */
export class GraphCache {
  private mtime = 0;
  private graph?: CodeGraph;
  constructor(private readonly path: string) {}
  get(): CodeGraph | undefined {
    if (!existsSync(this.path)) return undefined;
    const mt = statSync(this.path).mtimeMs;
    if (!this.graph || mt !== this.mtime) { this.graph = CodeGraph.fromJson(JSON.parse(readFileSync(this.path, "utf8"))); this.mtime = mt; }
    return this.graph;
  }
}
