// Matching client facts with endpoints + host catalog (L-3a) + external services (L-3c).
// Two passes:
//   1) global matching (as in the first version) → "host H → repo R" votes from unambiguous matches with a known host;
//   2) the host catalog (votes + config/service-hosts.yaml) restricts candidates for calls with a host;
//      a host outside the catalog without matches → depends_on_external.
import {
  type ClientCall, type Confidence, type CrossLink, type Endpoint, type RepoMirror, exactShape, matchScore, routesMatch,
} from "./common.js";
import { type ConfigValue, configUrls, hostOf } from "./config.js";

export interface HostEntry { host: string; repo: string; variants: string[]; votes: number; source: "vote" | "manual" }
export type HostCatalog = Map<string, HostEntry>;

const ENV_PREFIX = /^(test|tst|staging|stage|stg|dev|develop|qa|uat|preprod|sandbox)[.-]/;
/** test.api.employee.example.com → api.employee.example.com (environments collapse into one service). */
export const normalizeHost = (h: string) => h.toLowerCase().replace(/:\d+$/, "").replace(ENV_PREFIX, "");
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|host\.docker\.internal)|(^|\.)example\.(com|org)$|\.test$|\.local$/;

export function buildHostCatalog(votes: Array<{ host: string; repo: string }>, manual: Record<string, string> = {}): HostCatalog {
  const tally = new Map<string, Map<string, number>>();
  const variants = new Map<string, Set<string>>();
  for (const v of votes) {
    const n = normalizeHost(v.host);
    if (!n || LOCAL_HOST.test(n)) continue;
    const t = tally.get(n) ?? tally.set(n, new Map()).get(n)!;
    t.set(v.repo, (t.get(v.repo) ?? 0) + 1);
    (variants.get(n) ?? variants.set(n, new Set()).get(n)!).add(v.host.toLowerCase());
  }
  const cat: HostCatalog = new Map();
  for (const [host, t] of tally) {
    const [[repo, n]] = [...t].sort((a, b) => b[1] - a[1]);
    const total = [...t.values()].reduce((a, b) => a + b, 0);
    if (n / total > 0.5) cat.set(host, { host, repo, variants: [...(variants.get(host) ?? [])], votes: n, source: "vote" });
  }
  for (const [h, repo] of Object.entries(manual)) {
    const n = normalizeHost(h);
    cat.set(n, { host: n, repo, variants: [...new Set([...(cat.get(n)?.variants ?? []), h.toLowerCase()])], votes: cat.get(n)?.votes ?? 0, source: "manual" });
  }
  return cat;
}

function candidates(c: ClientCall, servers: Endpoint[], restrict?: Set<string>): Endpoint[] {
  const pool = servers.filter((s) => (!restrict || restrict.has(s.repo)) && !(s.repo === c.repo && s.file === c.file));
  const tryRoute = (route: string) => {
    const all = pool.filter((s) => routesMatch(route, s.route) && (!c.method || c.method === s.method));
    const best = Math.max(0, ...all.map((s) => matchScore(route, s.route)));
    return all.filter((s) => matchScore(route, s.route) === best);
  };
  let res = tryRoute(c.route);
  // L-2 item 5: a URL from config that ends with "/", without assembly evidence — try a route with one parameter
  if (c.trailingParam) {
    const withParam = tryRoute(`${c.route}/{}`);
    if (withParam.length) res = withParam;
  }
  return res;
}

/** Normalized form for shape comparison: v1 ≡ v{} (the version segment is known on both sides — not a heuristic). */
const shape = (r: string) => r.replace(/(^|\/)v(\d+(\.\d+)?|\{\})(?=\/|$)/g, "$1v{}");

function confidenceOf(c: ClientCall, s: Endpoint, n: number): Confidence {
  if (n > 1) return "AMBIGUOUS";
  const known = !!c.method && (c.composed !== false) && !c.trailingParam;
  return known && exactShape(shape(c.route), shape(s.route)) ? "EXTRACTED" : "INFERRED";
}

const EXTERNAL_CATEGORY: Array<[RegExp, string]> = [
  [/auth|identity|issuer|authority|accounts\.google|login\.microsoftonline|oidc|oauth|sts\./i, "identity"],
  [/slack|smtp|mail|sendgrid|mailgun|teams|telegram|twilio/i, "messaging"],
  [/amazonaws|azure|windows\.net|googleapis|cloudfront|blob|s3\.|bigquery|firebase/i, "cloud"],
];
export const externalCategory = (keyAndHost: string) => EXTERNAL_CATEGORY.find(([re]) => re.test(keyAndHost))?.[1] ?? "other";

export interface LinkResult { links: CrossLink[]; catalog: HostCatalog; stats: Record<string, number> }

export function matchCalls(mirrors: RepoMirror[], servers: Endpoint[], calls: ClientCall[], manualHosts: Record<string, string> = {}): LinkResult {
  // --- pass 1: votes from unambiguous matches with a known host
  const votes: Array<{ host: string; repo: string }> = [];
  for (const c of calls) {
    if (!c.hosts?.length || c.usage !== "used") continue;
    const cand = candidates(c, servers);
    const repos = new Set(cand.map((s) => s.repo));
    if (repos.size === 1) { const [r] = repos; if (r !== c.repo) for (const h of c.hosts) votes.push({ host: h, repo: r }); }
  }
  const catalog = buildHostCatalog(votes, manualHosts);
  const repoOfHost = (h: string) => catalog.get(normalizeHost(h))?.repo;

  // --- pass 2
  const links: CrossLink[] = [];
  const stats = { calls: calls.length, used: 0, declared: 0, restrictedByHost: 0, external: 0, unmatched: 0 };
  const externalSeen = new Set<string>();
  const addExternal = (repo: string, host: string, from: string, key: string | undefined, envs: string[] | undefined) => {
    const n = normalizeHost(host);
    if (!n || LOCAL_HOST.test(n)) return;
    const k = `${repo}|${n}|${key ?? from}`;
    if (externalSeen.has(k)) return;
    externalSeen.add(k);
    stats.external++;
    links.push({
      kind: "depends_on_external", fromRepo: repo, toRepo: `external::${n}`, from, to: `external::${n}`, usage: "used", confidence: "EXTRACTED",
      detail: { host: n, category: externalCategory(`${key ?? ""} ${n}`), ...(key ? { key } : {}), ...(envs ? { envs } : {}) },
    });
  };

  for (const c of calls) {
    const mapped = [...new Set((c.hosts ?? []).map(repoOfHost).filter((r): r is string => !!r))];
    const restrict = mapped.length ? new Set(mapped) : undefined;
    if (restrict) stats.restrictedByHost++;
    const cand = candidates(c, servers, restrict);
    const from = `${c.repo}/${c.file}:${c.line}`;
    if (!cand.length) {
      if (restrict) {
        // the host is known, the route is not (dynamic path, base address): link at the repo level only
        for (const r of mapped) if (r !== c.repo) {
          links.push({ kind: "config_http_calls", fromRepo: c.repo, toRepo: r, from, to: `${r}/`, usage: c.usage, confidence: "INFERRED",
            detail: { method: c.method, clientRoute: c.route, clientPath: c.raw, via: c.via ?? [], pattern: c.pattern, candidates: 0 } });
        }
      } else if (c.hosts?.length && c.usage === "used") {
        const cfg = c.via?.find((v) => v.type === "config") as { envs?: string[] } | undefined;
        for (const h of c.hosts) addExternal(c.repo, h, from, c.configKey, cfg?.envs);
      } else stats.unmatched++;
      continue;
    }
    // a URL declared in config but not read by code, without a method: candidates differ only by method — the method
    // is unknown by definition, so repo level only (declared), and candidates go in detail for the agent response
    if (c.usage === "declared" && !c.method && cand.length > 1 && new Set(cand.map((s) => s.repo)).size === 1) {
      stats.declared++;
      links.push({ kind: "config_http_calls", fromRepo: c.repo, toRepo: cand[0].repo, from, to: `${cand[0].repo}/`, usage: "declared", confidence: "INFERRED",
        detail: { clientRoute: c.route, clientPath: c.raw, via: c.via ?? [], pattern: c.pattern, candidates: cand.length,
          serverCandidates: cand.map((s) => `${s.method} ${s.raw} (${s.symbol ?? s.file})`) } });
      continue;
    }
    c.usage === "used" ? stats.used++ : stats.declared++;
    for (const s of cand) {
      links.push({
        kind: "http_calls", fromRepo: c.repo, toRepo: s.repo, from, to: `${s.repo}/${s.file}:${s.line}`,
        usage: c.usage, confidence: confidenceOf(c, s, cand.length),
        detail: {
          method: c.method ?? s.method, clientRoute: c.route, clientPath: c.raw, serverRoute: s.raw, ...(s.symbol ? { serverSymbol: s.symbol } : {}),
          via: c.via ?? [], candidates: cand.length, pattern: c.pattern,
        },
      });
    }
  }
  return { links: dedupe(links), catalog, stats };
}

/** External services from configs (identity, messaging, cloud…): keys with a URL whose host belongs to no repo. */
export function externalFromConfig(mirrors: RepoMirror[], catalog: HostCatalog): CrossLink[] {
  const out: CrossLink[] = [];
  for (const m of mirrors) {
    const all: ConfigValue[] = configUrls(m);
    const byKey = new Map<string, ConfigValue[]>();
    for (const v of all) (byKey.get(v.key) ?? byKey.set(v.key, []).get(v.key)!).push(v);
    const seen = new Set<string>();
    for (const [key, vs] of byKey) {
      if (/swagger|health|logo|avatar|redirect|callback|origin|cors/i.test(key)) continue;
      const hosts = [...new Set(vs.map((v) => normalizeHost(hostOf(v.value))))].filter((h) => h && !LOCAL_HOST.test(h));
      for (const h of hosts) {
        if (catalog.has(h)) continue;
        const cat = externalCategory(`${key} ${h}`);
        // only identity / messaging / cloud: an "other" URL without a call is mostly documentation and links
        if (cat === "other") continue;
        const k = `${m.repo}|${h}|${key}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const first = vs.find((v) => normalizeHost(hostOf(v.value)) === h)!;
        out.push({
          kind: "depends_on_external", fromRepo: m.repo, toRepo: `external::${h}`, from: `${m.repo}/${first.file}:${first.line}`, to: `external::${h}`,
          usage: "used", confidence: "EXTRACTED",
          detail: { host: h, category: cat, key, envs: [...new Set(vs.filter((v) => normalizeHost(hostOf(v.value)) === h).map((v) => v.env))] },
        });
      }
    }
  }
  return out;
}

function dedupe(links: CrossLink[]): CrossLink[] {
  const seen = new Set<string>();
  return links.filter((l) => { const k = `${l.kind}|${l.from}|${l.to}|${l.usage}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
