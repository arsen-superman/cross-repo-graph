#!/usr/bin/env node
// cross-repo-graph CLI:
//   cross-repo-graph index [--project <dir>] [--index <dir>] [--force] [--hosts <file.json>]
//   cross-repo-graph serve [--index <dir>] [--http <port>] [--host <addr>]
// Defaults: project = current folder, index = <project>/.ai/.index.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response } from "express";
import { runIndex } from "./indexer/index.js";
import { createServer, VERSION } from "./server/server.js";

const USAGE = `cross-repo-graph ${VERSION}

  index   Build or refresh the index of all git repositories in a project folder
          --project <dir>   project folder (default: current folder)
          --index <dir>     index folder (default: <project>/.ai/.index)
          --force           re-extract every repo, even unchanged ones
          --hosts <file>    JSON { "host": "repo-key" } — manual entries for the host catalog

  serve   Run the MCP server over an index (stdio by default)
          --index <dir>     index folder (default: ./.ai/.index)
          --http <port>     serve Streamable HTTP on this port instead of stdio
          --host <addr>     HTTP bind address (default: 127.0.0.1)
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      project: { type: "string" }, index: { type: "string" }, force: { type: "boolean" }, hosts: { type: "string" },
      http: { type: "string" }, host: { type: "string" },
    },
    strict: true,
  });

  if (cmd === "index") {
    const projectDir = resolve(values.project ?? ".");
    const manualHosts = values.hosts ? JSON.parse(readFileSync(values.hosts, "utf8")) as Record<string, string> : {};
    const r = runIndex({ projectDir, indexDir: values.index ?? join(projectDir, ".ai", ".index"), force: values.force, manualHosts });
    return r.exitCode;
  }

  if (cmd === "serve") {
    const indexDir = resolve(values.index ?? join(".ai", ".index"));
    if (!values.http) {
      await createServer(indexDir).connect(new StdioServerTransport());
      return -1;   // keep running until stdin closes
    }
    const host = values.host ?? "127.0.0.1";
    const app = createMcpExpressApp({ host });
    app.get("/healthz", (_req: Request, res: Response) => { res.json({ ok: true, name: "cross-repo-graph", index: indexDir }); });
    // Stateless: a fresh server and transport per request, no Mcp-Session-Id.
    app.post("/mcp", async (req: Request, res: Response) => {
      const server = createServer(indexDir);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error(JSON.stringify({ level: "error", error: String(err) }));
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    });
    const port = Number(values.http);
    app.listen(port, host, () => console.error(`cross-repo-graph: http://${host}:${port}/mcp (index ${indexDir})`));
    return -1;
  }

  process.stdout.write(USAGE);
  return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1;
}

main().then((code) => { if (code >= 0) process.exit(code); }, (err) => { console.error(String(err)); process.exit(1); });
