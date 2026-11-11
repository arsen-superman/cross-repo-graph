// Optional <index>/config.json. Everything has a default, so a project needs no config at all.
//
// {
//   "scopes": { "dev": "develop|default", "prod": "main|master|default" },  // scope → branch candidates, first existing wins
//   "repos":  { "legacy-api": { "prod": "release" } },           // per-repo overrides of a scope's branches
//   "fetch":  true,                                               // false: never fetch, index what is already local
//   "hosts":  { "timetracking.example.com": "timetracking-api" }  // manual host catalog entries for the linker
// }
//
// "default" stands for the repo's default branch (origin/HEAD, else main / master).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Index configuration after defaults are applied. */
export interface IndexConfig {
  scopes: Record<string, string>;
  repos: Record<string, Record<string, string>>;
  fetch: boolean;
  hosts: Record<string, string>;
}

// prod is not "default": many teams make develop the GitHub default branch while main / master is what is deployed
export const DEFAULT_SCOPES: Record<string, string> = { dev: "develop|default", prod: "main|master|default" };

/** Reads <indexDir>/config.json if present and fills in the defaults. */
export function loadConfig(indexDir: string): IndexConfig {
  const p = join(indexDir, "config.json");
  const raw = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<IndexConfig>) : {};
  const scopes = raw.scopes && Object.keys(raw.scopes).length ? raw.scopes : DEFAULT_SCOPES;
  for (const name of Object.keys(scopes)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`config.json: scope name "${name}" must be lowercase letters, digits or "-"`);
  }
  return { scopes, repos: raw.repos ?? {}, fetch: raw.fetch ?? true, hosts: raw.hosts ?? {} };
}

/** Branch spec of a scope for one repo: the per-repo override, else the scope's spec. */
export const specFor = (cfg: IndexConfig, repo: string, scope: string) => cfg.repos[repo]?.[scope] ?? cfg.scopes[scope];
