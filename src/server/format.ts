// Text responses for the agent: compact, with file:line evidence, at most ~400 lines.
import type { HubsResult } from "./graph-index.js";

export interface Link {
  kind: string; fromRepo: string; toRepo: string; from: string; to: string;
  usage?: "used" | "declared"; confidence?: string; detail: Record<string, unknown>;
}
type Via = { type: string; key?: string; envs?: string[]; op?: string; name?: string; prop?: string; method?: string };

const MAX_LINES = 400;
const short = (ref: string) => { const [f, l] = ref.split(/:(?=\d+$)/); return `${f.split("/").pop()}${l ? `:${l}` : ""}`; };
const envs = (v: Via) => (v.envs?.length ? ` [${v.envs.join(", ")}]` : "");
function viaText(via: Via[] = []): string {
  const parts = via.map((v) => {
    switch (v.type) {
      case "config": return `${v.key}${envs(v)}`;
      case "environment": return `environment.${v.prop}${envs(v)}`;
      case "http-client": return `HttpClient "${v.name}"`;
      case "generated": return `generated ${v.op}()`;
      case "spec": return `OpenAPI ${v.op}()`;
      case "helper": return `via ${v.method}()`;
      default: return "";
    }
  }).filter(Boolean);
  return parts.length ? `via ${parts.join(" → ")}` : "";
}
const KIND: Record<string, string[]> = {
  http: ["http_calls"], config: ["config_http_calls"], package: ["depends_on_package"], external: ["depends_on_external"],
  all: ["http_calls", "config_http_calls", "depends_on_package", "depends_on_external"],
};

export function formatDependencies(all: Link[], o: { repo?: string; other?: string; kind: string; limit: number; symbolAt: (ref: string) => string | undefined }): string {
  const kinds = new Set(KIND[o.kind] ?? KIND.all);
  const links = all.filter((l) => kinds.has(l.kind) && l.fromRepo !== l.toRepo
    && (!o.repo || l.fromRepo === o.repo || l.toRepo === o.repo)
    && (!o.other || l.fromRepo === o.other || l.toRepo === o.other || l.toRepo === `external::${o.other}`));
  if (!links.length) return "No cross-repo links found";
  const pairKey = (l: Link) => `${l.fromRepo}\u0000${l.toRepo}`;
  const pairs = new Map<string, Link[]>();
  for (const l of links) (pairs.get(pairKey(l)) ?? pairs.set(pairKey(l), []).get(pairKey(l))!).push(l);
  const out: string[] = [];
  const ordered = [...pairs.entries()].sort(([a], [b]) => {
    // for repo: outgoing first, then incoming; external — at the end
    const ra = o.repo && a.startsWith(`${o.repo}\u0000`) ? 0 : 1, rb = o.repo && b.startsWith(`${o.repo}\u0000`) ? 0 : 1;
    const ea = a.includes("external::") ? 1 : 0, eb = b.includes("external::") ? 1 : 0;
    return ra - rb || ea - eb || a.localeCompare(b);
  });

  // map without repo: one line per pair
  if (!o.repo && !o.other) {
    for (const [, ls] of ordered) {
      const l0 = ls[0];
      if (l0.kind === "depends_on_external") {
        const keys = [...new Set(ls.map((l) => String(l.detail.key ?? "")).filter(Boolean))];
        out.push(`${l0.fromRepo} → ${l0.toRepo}  [${l0.detail.category}]  ${keys.join(", ")}`);
        continue;
      }
      const http = ls.filter((l) => l.kind === "http_calls" || l.kind === "config_http_calls");
      const pkgs = ls.filter((l) => l.kind === "depends_on_package");
      const used = new Set(http.filter((l) => l.usage !== "declared").map((l) => l.from)).size;
      const declared = new Set(http.filter((l) => l.usage === "declared").map((l) => l.from)).size;
      const parts = [http.length ? `http used: ${used}  declared-only: ${declared}` : "", pkgs.length ? `packages: ${[...new Set(pkgs.map((p) => p.detail.package))].join(", ")}` : ""].filter(Boolean);
      out.push(`${l0.fromRepo} → ${l0.toRepo}   ${parts.join("   ")}`);
    }
    out.push("", "Details (calls with file:line): dependencies with repo=<key>.");
    return out.join("\n");
  }

  for (const [, ls] of ordered) {
    const l0 = ls[0];
    if (out.length > MAX_LINES) { out.push(`… truncated (${MAX_LINES} lines): narrow the query with the other / kind parameters`); break; }
    if (l0.kind === "depends_on_external") {
      out.push(`${l0.fromRepo} → ${l0.toRepo}  [${l0.detail.category}]`);
      for (const l of ls.slice(0, o.limit)) out.push(`  ${l.detail.key ?? ""}${(l.detail.envs as string[] | undefined)?.length ? ` [${(l.detail.envs as string[]).join(", ")}]` : ""}  (${short(l.from)})`);
      continue;
    }
    const http = ls.filter((l) => l.kind === "http_calls");
    const cfg = ls.filter((l) => l.kind === "config_http_calls");
    const pkgs = ls.filter((l) => l.kind === "depends_on_package");
    const used = http.filter((l) => l.usage !== "declared");
    const declared = [...http, ...cfg].filter((l) => l.usage === "declared");
    if (http.length || cfg.length) out.push(`${l0.fromRepo} → ${l0.toRepo}   used: ${new Set(used.map((l) => l.from)).size}   declared-only: ${new Set(declared.map((l) => l.from)).size}`);
    // used: one pair of lines per (method, route, caller)
    const seen = new Set<string>();
    let shown = 0;
    for (const l of used) {
      const d = l.detail as { method?: string; serverRoute?: string; clientRoute?: string; serverSymbol?: string; via?: Via[]; candidates?: number };
      const caller = o.symbolAt(l.from);
      const k = `${d.method} ${d.serverRoute} ${caller ?? l.from}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (shown++ >= o.limit) { out.push(`  … ${new Set(used.map((x) => x.from)).size - o.limit} more calls (limit)`); break; }
      const conf = l.confidence && l.confidence !== "EXTRACTED" ? `  [${l.confidence}${d.candidates && d.candidates > 1 ? `, candidates: ${d.candidates}` : ""}]` : "";
      out.push(`  ${(d.method ?? "?").padEnd(6)} ${d.serverRoute ?? d.clientRoute}   ${caller ? `${caller} (${short(l.from)})` : short(l.from)}${conf}`);
      const via = viaText(d.via);
      out.push(`         ${via ? `${via} ` : ""}→ ${d.serverSymbol ?? ""} (${short(l.to)})`.replace(/→  \(/, "→ ("));
    }
    for (const l of cfg.filter((x) => x.usage !== "declared").slice(0, 10)) {
      out.push(`  address from config, path is determined in code: ${viaText(l.detail.via as Via[])} (${short(l.from)})`);
    }
    if (declared.length) {
      const items = [...new Set(declared.map((l) => {
        const d = l.detail as { method?: string; serverRoute?: string; clientRoute?: string; serverCandidates?: string[]; via?: Via[] };
        return l.kind === "config_http_calls" ? `${viaText(d.via)} (candidates: ${(d.serverCandidates ?? []).join("; ")})` : `${d.method ?? "?"} ${d.serverRoute ?? d.clientRoute}`;
      }))];
      out.push(`  declared-only (declared, no calls found): ${items.slice(0, 15).join(", ")}${items.length > 15 ? `, … ${items.length - 15} more` : ""}`);
    }
    if (pkgs.length) out.push(`${l0.fromRepo} → ${l0.toRepo}   packages: ${[...new Set(pkgs.map((p) => `${p.detail.package}@${p.detail.version ?? "?"} (${p.detail.ecosystem})`))].join(", ")}`);
  }
  return out.join("\n");
}

export function formatHubs(results: HubsResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    out.push(`${r.repo}${r.hubs.length ? "" : ": no hubs found (no graph or code)"}`);
    r.hubs.forEach((h, i) => {
      const cross = h.incomingCrossRepo.length ? `; from other repos: ${h.incomingCrossRepo.map((c) => `${c.repo} ×${c.calls}`).join(", ")}` : "";
      out.push(`  ${String(i + 1).padStart(2)}. ${h.symbol}  (${h.at})  caller files: ${h.fanInFiles}${cross}`);
      if (h.callers.length) out.push(`      e.g.: ${h.callers.join("; ")}`);
    });
    if (r.compositionRoots.length) out.push(`  composition roots: ${r.compositionRoots.join("; ")}`);
    if (out.length > MAX_LINES) { out.push("… truncated"); break; }
  }
  return out.join("\n");
}
