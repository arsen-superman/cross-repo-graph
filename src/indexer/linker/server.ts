// Server side (S-1…S-5): endpoints of ASP.NET Core controllers (C#, F#), minimal API.
import { type CsConstants, type Endpoint, type RepoMirror, csharpConstants, files, lineOf, normalizeRoute, read } from "./common.js";

// C# attribute with one level of nested brackets: [Route("api/[controller]")]
const ATTR = String.raw`\[(?:[^\[\]]|\[[^\]]*\])*\]`;

// ---------------------------------------------------------------- HTTP: server endpoints
/** Evaluates an attribute argument: "a" + R.B + "c". Unknown part → undefined (the endpoint is skipped). */
function evalRouteExpr(expr: string, cls: string, k: CsConstants): string | undefined {
  let out = "";
  for (const part of expr.split("+").map((p) => p.trim())) {
    const lit = /^@?"([^"]*)"$/.exec(part);
    if (lit) { out += lit[1]; continue; }
    const ref = /^(?:(\w+)\.)?(\w+)$/.exec(part);
    if (!ref) return undefined;
    const owner = ref[1] ? (k.aliases.get(ref[1]) ?? ref[1]) : cls;
    const v = k.consts.get(`${owner}.${ref[2]}`);
    if (v === undefined) return undefined;
    out += v;
  }
  return out;
}
// argument: quoted strings (may contain "]", e.g. "api/[controller]") or identifiers and "+"
const ROUTE_ATTR = /\[Route\(\s*((?:"[^"]*"|[^\]"])*?)\s*\)\]/;

/** Top-level attribute arguments: `R.Project, ClaimType.X, ClaimValue.Read` → 3 parts. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", str = false;
  for (const c of s) {
    if (c === '"') str = !str;
    if (!str && (c === "(" || c === "[")) depth++;
    if (!str && (c === ")" || c === "]")) depth--;
    if (!str && depth === 0 && c === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Custom route attributes (S-2+): `class ClaimsRouteAttribute : RouteAttribute` with constructors
 * `(string claimType, ClaimValue v)` and `(string template, string claimType, ClaimValue v) : base(template)`.
 * Result: attribute name → (number of arguments → template index or -1 if there is no template).
 */
function customRouteAttributes(m: RepoMirror): Map<string, Map<number, number>> {
  const res = new Map<string, Map<number, number>>();
  for (const f of files(m.dir)) {
    if (!f.endsWith(".cs")) continue;
    const text = read(m, f);
    for (const c of text.matchAll(/class\s+(\w+?)(Attribute)?\s*:\s*(?:Microsoft\.AspNetCore\.Mvc\.)?RouteAttribute\b/g)) {
      const cls = `${c[1]}${c[2] ?? ""}`;
      const byArgs = new Map<number, number>();
      for (const ctor of text.matchAll(new RegExp(String.raw`public\s+${cls}\s*\(([^)]*)\)`, "g"))) {
        const params = ctor[1].trim() ? splitArgs(ctor[1]) : [];
        byArgs.set(params.length, params.findIndex((p) => /\btemplate\b/i.test(p)));
      }
      res.set(c[1], byArgs);   // usage without the Attribute suffix: [ClaimsRoute(…)]
    }
  }
  return res;
}
/** Template from a custom route attribute among the method's attributes; "" — attribute without a template; undefined — no such attribute. */
function customRouteTemplate(attrs: string, custom: Map<string, Map<number, number>>): string | undefined {
  for (const [name, byArgs] of custom) {
    const m = new RegExp(String.raw`\[${name}(?:Attribute)?\(\s*((?:"[^"]*"|[^\]"])*?)\s*\)\]`).exec(attrs);
    if (!m) continue;
    const args = splitArgs(m[1]);
    const idx = byArgs.get(args.length);
    return idx === undefined || idx < 0 ? "" : args[idx];
  }
  return undefined;
}
const VERB_ATTR = /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*((?:"[^"]*"|[^\]"])*?)\s*\))?\]/;

/** F# ASP.NET Core: [<Route("[controller]")>] type XController … [<HttpGet("x")>] / [<Route("/abs")>] member __.M() */
function fsharpEndpoints(m: RepoMirror, f: string): Endpoint[] {
  const out: Endpoint[] = [];
  const text = read(m, f);
  const FATTR = String.raw`\[<(?:[^>]|>(?!\]))*>\]`;
  const types = [...text.matchAll(new RegExp(String.raw`((?:${FATTR}\s*)*)type\s+(\w+)`, "g"))];
  types.forEach((tm, ti) => {
    const ctrl = tm[2].replace(/Controller$/, "");
    const classRoute = /\[<Route\(\s*"([^"]*)"\s*\)>\]/.exec(tm[1] ?? "")?.[1] ?? "";
    const start = tm.index! + tm[0].length, end = ti + 1 < types.length ? types[ti + 1].index! : text.length;
    const body = text.slice(start, end);
    for (const mm of body.matchAll(new RegExp(String.raw`((?:${FATTR}\s*)+)member\s+\w+\.(\w+)`, "g"))) {
      const verb = /\[<Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?>\]/.exec(mm[1]);
      if (!verb) continue;
      const mr = verb[2] ?? /\[<Route\(\s*"([^"]*)"\s*\)>\]/.exec(mm[1])?.[1] ?? "";
      let full = mr.startsWith("/") || mr.startsWith("~/") ? mr.replace(/^~/, "") : [classRoute, mr].filter(Boolean).join("/");
      full = full.replace(/\[controller\]/gi, ctrl).replace(/\[action\]/gi, mm[2]);
      out.push({ repo: m.repo, file: f, line: lineOf(text, start + mm.index! + mm[1].length), method: verb[1].toUpperCase(), route: normalizeRoute(full), raw: full, symbol: `${tm[2]}.${mm[2]}` });
    }
  });
  return out;
}

export function extractServerEndpoints(m: RepoMirror): Endpoint[] {
  const out: Endpoint[] = [];
  const k = csharpConstants(m);
  const custom = customRouteAttributes(m);
  for (const f of files(m.dir)) {
    if (f.endsWith(".fs")) { out.push(...fsharpEndpoints(m, f)); continue; }
    if (!f.endsWith(".cs")) continue;
    const text = read(m, f);
    // Minimal API: app.MapGet("/api/x", ...)
    for (const mm of text.matchAll(/\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/g)) {
      out.push({ repo: m.repo, file: f, line: lineOf(text, mm.index!), method: mm[1].toUpperCase(), route: normalizeRoute(mm[2]), raw: mm[2] });
    }
    // Controllers: [Route("api/[controller]")] class XController ... [HttpGet("{id}")] public ... Method(
    const classRe = new RegExp(String.raw`((?:${ATTR}\s*)*)public\s+(?:sealed\s+|abstract\s+|partial\s+)*class\s+(\w+)`, "g");
    const classes = [...text.matchAll(classRe)];
    classes.forEach((cm, ci) => {
      const attrs = cm[1] ?? "";
      const className = cm[2];
      const ctrl = className.replace(/Controller$/, "");
      const classExpr = ROUTE_ATTR.exec(attrs)?.[1];
      const classRoute = classExpr ? evalRouteExpr(classExpr, className, k) : "";
      if (classRoute === undefined) return; // route from unknown constants — do not guess
      const bodyStart = cm.index! + cm[0].length;
      const bodyEnd = ci + 1 < classes.length ? classes[ci + 1].index! : text.length;
      const body = text.slice(bodyStart, bodyEnd);
      const methodRe = new RegExp(String.raw`((?:${ATTR}\s*)+)public\s+[^\n(=]*?\s(\w+)\s*\(`, "g");
      for (const mm of body.matchAll(methodRe)) {
        const mattrs = mm[1];
        const verb = VERB_ATTR.exec(mattrs);
        if (!verb) continue;
        const verbArg = verb[2]?.replace(/,\s*Name\s*=.*$/, "");
        const routeExpr = verbArg || ROUTE_ATTR.exec(mattrs)?.[1] || (custom.size ? customRouteTemplate(mattrs, custom) : undefined);
        const methodRoute = routeExpr ? evalRouteExpr(routeExpr, className, k) : "";
        if (methodRoute === undefined) continue;
        let full = methodRoute.startsWith("/") || methodRoute.startsWith("~/") ? methodRoute.replace(/^~/, "") : [classRoute, methodRoute].filter(Boolean).join("/");
        full = full.replace(/\[controller\]/gi, ctrl).replace(/\[action\]/gi, mm[2]);
        out.push({ repo: m.repo, file: f, line: lineOf(text, bodyStart + mm.index! + mm[1].length), method: verb[1].toUpperCase(), route: normalizeRoute(full), raw: full, symbol: `${className}.${mm[2]}` });
      }
    });
  }
  return out;
}

