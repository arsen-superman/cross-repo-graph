// L-2 / L-3 (spec 03 §4.2–4.3): service addresses from configs as a source of dependencies.
//   L-2  appsettings key → property in code → URL assembly expression → HTTP method from the call; from = call site
//   L-3b base address + named/typed HttpClient: AddHttpClient("Name", c => c.BaseAddress = …) + CreateClient("Name").GetAsync("rel")
//   C-8  frontend environment*.ts: `${environment.apiUrl}/x` → host and base path from the environments
// The host catalog (L-3a) and external services (L-3c) are in link.ts; here only facts with hosts.
import {
  type ClientCall, type RepoMirror, type Via, csharpConstants, esc, evalCsString, files, isTestPath, lineOf, normalizeRoute, read, verbOf,
} from "./common.js";

// ---------------------------------------------------------------- appsettings: keys with full paths and strings
export interface ConfigValue { key: string; value: string; file: string; line: number; env: string }

/** appsettings.Production.json → Production; appsettings.json → Default. */
export const envOfSettings = (f: string) => /appsettings\.([^/]+)\.json$/i.exec(f)?.[1] ?? "Default";

/**
 * A tolerant JSON scanner (comments, trailing commas): all string values with the key path "A:B:C" (as in IConfiguration) and the line.
 * Arrays are indexed as in IConfiguration: "A:0".
 */
export function scanJsonStrings(text: string): Array<{ key: string; value: string; line: number }> {
  const out: Array<{ key: string; value: string; line: number }> = [];
  const stack: Array<{ kind: "obj" | "arr"; key?: string; idx: number }> = [];
  let pendingKey: string | undefined;
  let i = 0;
  const readString = (): string => {
    let s = "";
    i++; // "
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\" && i + 1 < text.length) { const n = text[i + 1]; s += n === "n" ? "\n" : n === "t" ? "\t" : n; i += 2; continue; }
      s += text[i++];
    }
    i++;
    return s;
  };
  const path = () => stack.map((f) => f.key).filter((k) => k !== undefined).join(":");
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === "{" || c === "[") {
      const top = stack[stack.length - 1];
      const key = top?.kind === "arr" ? String(top.idx) : pendingKey;
      stack.push({ kind: c === "{" ? "obj" : "arr", key, idx: 0 });
      pendingKey = undefined; i++; continue;
    }
    if (c === "}" || c === "]") { stack.pop(); const top = stack[stack.length - 1]; if (top?.kind === "arr") top.idx++; i++; continue; }
    if (c === '"') {
      const start = i;
      const s = readString();
      let j = i; while (j < text.length && /\s/.test(text[j])) j++;
      const top = stack[stack.length - 1];
      if (top?.kind === "obj" && text[j] === ":" && pendingKey === undefined) { pendingKey = s; i = j + 1; continue; }
      const key = top?.kind === "arr" ? `${path()}:${top.idx}` : [path(), pendingKey].filter(Boolean).join(":");
      out.push({ key, value: s, line: lineOf(text, start) });
      if (top?.kind === "arr") top.idx++;
      pendingKey = undefined;
      continue;
    }
    if (c === ",") { pendingKey = undefined; i++; continue; }
    if (/[-0-9tfn]/.test(c)) { // number / true / false / null
      while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
      const top = stack[stack.length - 1];
      if (top?.kind === "arr") top.idx++;
      pendingKey = undefined;
      continue;
    }
    i++;
  }
  return out;
}

const URL_RE = /^https?:\/\/[^\s/"'<>]+/i;
export const hostOf = (url: string) => (URL_RE.exec(url)?.[0] ?? "").replace(/^https?:\/\//i, "").replace(/:\d+$/, "").toLowerCase();
const pathOf = (url: string) => url.replace(URL_RE, "") || "/";

/** All URL values from the repo's appsettings*.json (`<…>` placeholders and empty ones are skipped). */
export function configUrls(m: RepoMirror): ConfigValue[] {
  const out: ConfigValue[] = [];
  for (const f of files(m.dir).filter((x) => /(^|\/)appsettings[^/]*\.json$/i.test(x) && !isTestPath(x))) {
    for (const v of scanJsonStrings(read(m, f))) if (URL_RE.test(v.value)) out.push({ ...v, file: f, env: envOfSettings(f) });
  }
  return out;
}
/** Key value per environment (key is compared case-insensitively, as in IConfiguration). */
export function valuesOf(all: ConfigValue[], key: string): ConfigValue[] {
  const k = key.toLowerCase();
  const vs = all.filter((v) => v.key.toLowerCase() === k);
  // Production first: it will be `at` in via
  const rank = (e: string) => (/^prod/i.test(e) ? 0 : e === "Default" ? 1 : 2);
  return vs.sort((a, b) => rank(a.env) - rank(b.env));
}
const configVia = (m: RepoMirror, key: string, vs: ConfigValue[]): Via => ({
  type: "config", key, at: `${m.repo}/${vs[0].file}:${vs[0].line}`, envs: [...new Set(vs.map((v) => v.env))], value: vs[0].value,
});

// ---------------------------------------------------------------- C# expressions: call arguments, URL assembly
/** End of the argument expression starting at `from` (bracket balance, up to a top-level `,` or `)`). */
function argEnd(text: string, from: number): number {
  let depth = 0, i = from, inStr: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return i; depth--; }
    else if ((c === "," || c === ";") && depth === 0) return i;
  }
  return i;
}

/**
 * Path suffix from the assembly expression AFTER the config property:
 *   `+ year` → "/{}"? no — "{}" (concatenation without a slash);  `+ "/lit"` → "/lit";  `+ $"/{id}"` → "/{}";
 *   `+ QueryString.Create(…)` / `+ "?x="` → query, ignored. Unknown expression → "{}".
 */
export function composeSuffix(rest: string): string {
  let out = "";
  const terms = rest.split(/\+(?![^(]*\))/).map((t) => t.trim()).filter(Boolean);
  for (const t of terms) {
    const lit = /^@?"([^"]*)"$/.exec(t);
    if (lit) { if (lit[1].startsWith("?")) break; out += lit[1]; continue; }
    const interp = /^\$@?"([^"]*)"$/.exec(t) ?? /^@\$"([^"]*)"$/.exec(t);
    if (interp) { if (interp[1].startsWith("?")) break; out += interp[1].replace(/\{[^}]*\}/g, "{}"); continue; }
    if (/QueryString|Query|\?/.test(t)) break;
    if (/\.ToString\(\)|^\w+$|^\w+\.\w+$/.test(t)) { out += "{}"; continue; }
    out += "{}";
  }
  return out.split("?")[0];
}

const HTTP_CALL = /\.(Get|Post|Put|Patch|Delete|Send)(FromJson|AsJson|String|ByteArray|Stream)?Async\s*(?:<[^>()]*(?:<[^>()]*>)?[^>()]*>)?\s*\(/g;
/** HTTP call in whose first argument the position `pos` sits (within one statement). */
function enclosingHttpCall(text: string, pos: number): { index: number; verb: string | null; argStart: number; argEnd: number } | undefined {
  const stmtStart = Math.max(text.lastIndexOf(";", pos), text.lastIndexOf("{", pos), text.lastIndexOf("}", pos)) + 1;
  HTTP_CALL.lastIndex = stmtStart;
  let best: { index: number; verb: string | null; argStart: number; argEnd: number } | undefined;
  for (let m = HTTP_CALL.exec(text); m && m.index < pos; m = HTTP_CALL.exec(text)) {
    const argStart = m.index + m[0].length;
    const end = argEnd(text, argStart);
    if (pos >= argStart && pos <= end) {
      let verb = m[1] === "Send" ? null : m[1].toUpperCase();
      if (m[1] === "Send") verb = /HttpMethod\s*\.\s*(Get|Post|Put|Patch|Delete)/i.exec(text.slice(argStart, end))?.[1]?.toUpperCase() ?? null;
      best = { index: m.index, verb, argStart, argEnd: end };
    }
  }
  return best;
}
/** The method whose body contains the position (for `return <url>` in a helper: private string GetUrl(…) { return X + …; }). */
function enclosingMethodName(text: string, pos: number): string | undefined {
  const before = text.slice(Math.max(0, pos - 3000), pos);
  const ms = [...before.matchAll(/(?:private|public|protected|internal|static|async|\s)+[\w<>\[\],. ?]+\s(\w+)\s*\([^;{)]*\)\s*(?:=>|\{)/g)];
  return ms.at(-1)?.[1];
}

// ---------------------------------------------------------------- L-2: config key → property → assembly
interface KeyUse { file: string; index: number; text: string; expr: string }

/** Where the code reads the key: an options class property (Configure<T>/Bind/unique name) or direct access `config["A:B"]`. */
function usesOfKey(m: RepoMirror, key: string): { uses: KeyUse[]; declared: boolean } {
  const leaf = key.split(":").pop()!;
  const uses: KeyUse[] = [];
  let declared = false;
  const csFiles = files(m.dir).filter((f) => f.endsWith(".cs") && !isTestPath(f));
  // 1) direct access by the full key
  const direct = new RegExp(String.raw`(?:\[\s*"${esc(key)}"\s*\]|GetValue<[^>]+>\(\s*"${esc(key)}"\s*\))`, "gi");
  // 2) a property of an options class with the same name (fallback spec 03 §4.2: a property unique in the repo)
  const propDecl = new RegExp(String.raw`public\s+[\w?<>]+\s+${esc(leaf)}\s*\{\s*get`, "g");
  const owners: string[] = [];
  for (const f of csFiles) {
    const text = read(m, f);
    for (const mm of text.matchAll(direct)) uses.push({ file: f, index: mm.index!, text, expr: mm[0] });
    if (propDecl.test(text)) { propDecl.lastIndex = 0; owners.push(f); }
  }
  if (owners.length === 1) {
    declared = true;
    const usage = new RegExp(String.raw`\.\s*${esc(leaf)}\b(?!\s*\{)(?!\s*=[^=>])`, "g");
    for (const f of csFiles) {
      if (f === owners[0]) continue;
      const text = read(m, f);
      for (const mm of text.matchAll(usage)) uses.push({ file: f, index: mm.index!, text, expr: mm[0] });
    }
  } else if (uses.length) declared = true;
  return { uses, declared };
}

/** HTTP calls with an address from config (L-2). HttpClient base addresses are separate (namedClientCalls). */
export function configUrlCalls(m: RepoMirror, all: ConfigValue[] = configUrls(m)): ClientCall[] {
  const out: ClientCall[] = [];
  const keys = [...new Set(all.map((v) => v.key))];
  for (const key of keys) {
    const vs = valuesOf(all, key);
    const leaf = key.split(":").pop()!;
    // HttpClient base addresses — L-3b; identity/swagger/health — external or not API calls (L-3c)
    if (/BaseAddress|BaseUrl$/i.test(leaf)) continue;
    if (/auth|login|identity|issuer|authority|swagger|health|logo|avatar|redirect|callback|origin|cors/i.test(key + vs[0].value)) continue;
    const hosts = [...new Set(vs.map((v) => hostOf(v.value)))];
    const cfg = configVia(m, key, vs);
    const { uses, declared } = usesOfKey(m, key);
    let found = 0;
    for (const u of uses) {
      let call = enclosingHttpCall(u.text, u.index);
      let helper: Via | undefined;
      let exprText: string;
      if (call) {
        exprText = u.text.slice(u.index, call.argEnd);
      } else {
        // one step via a helper: private string GetUrl(…) => X + …;  … GetFromJsonAsync(GetUrl(d))
        const stmtEnd = u.text.indexOf(";", u.index);
        const stmt = u.text.slice(Math.max(u.text.lastIndexOf("\n", u.index), 0), stmtEnd);
        const name = /\breturn\b|=>/.test(stmt) ? enclosingMethodName(u.text, u.index) : undefined;
        if (!name) continue;
        exprText = u.text.slice(u.index, stmtEnd);
        const hc = [...u.text.matchAll(new RegExp(String.raw`\b${esc(name)}\s*\(`, "g"))].map((x) => enclosingHttpCall(u.text, x.index!)).filter(Boolean);
        for (const h of hc) {
          helper = { type: "helper", method: name, at: `${m.repo}/${u.file}:${lineOf(u.text, u.index)}` };
          const suffix = composeSuffix(exprText.replace(/^\.\s*\w+/, ""));
          for (const v of [vs[0]]) {
            out.push(mk(m, u.file, lineOf(u.text, h!.index), h!.verb, pathOf(v.value) + suffix, `${key} + ${exprText.replace(/^\.\s*\w+\s*/, "").trim() || "∅"}`,
              [cfg, helper, { type: "compose", expr: exprText.replace(/\s+/g, " ").trim() }], hosts, key, true));
          }
          found++;
        }
        continue;
      }
      // assembly expression: `X.Leaf + year`, `X.Leaf + $"/{id}"`, `$"{X.Leaf}/{id}"` (in this case — the tail of an interpolated string)
      let suffix: string;
      const interp = /\$"([^"]*)$/.exec(u.text.slice(call.argStart, u.index));
      if (interp) suffix = (/^[^}]*\}([^"]*)"/.exec(u.text.slice(u.index))?.[1] ?? "").replace(/\{[^}]*\}/g, "{}");
      else suffix = composeSuffix(exprText.replace(/^\.\s*\w+/, ""));
      out.push(mk(m, u.file, lineOf(u.text, call.index), call.verb, pathOf(vs[0].value) + suffix,
        `${key}${suffix ? ` + ${suffix}` : ""}`, [cfg, { type: "compose", expr: u.text.slice(call.argStart, call.argEnd).replace(/\s+/g, " ").trim() }], hosts, key, true));
      found++;
    }
    if (!found) {
      // assembly not found: from = the config line. The property is declared but never read → declared.
      const unused = declared && !uses.length;
      const c = mk(m, vs[0].file, vs[0].line, null, pathOf(vs[0].value), `${key}=${vs[0].value}`, [cfg], hosts, key, false);
      c.usage = unused ? "declared" : "used";
      c.trailingParam = vs[0].value.endsWith("/");
      c.pattern = unused ? "L-2:config-unused" : "C-5:config-url";
      out.push(c);
    }
  }
  return out;
}

function mk(m: RepoMirror, file: string, line: number, method: string | null, rawPath: string, raw: string, via: Via[], hosts: string[], key: string, composed: boolean): ClientCall {
  return { repo: m.repo, file, line, method, route: normalizeRoute(rawPath), raw, usage: "used", pattern: composed ? "L-2:config-url+compose" : "C-5:config-url", via, hosts, configKey: key, composed };
}

// ---------------------------------------------------------------- L-3b: base address + named / typed HttpClient
interface NamedClient { name: string; at: string; baseKey?: string; baseValues: ConfigValue[]; literalBase?: string }

export function namedClients(m: RepoMirror, all: ConfigValue[] = configUrls(m)): NamedClient[] {
  const k = csharpConstants(m);
  const out: NamedClient[] = [];
  for (const f of files(m.dir).filter((x) => x.endsWith(".cs") && !isTestPath(x))) {
    const text = read(m, f);
    for (const reg of text.matchAll(/AddHttpClient(?:<\s*(\w+)\s*(?:,\s*\w+\s*)?>)?\(\s*([^,)]*?)\s*(?:,|\))/g)) {
      const nameExpr = reg[2].trim();
      const name = nameExpr ? evalCsString(nameExpr, undefined, k) ?? nameExpr : reg[1];
      if (!name) continue;
      // the body of the registration lambda — until the next registration or ~40 lines
      const next = text.indexOf("AddHttpClient", reg.index! + reg[0].length);
      const body = text.slice(reg.index!, next > 0 ? Math.min(next, reg.index! + 3000) : reg.index! + 3000);
      const ba = /BaseAddress\s*=\s*new\s+Uri\(\s*([\s\S]+?)\s*\)\s*;/.exec(body);
      const nc: NamedClient = { name, at: `${m.repo}/${f}:${lineOf(text, reg.index!)}`, baseValues: [] };
      if (ba) {
        const e = ba[1];
        const lit = /^"(https?:\/\/[^"]+)"$/.exec(e);
        const kv = /(?:GetValue<[^>]+>\(\s*|\[\s*)"([^"]+)"/.exec(e);
        const prop = /^(\w+)\.(\w+)$/.exec(e);
        if (lit) nc.literalBase = lit[1];
        else if (kv) nc.baseKey = kv[1];
        else if (prop) {
          // var opts = configuration.GetSection(EmployeeOptions.Employee).Get<EmployeeOptions>(); … new Uri(opts.BaseAddress)
          const decl = new RegExp(String.raw`${esc(prop[1])}\s*=\s*[\w.]*GetSection\(\s*([^)]+?)\s*\)`).exec(body);
          const section = decl ? evalCsString(decl[1], undefined, k) : undefined;
          if (section) nc.baseKey = `${section}:${prop[2]}`;
          else {
            // options class property: Configure<T>(…GetSection(X)) somewhere in the repo
            const leafOwners = all.filter((v) => v.key.toLowerCase().endsWith(`:${prop[2].toLowerCase()}`));
            if (new Set(leafOwners.map((v) => v.key)).size === 1) nc.baseKey = leafOwners[0].key;
          }
        }
        if (nc.baseKey) nc.baseValues = valuesOf(all, nc.baseKey);
      }
      out.push(nc);
    }
  }
  return out;
}

/** Calls via CreateClient("Name") / a typed client with a relative path → host and base-address path. */
export function namedClientCalls(m: RepoMirror, all: ConfigValue[] = configUrls(m)): ClientCall[] {
  const clients = namedClients(m, all).filter((c) => c.baseValues.length || c.literalBase);
  if (!clients.length) return [];
  const k = csharpConstants(m);
  const out: ClientCall[] = [];
  for (const f of files(m.dir).filter((x) => x.endsWith(".cs") && !isTestPath(x))) {
    const text = read(m, f);
    for (const cc of text.matchAll(/(\w+)\s*=\s*[\w.]*CreateClient\(\s*([^)]*?)\s*\)/g)) {
      const name = evalCsString(cc[2], undefined, k) ?? cc[2];
      const nc = clients.find((c) => c.name === name);
      if (!nc) continue;
      const nextCreate = text.indexOf("CreateClient(", cc.index! + cc[0].length);
      const scopeEnd = Math.min(nextCreate > 0 ? nextCreate : text.length, cc.index! + 4000);
      const re = new RegExp(String.raw`\b${esc(cc[1])}\s*\.\s*(Get|Post|Put|Patch|Delete|Send)(\w*)Async\s*(?:<[^>()]*>)?\s*\(\s*`, "g");
      re.lastIndex = cc.index!;
      for (let mm = re.exec(text); mm && mm.index < scopeEnd; mm = re.exec(text)) {
        const argStart = mm.index + mm[0].length;
        const arg = text.slice(argStart, argEnd(text, argStart)).trim();
        let rel: string | undefined;
        const lit = /^@?"([^"]*)"$/.exec(arg), interp = /^\$@?"([^"]*)"$/.exec(arg);
        if (lit) rel = lit[1]; else if (interp) rel = interp[1].replace(/\{[^}]*\}/g, "{}");
        const verb = mm[1] === "Send" ? (/HttpMethod\s*\.\s*(\w+)/.exec(arg)?.[1]?.toUpperCase() ?? null) : verbOf(mm[1]);
        const base = nc.literalBase ?? nc.baseValues[0].value;
        const hosts = nc.literalBase ? [hostOf(nc.literalBase)] : [...new Set(nc.baseValues.map((v) => hostOf(v.value)))];
        const via: Via[] = [
          ...(nc.baseKey && nc.baseValues.length ? [configVia(m, nc.baseKey, nc.baseValues)] : []),
          { type: "http-client", name: nc.name, at: nc.at, ...(nc.baseKey ? { baseKey: nc.baseKey } : {}) },
        ];
        const basePath = pathOf(base).replace(/\/$/, "");
        const c: ClientCall = {
          repo: m.repo, file: f, line: lineOf(text, mm.index), method: verb,
          route: rel !== undefined ? normalizeRoute(rel.startsWith("/") ? rel : `${basePath}/${rel}`) : normalizeRoute(basePath),
          raw: `${nc.name}: ${mm[1]}${mm[2]}Async(${arg.slice(0, 80)})`, usage: "used",
          pattern: rel !== undefined ? "L-3b:http-client" : "L-3b:http-client-dynamic", via, hosts, configKey: nc.baseKey, composed: rel !== undefined,
        };
        out.push(c);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- C-8: frontend environment*.ts
export interface EnvProp { prop: string; value: string; file: string; line: number; env: string }
export function environmentProps(m: RepoMirror): EnvProp[] {
  const out: EnvProp[] = [];
  const all = files(m.dir);
  // Angular: environment.prod.ts → { apiUrl: 'https://…' }
  for (const f of all.filter((x) => /(^|\/)environment[^/]*\.ts$/i.test(x))) {
    const text = read(m, f);
    const env = /environment\.([^/]+)\.ts$/i.exec(f)?.[1] ?? "default";
    for (const mm of text.matchAll(/(\w+)\s*:\s*['"`](https?:\/\/[^'"`]+)['"`]/g)) out.push({ prop: mm[1], value: mm[2], file: f, line: lineOf(text, mm.index!), env });
  }
  // L-6: Vite / CRA — .env.<environment>: only public VITE_* / NG_* / REACT_APP_* / PUBLIC_* keys (bundled into the app)
  const envVars = new Map<string, EnvProp[]>();
  for (const f of all.filter((x) => /(^|\/)\.env\.[A-Za-z]+$/.test(x))) {
    const text = read(m, f);
    const env = /\.env\.([A-Za-z]+)$/.exec(f)![1];
    for (const mm of text.matchAll(/^\s*(?:export\s+)?((?:VITE_|NG_|REACT_APP_|PUBLIC_)[A-Z0-9_]*)\s*=\s*["']?(https?:\/\/[^"'\s#]+)/gm)) {
      const p = { prop: mm[1], value: mm[2], file: f, line: lineOf(text, mm.index!), env };
      (envVars.get(mm[1]) ?? envVars.set(mm[1], []).get(mm[1])!).push(p);
      out.push(p);   // direct access: `${import.meta.env.VITE_X}/path`
    }
  }
  // intermediary fields: { timetrackingBaseUrl: import.meta.env.VITE_TIMETRACKING_BASE_URL } → environment.timetrackingBaseUrl
  if (envVars.size) {
    for (const f of all.filter((x) => /\.(ts|tsx|js|jsx|mjs)$/.test(x) && !isTestPath(x))) {
      const text = read(m, f);
      for (const mm of text.matchAll(/(\w+)\s*:\s*(?:import\.meta\.env|process\.env)\.([A-Z][A-Z0-9_]*)/g)) {
        for (const v of envVars.get(mm[2]) ?? []) out.push({ ...v, prop: mm[1] });
      }
    }
  }
  return out;
}

/**
 * Calls with `${environment.X}/path` (directly or via a field `_baseUrl = \`${environment.X}/v1\``): hosts from environment*.ts,
 * the base path of the value is appended to the route. Returns the key "file:line" → refinement for already found C-2 calls.
 */
export function environmentBases(m: RepoMirror): Map<string, { hosts: string[]; basePath: string; via: Via }> {
  const props = environmentProps(m);
  const res = new Map<string, { hosts: string[]; basePath: string; via: Via }>();
  if (!props.length) return res;
  const byProp = new Map<string, EnvProp[]>();
  for (const p of props) (byProp.get(p.prop) ?? byProp.set(p.prop, []).get(p.prop)!).push(p);
  for (const f of files(m.dir).filter((x) => /\.(ts|tsx|js|jsx|vue)$/.test(x) && !isTestPath(x) && !/environment[^/]*\.ts$/.test(x))) {
    const text = read(m, f);
    if (!text.includes("environment") && !text.includes(".env.")) continue;
    // intermediary fields: private _baseUrl = `${environment.timetrackingServer}/v1`;
    const fields = new Map<string, { prop: string; suffix: string }>();
    for (const fm of text.matchAll(/(\w+)\s*(?::\s*string\s*)?=\s*`\$\{environment\.(\w+)\}([^`$]*)`/g)) fields.set(fm[1], { prop: fm[2], suffix: fm[3] });
    for (const tm of text.matchAll(/`\$\{\s*(?:this\.)?(environment\.(\w+)|(?:import\.meta\.env|process\.env)\.(\w+)|(\w+))\s*\}/g)) {
      const direct = tm[2] ?? tm[3];
      const field = tm[4] ? fields.get(tm[4]) : undefined;
      const prop = direct ?? field?.prop;
      const vals = prop ? byProp.get(prop) : undefined;
      if (!vals?.length) continue;
      const prod = vals.find((v) => /prod/i.test(v.env)) ?? vals[0];
      res.set(`${f}:${lineOf(text, tm.index!)}`, {
        hosts: [...new Set(vals.map((v) => hostOf(v.value)))],
        basePath: (pathOf(prod.value).replace(/\/$/, "") + (field?.suffix ?? "")).replace(/\/$/, ""),
        via: { type: "environment", prop: prop!, at: `${m.repo}/${prod.file}:${prod.line}`, envs: [...new Set(vals.map((v) => v.env))] },
      });
    }
  }
  return res;
}
