// Stands in for Graphify in tests: `extract <dir> ... --out <out>` writes one node per .cs/.ts file; merge-graphs fails.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const [cmd, ...args] = process.argv.slice(2);
if (cmd !== "extract") process.exit(1);
const src = args[0], out = args[args.indexOf("--out") + 1];
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== ".git") walk(join(d, e.name)); }
    else if (/\.(cs|ts)$/.test(e.name)) files.push(relative(src, join(d, e.name)).split("\\").join("/"));
  }
};
walk(src);
mkdirSync(join(out, "graphify-out"), { recursive: true });
writeFileSync(join(out, "graphify-out", "graph.json"), JSON.stringify({ nodes: files.map((f) => ({ id: f, label: f.split("/").pop(), file_type: "code", source_file: f, source_location: "L1" })), edges: [] }));
