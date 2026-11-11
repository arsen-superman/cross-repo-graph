// Direct calls with a literal path (C-1, C-2): Angular HttpClient / axios / fetch / template URLs with a base address, C# HttpClient.
// Refinement by host and base path — from environment*.ts (C-8) via environmentBases().
import { type ClientCall, type RepoMirror, files, isTestPath, lineOf, normalizeRoute, read } from "./common.js";
import { environmentBases } from "./config.js";

export function directCalls(m: RepoMirror, genFiles: Set<string>): ClientCall[] {
  const out: ClientCall[] = [];
  const env = environmentBases(m);
  const push = (f: string, text: string, index: number, method: string | null, raw: string, pattern: string) => {
    const line = lineOf(text, index);
    const base = env.get(`${f}:${line}`);
    const rel = raw.replace(/^`?\$\{[^}]*\}/, "");
    const route = normalizeRoute(base ? `${base.basePath}/${rel.replace(/^\//, "")}` : raw);
    if (!route) return;
    out.push({ repo: m.repo, file: f, line, method, route, raw, usage: "used", pattern, ...(base ? { hosts: base.hosts, via: [base.via] } : {}) });
  };
  for (const f of files(m.dir)) {
    if (genFiles.has(f) || isTestPath(f)) continue;
    if (/\.(ts|tsx|js|jsx|vue)$/.test(f)) {
      const text = read(m, f);
      // this.http.get<T>('/api/x') | http.post(`...`) | axios.get('...')
      for (const mm of text.matchAll(/\.(get|post|put|patch|delete)\s*(?:<[^>()]*(?:<[^>()]*>)?[^>()]*>)?\s*\(\s*([`'"])([^`'"]+)\2/g)) {
        if (!mm[3].includes("/")) continue;
        push(f, text, mm.index!, mm[1].toUpperCase(), mm[3], "C-1:http");
      }
      for (const mm of text.matchAll(/fetch\s*\(\s*([`'"])([^`'"]+)\1/g)) push(f, text, mm.index!, null, mm[2], "C-1:fetch");
      // `${environment.apiEmployeeBaseUrl}/vacations/schedule` — a URL with the API base address, passed to any function
      for (const mm of text.matchAll(/`\$\{[^}]*(?:url|api|host|endpoint|server)[^}]*\}(\/[^`]*)`/gi)) {
        if (/(fetch|\.(get|post|put|patch|delete))\s*(<[^>()]*(?:<[^>()]*>)?[^>()]*>)?\s*\(\s*$/.test(text.slice(Math.max(0, mm.index! - 80), mm.index!))) continue;
        // intermediary field (_baseUrl = `${environment.x}/v1`) — not a call
        if (/(\w+)\s*(?::\s*string\s*)?=\s*$/.test(text.slice(Math.max(0, mm.index! - 60), mm.index!)) && !/\//.test(mm[1].slice(1))) continue;
        push(f, text, mm.index!, null, mm[0].slice(1, -1), "C-2:template-url");
      }
    } else if (f.endsWith(".cs")) {
      const text = read(m, f);
      // service-to-service: _http.GetFromJsonAsync("api/prices/..."), PostAsJsonAsync($"api/x/{id}", ...)
      const re = /\.(Get|Post|Put|Patch|Delete)(?:FromJson|AsJson|String|ByteArray|Stream)?Async\s*(?:<[^>()]*>)?\s*\(\s*\$?"([^"]+)"/g;
      for (const mm of text.matchAll(re)) {
        if (!mm[2].includes("/")) continue;
        push(f, text, mm.index!, mm[1].toUpperCase(), mm[2], "C-1:httpclient");
      }
    }
  }
  return out;
}
