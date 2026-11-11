// Graphify (https://github.com/Graphify-Labs/graphify, Apache-2.0) builds the per-repo AST graph — no LLM.
// It runs through `uvx`, pinned, so the host needs only uv; CRG_GRAPHIFY overrides the command
// (e.g. a path to a graphify executable in an existing virtualenv).
// PYTHONHASHSEED is set up front: otherwise Graphify re-execs itself to pin it, and os.execvpe crashes on Windows.
import { execFileSync } from "node:child_process";

export const GRAPHIFY_VERSION = "0.9.66";

function command(): [string, string[]] {
  const custom = process.env.CRG_GRAPHIFY?.trim();
  if (custom?.startsWith("[")) { const [c, ...a] = JSON.parse(custom) as string[]; return [c, a]; }   // ["node", "fake.mjs"] in tests
  if (custom) return [custom, []];
  return ["uvx", ["--quiet", "--from", `graphifyy==${GRAPHIFY_VERSION}`, "graphify"]];
}

function run(args: string[]): void {
  const [cmd, pre] = command();
  try {
    execFileSync(cmd, [...pre, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GRAPHIFY_FORCE: "1", PYTHONUTF8: "1", PYTHONHASHSEED: process.env.PYTHONHASHSEED ?? "0" } });
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer; message?: string };
    if (err.code === "ENOENT") throw new Error(`"${cmd}" not found: install uv (https://docs.astral.sh/uv/) or set CRG_GRAPHIFY to a graphify executable.`);
    throw new Error(`graphify ${args[0]} failed: ${(err.stderr?.toString() || err.message || String(e)).slice(-800)}`);
  }
}

/** True when the Graphify command can be started. */
export function graphifyAvailable(): boolean {
  try { run(["--help"]); return true; } catch { return false; }
}

/** AST-only extraction of one repository into outDir; the graph lands in outDir/graphify-out/graph.json. Respects .gitignore. */
export function extractRepo(repoDir: string, outDir: string): void {
  run(["extract", repoDir, "--code-only", "--no-cluster", "--out", outDir]);
}

/** Graphify's own cross-repo merge; used only for the cross-repo edges it finds (shared types, package calls). */
export function mergeGraphs(graphPaths: string[], outPath: string): void {
  run(["merge-graphs", ...graphPaths, "--out", outPath]);
}
