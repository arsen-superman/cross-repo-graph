// Which files of a repository the linker reads. Git repositories: tracked + untracked-but-not-ignored files
// (`git ls-files`), so .gitignore'd build output never counts. Plain directories (tests): a walk that skips
// build and dependency folders. Both are then filtered by the include / exclude globs below.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";

export const MAX_FILE_BYTES = 1_000_000;

const INCLUDE = [
  "**/*.{cs,csx,fs,vb,ts,tsx,js,jsx,mjs,cjs,vue,py,go,java,kt,rb,php,rs}",
  "**/*.{json,yaml,yml,xml,toml,ini,props,targets,csproj,fsproj,vbproj,sln,config}",
  // frontend environment files: their VITE_* / NG_* / REACT_APP_* values are bundled into the public app
  "**/.env.{development,production,staging,test}",
];
const EXCLUDE = [
  "**/{.git,node_modules,bin,obj,dist,build,out,coverage,.angular,.next,.nuxt,vendor,packages,TestResults}/**",
  "**/*.{min.js,min.css,map,lock,snap}",
  "**/{package-lock.json,yarn.lock,pnpm-lock.yaml,packages.lock.json}",
  "**/*{secret,secrets,credential,credentials}*",
  "**/appsettings.*.local.json",
  "**/*.tfstate*",
];
const SKIP_DIRS = new Set([".git", "node_modules", "bin", "obj", "dist", "build", "out", "coverage", ".angular", ".next", ".nuxt", "vendor", "packages", "TestResults"]);

const include = picomatch(INCLUDE, { dot: true });
const exclude = picomatch(EXCLUDE, { dot: true });
export const indexable = (rel: string) => include(rel) && !exclude(rel);

function gitFiles(root: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(join(dir, e.name)); }
      else if (e.isFile()) out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
    }
  };
  rec(root);
  return out;
}

/** Repository-relative paths (forward slashes, sorted) of the files the linker may read. */
export function listFiles(root: string): string[] {
  const all = (existsSync(join(root, ".git")) ? gitFiles(root) : undefined) ?? walk(root);
  return all
    .filter((f) => indexable(f))
    .filter((f) => { try { return statSync(join(root, f)).size <= MAX_FILE_BYTES; } catch { return false; } })
    .sort();
}
