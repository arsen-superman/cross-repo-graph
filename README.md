# cross-repo-graph

A local MCP server that gives coding agents a code graph across **all repositories of a project**: classes, methods, calls and imports inside each repo, and the links *between* repos. Those links are HTTP calls from client to endpoint, service addresses from config, and NuGet/npm packages. Every link carries `file:line` evidence on both sides.

The question it answers best is "who breaks if I change this API?". Grep misses calls whose URL is assembled from config (`_settings.HolidayServiceUrl + year`) or that go through generated clients. The linker resolves both, and it separates calls that really exist (`used`) from clients that are only declared (`declared-only`).

## How it works

```
cross-repo-graph index                       cross-repo-graph serve
  project folder                               stdio (default) or --http <port>
   ├─ repo A ─┐ Graphify (AST, no LLM)          ├─ list_repos
   ├─ repo B ─┤──────────► per-repo graphs      ├─ query_graph / get_node / get_neighbors / shortest_path
   └─ repo C ─┘ cross-repo linker               ├─ dependencies        (between repos, file:line)
                     │                          └─ architecture_hubs   (central classes of a repo)
                     ▼
   .ai/.index/scopes/{dev,prod}/  graph.json · links.json · repos.json   ◄── read by the server, hot-reloaded
```

- **Indexer.** It finds every git repo one or two levels below the project folder and skips `worktrees/`. For each **scope** it takes that scope's branch from git, not from the folder on disk, so a feature branch checked out in a clone or an uncommitted edit never leaks into the graph and the clone is never touched. It runs [Graphify](https://github.com/Graphify-Labs/graphify) on that tree (AST only), merges the graphs, then adds cross-repo links. A (repo, commit) is extracted and parsed once, whichever scopes point at it, so an unchanged project re-indexes in a few seconds. Output files are replaced atomically, and a lock stops concurrent runs.
- **Scopes.** By default there are two. `dev` uses `develop`, falling back to the default branch; use it for features, bugs and spikes. `prod` uses `main` or `master`, falling back to the default branch; that is what runs in production, so use it for hotfixes. For every branch, `origin/<branch>` wins over the local one. `--working-tree` indexes the clones exactly as they are on disk instead, as a single `dev` scope.
- **Fetch.** With `--fetch` the indexer first runs `git fetch origin <scope branches>` in parallel. It only updates `origin/*` refs, never your branches or working copy. It never prompts for a password (an SSH agent still signs, so 1Password may ask once to approve), and it gives up on a repo after 20 s. `--fetch-min-interval 30` skips the fetch when the last one is under 30 minutes old. Without a fetch the graph is as fresh as your last `git fetch` or `pull`; `list_repos` flags repos whose origin wasn't fetched for 3 days.
- **Server.** It is read-only. It loads the graph once and reloads it when `graph.json` changes, and every answer fits a token budget. It does not read or search file contents: agents already have their own file tools.
- **Nothing leaves the machine.** No LLM. The only network use is the optional `git fetch` and uv downloading Graphify once.

The linker currently understands ASP.NET Core (C#, F#, minimal API), Angular/TypeScript HTTP clients, ng-openapi-gen, NSwag, Refit, `appsettings*.json`, `environment*.ts` and Vite/CRA `.env.<environment>` files (public prefixes only). For other stacks you still get the per-repo AST graph.

## Requirements

- Node.js 22+
- [uv](https://docs.astral.sh/uv/) on PATH (`winget install astral-sh.uv`, `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`). The indexer runs Graphify through `uvx --from graphifyy==0.9.66`. Set `CRG_GRAPHIFY` to use a graphify executable you already have.

## Usage

```bash
# in the project folder (the one that contains the repos)
npx -y cross-repo-graph index                 # → .ai/.index/
npx -y cross-repo-graph serve                 # MCP over stdio

# options
cross-repo-graph index --project <dir> --index <dir> [--fetch [--fetch-min-interval 30]] [--working-tree] [--force] [--hosts hosts.json]
cross-repo-graph serve --index <dir> [--http 3917] [--host 127.0.0.1]
```

`--hosts` takes `{ "timetracking.example.com": "timetracking-api" }` entries for services whose host the linker can't attribute on its own.

Optional `<index>/config.json`:

```jsonc
{
  "scopes": { "dev": "develop|default", "prod": "main|master|default" },  // branch candidates, first existing wins
  "repos":  { "legacy-api": { "prod": "release" } },                       // per-repo overrides
  "fetch":  true,                                                          // false: --fetch is ignored
  "hosts":  { "timetracking.example.com": "timetracking-api" }
}
```

### Claude Code

```bash
claude mcp add --scope local code-graph -- npx -y cross-repo-graph serve --index "<project>/.ai/.index"
```

With the [agent-playbook](https://github.com/arsen-superman/agent-playbook) `code-graph` plugin, the server and a SessionStart re-index hook are set up per project automatically.

### Docker / shared instance

`serve --http <port>` speaks stateless Streamable HTTP on `/mcp` (plus `/healthz`). Use it when several sessions or people should share one process, or when the graph is large.

## Tools

Every tool takes an optional `scope` (default `dev`).

| Tool | Use it for |
|---|---|
| `list_repos` | what a scope contains: repo keys, branch and commit, when origin was last fetched, available scopes |
| `dependencies` | who calls whom between repos; with `repo` — incoming and outgoing calls with `file:line` and the config chain; impact of an API change = `used` links |
| `get_neighbors` | direct callers / callees of a symbol, including HTTP calls from other repos |
| `query_graph` | find symbols by name and expand their neighbourhood (BFS) or trace a path (DFS) |
| `get_node` | one symbol: file, line, repo, degree |
| `shortest_path` | how two symbols are connected, across repos |
| `architecture_hubs` | the classes a repo is built around, with callers and incoming cross-repo calls |

## Development

```bash
npm install
npm test          # unit tests (node:test via tsx)
npm run build     # → dist/
```

## License

Apache-2.0. The graph query semantics are ported from Graphify (Apache-2.0); see [NOTICE](NOTICE).
