// Shared linker types and utilities (spec 03). The linker is deterministic, no LLM; every link has file:line evidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "../files.js";

/** A repository the linker reads: its key (graph prefix) and its directory on disk. */
export interface RepoMirror { repo: string; dir: string }

/** Evidence chain from a config / generated client to the call site (spec 03 §2, detail.via). */
export type Via =
  | { type: "config"; key: string; at: string; envs: string[]; value?: string }
  | { type: "compose"; expr: string }
  | { type: "generated"; op: string; service: string; def: string }
  | { type: "spec"; op: string; def: string }
  | { type: "http-client"; name: string; at: string; baseKey?: string }
  | { type: "environment"; prop: string; at: string; envs: string[] }
  | { type: "helper"; method: string; at: string };

export type Usage = "used" | "declared";
export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
export type LinkKind = "http_calls" | "config_http_calls" | "depends_on_package" | "depends_on_external";

export interface CrossLink {
  kind: LinkKind | string;
  fromRepo: string;
  toRepo: string;
  from: string;          // repo/path:line — CALL site (or declaration for declared)
  to: string;            // repo/path:line of the endpoint, or external::<host>
  usage?: Usage;
  confidence?: Confidence;
  detail: Record<string, unknown>;
}

/** A fact of an API call (or declaration) on the client side. */
export interface ClientCall {
  repo: string; file: string; line: number;
  method: string | null;          // null — method unknown (fetch, config without a call)
  route: string;                  // normalized path (normalizeRoute)
  raw: string;                    // as in the code (for the response to the agent)
  usage: Usage;
  pattern: string;                // C-1…C-8 / L-1…L-3 — where the fact comes from
  via?: Via[];
  /** Restriction of repo candidates (host catalog, L-3): a relative path is matched only against endpoints of these repos */
  targetRepos?: string[];
  /** URL from config without assembly evidence that ends with "/": try a route with one parameter (L-2 item 5) */
  trailingParam?: boolean;
  /** Client route segments with evidence (assembly found) — affects confidence */
  composed?: boolean;
  /** Hosts the call goes to (from config values per environment) — for the host catalog and candidate restriction (L-3) */
  hosts?: string[];
  /** Config key the address was taken from (for depends_on_external) */
  configKey?: string;
}

export interface Endpoint { repo: string; file: string; line: number; method: string; route: string; raw: string; symbol?: string }

// ---------------------------------------------------------------- cached files (linkers read the same files many times)
const listCache = new Map<string, string[]>();
const textCache = new Map<string, string>();
export function clearCaches() { listCache.clear(); textCache.clear(); }
export function files(root: string): string[] {
  let l = listCache.get(root);
  if (!l) { l = listFiles(root); listCache.set(root, l); }
  return l;
}
export function read(m: RepoMirror, f: string): string {
  const k = join(m.dir, f);
  let t = textCache.get(k);
  if (t === undefined) { t = readFileSync(k, "utf8"); textCache.set(k, t); }
  return t;
}
export const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
export const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Tests and migrations are not call sites of production code (tests have fake URLs and HttpClient mocks). */
export const isTestPath = (f: string) => /(^|\/)(tests?|__tests__|e2e|cypress|[^/]*\.Tests?|[^/]*\.UnitTests|[^/]*\.IntegrationTests|Migrations)\//i.test(f) || /\.(spec|test)\.[jt]sx?$/i.test(f);

// ---------------------------------------------------------------- routes
/** Path normalization for matching: no host/base, no query, parameters → {} */
export function normalizeRoute(p: string): string {
  let s = p.trim();
  s = s.replace(/^\$\{[^}]*\}/, "");                // `${environment.apiUrl}/api/...`
  s = s.replace(/^https?:\/\/[^/]+/i, "");          // absolute URL
  s = s.split("?")[0].split("#")[0];
  s = s.replace(/\$\{[^}]*\}/g, "{}");              // TS template params
  s = s.replace(/\{[^}]*\}/g, "{}");                // {id}, {id:guid}
  s = s.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}");  // express-style :id
  s = s.replace(/\/+/g, "/").replace(/^\/|\/$/g, "").toLowerCase();
  return s;
}
const VERSION_SEG = /^v(\{\}|\d+(\.\d+)?)$/;
const stripVersion = (r: string) => r.split("/").filter((seg, i) => !(i === 0 && VERSION_SEG.test(seg)));
/** Whether the client route matches the server route; the API version segment is optional on both sides (S-5). */
export function routesMatch(a: string, b: string): boolean {
  const x = stripVersion(a), y = stripVersion(b);
  if (x.length !== y.length || !x.length || x[0] === "") return false;
  // at least one literal segment must match: otherwise "/employee" ↔ "{id}" gives a false link
  if (!x.some((seg, i) => seg !== "{}" && seg === y[i])) return false;
  return x.every((seg, i) => seg === y[i] || seg === "{}" || y[i] === "{}");
}
/**
 * Match precision for candidate selection: literal = literal — 2 points, parameter = parameter — 1 point, parameter ↔ literal — 0.
 * This way `api/employees/{}` picks `api/employees/{snapshotId}`, not `api/employees/positions` (both formally match).
 */
export function matchScore(a: string, b: string): number {
  const x = stripVersion(a), y = stripVersion(b);
  return x.reduce((acc, seg, i) => acc + (seg !== "{}" && seg === y[i] ? 2 : seg === "{}" && y[i] === "{}" ? 1 : 0), 0);
}
/** Whether the match needs a heuristic (version, {} vs literal) — such a match is only INFERRED. */
export function exactShape(a: string, b: string): boolean {
  const x = a.split("/"), y = b.split("/");
  return x.length === y.length && x.every((seg, i) => seg === y[i] || (seg === "{}" && y[i] === "{}"));
}

// ---------------------------------------------------------------- C#: string constants
export interface CsConstants { consts: Map<string, string>; aliases: Map<string, string> }
const constCache = new Map<string, CsConstants>();
/** C# string constants in a repo: "Class.Name" and aliases `using R = Ns.Class;`. */
export function csharpConstants(m: RepoMirror): CsConstants {
  const hit = constCache.get(m.dir);
  if (hit) return hit;
  const consts = new Map<string, string>(), aliases = new Map<string, string>();
  for (const f of files(m.dir)) {
    if (!f.endsWith(".cs")) continue;
    const text = read(m, f);
    for (const a of text.matchAll(/using\s+(\w+)\s*=\s*[\w.]*?(\w+)\s*;/g)) aliases.set(a[1], a[2]);
    for (const c of text.matchAll(/\bclass\s+(\w+)[^{]*\{/g)) {
      const body = text.slice(c.index! + c[0].length, c.index! + c[0].length + 20000);
      for (const k of body.matchAll(/const\s+string\s+(\w+)\s*=\s*"([^"]*)"\s*;/g)) {
        if (!consts.has(`${c[1]}.${k[1]}`)) consts.set(`${c[1]}.${k[1]}`, k[2]);
      }
    }
  }
  const r = { consts, aliases };
  constCache.set(m.dir, r);
  return r;
}
/** Evaluates a C# string expression: "a" + R.B + "c", nameof is not supported. Unknown part → undefined. */
export function evalCsString(expr: string, cls: string | undefined, k: CsConstants): string | undefined {
  let out = "";
  for (const part of expr.split("+").map((p) => p.trim())) {
    const lit = /^@?"([^"]*)"$/.exec(part);
    if (lit) { out += lit[1]; continue; }
    const ref = /^(?:(\w+)\.)?(\w+)$/.exec(part);
    if (!ref) return undefined;
    const owner = ref[1] ? (k.aliases.get(ref[1]) ?? ref[1]) : cls;
    const v = owner ? k.consts.get(`${owner}.${ref[2]}`) : undefined;
    if (v === undefined) {
      // constant without a class: look for a unique name across all classes
      if (!ref[1]) {
        const all = [...k.consts].filter(([n]) => n.endsWith(`.${ref[2]}`));
        if (all.length === 1) { out += all[0][1]; continue; }
      }
      return undefined;
    }
    out += v;
  }
  return out;
}

/** HTTP method by client method name (.NET HttpClient / Angular HttpClient / axios). */
export function verbOf(call: string): string | null {
  const m = /^(get|post|put|patch|delete|head)/i.exec(call);
  return m ? m[1].toUpperCase() : null;
}
