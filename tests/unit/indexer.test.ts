// Unit tests of the file filter and the linker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { indexable, listFiles } from "../../src/indexer/files.js";
import { normalizeRoute, linkHttp, linkPackages, mergeRepoGraphs } from "../../src/indexer/linker.js";

test("file filter: secrets and build output excluded, code and configs included", () => {
  for (const ok of ["src/A.cs", "src/appsettings.json", "src/app/x.component.ts", "web/nuget.config", "web/.env.production", "api/Api.csproj"]) assert.ok(indexable(ok), ok);
  for (const no of [".env", "api/.env.local", "certs/dev.pfx", "src/bin/Debug/x.cs", "web/node_modules/a/index.js", "config/user-secrets.json", "package-lock.json", "dist/main.js", "docs/x.md"]) assert.ok(!indexable(no), no);
});

test("files: a git repo lists tracked and untracked files but not ignored ones", () => {
  const root = mkdtempSync(join(tmpdir(), "files-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), "generated/\n");
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, "generated", "Big.cs"), "class Big {}");
  writeFileSync(join(root, "A.cs"), "class A {}");
  assert.deepEqual(listFiles(root), ["A.cs"]);
});

test("normalizeRoute", () => {
  assert.equal(normalizeRoute("${environment.apiUrl}/api/orders/${id}?x=1"), "api/orders/{}");
  assert.equal(normalizeRoute("https://api.company.com/api/Orders/{id:guid}"), "api/orders/{}");
  assert.equal(normalizeRoute("/users/:userId/items"), "users/{}/items");
});

function repo(root: string, name: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) { const f = join(root, name, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c); }
  return { repo: name, dir: join(root, name) };
}

test("linker: Angular → ASP.NET controller ([controller] token), C# HttpClient → controller, minimal API", () => {
  const root = mkdtempSync(join(tmpdir(), "lnk-"));
  const api = repo(root, "orders", { "C.cs": `[ApiController]\n[Route("api/[controller]")]\npublic class OrdersController : ControllerBase {\n  [HttpGet("{id}")]\n  public IActionResult Get(Guid id) => Ok();\n  [HttpPost]\n  public IActionResult Create() => Ok();\n}` });
  const min = repo(root, "stock", { "Program.cs": `app.MapGet("/api/stock/{sku}", (string sku) => 1);` });
  const web = repo(root, "web", { "s.ts": "get(id){ return this.http.get<Order>(`${env.api}/api/orders/${id}`); }\ncreate(){ return this.http.post('/api/orders', {}); }\nstock(s){ return fetch(`/api/stock/${s}`); }" });
  const svc = repo(root, "billing", { "B.cs": `var o = await _http.GetFromJsonAsync<Order>($"api/orders/{id}");` });
  const links = linkHttp([api, min, web, svc]);
  const pairs = links.map((l) => `${l.fromRepo}->${l.toRepo}:${l.detail.method}`).sort();
  assert.deepEqual(pairs, ["billing->orders:GET", "web->orders:GET", "web->orders:POST", "web->stock:GET"]);
});

test("linker: NuGet and npm packages", () => {
  const root = mkdtempSync(join(tmpdir(), "pkg-"));
  const a = repo(root, "contracts", { "C.csproj": `<Project><PropertyGroup><PackageId>Co.Contracts</PackageId></PropertyGroup></Project>`, "package.json": `{"name":"@co/ui"}` });
  const b = repo(root, "worker", { "W.csproj": `<Project><ItemGroup><PackageReference Include="Co.Contracts" Version="1.0.0" /><PackageReference Include="Serilog" Version="3" /></ItemGroup></Project>` });
  const c = repo(root, "web", { "package.json": `{"name":"@co/web","dependencies":{"@co/ui":"^1","react":"^18"}}` });
  const links = linkPackages([a, b, c]).map((l) => `${l.fromRepo}->${l.toRepo}:${l.detail.package}`).sort();
  assert.deepEqual(links, ["web->contracts:@co/ui", "worker->contracts:co.contracts"]);
});

test("merge: no loss of opposite edges, direction preserved, graphify cross-repo edges are imported", () => {
  const n = (id: string) => ({ id, label: id });
  const e = (source: string, target: string, relation = "calls") => ({ source, target, relation, confidence: "EXTRACTED" });
  const a = { nodes: [n("ping"), n("pong"), n("svc")], edges: [e("ping", "pong"), e("pong", "ping"), e("svc", "ping")] };
  const b = { nodes: [n("client")], edges: [] };
  // this is what the graphify merge-graphs output looks like: opposite edges collapsed + its own cross-repo edge
  const gm = { nodes: [], links: [e("a::pong", "a::ping"), e("b::client", "a::svc"), e("x::q", "a::svc")] };
  const { graph, importedCrossRepo } = mergeRepoGraphs([{ key: "a", graph: a }, { key: "b", graph: b }], gm as never);
  const calls = graph.links.map((l) => `${l.source}>${l.target}`).sort();
  assert.deepEqual(calls, ["a::ping>a::pong", "a::pong>a::ping", "a::svc>a::ping", "b::client>a::svc"]);
  assert.equal(importedCrossRepo, 1);
  assert.equal(graph.directed, true);
  assert.equal(graph.nodes.find((x) => x.id === "b::client")?.repo, "b");
});

test("linker: routes from C# constants (using R = …Routes) + API version in the client base URL", () => {
  const root = mkdtempSync(join(tmpdir(), "cst-"));
  const api = repo(root, "tt-api", {
    "Infrastructure/Routes.cs": `namespace X.Infrastructure { internal class Routes {\n public const string ApiVersion = "v{version:apiVersion}/";\n public const string Id = "{id}";\n public const string Account = "Account";\n} }`,
    "Controllers/AccountController.cs": `using R = X.Infrastructure.Routes;\n[ApiController]\n[Route(R.ApiVersion + R.Account)]\npublic class AccountController : ControllerBase {\n  [HttpGet]\n  public Task<IEnumerable<Account>> GetAccounts() => null;\n  [HttpGet("{id}/projects")]\n  public Task<X> GetProjects(int id) => null;\n  [HttpDelete]\n  [Route(R.Id)]\n  public Task Delete(int id) => null;\n  [HttpGet(Unknown.Const)]\n  public Task Skip() => null;\n}`,
  });
  const web = repo(root, "tt-web", {
    "swagger.json": JSON.stringify({ servers: [{ url: "https://localhost:5001/v1" }], paths: {
      "/Account": { get: { operationId: "GetAccounts" } },
      "/Account/{id}/projects": { get: { operationId: "GetAccountProjects" } },
      "/Account/{id}": { delete: { operationId: "DeleteAccount" } },
    } }, null, 2),
    "src/app/accounts.component.ts": `import { AccountService } from 'src/app/core/api/services';\nexport class A { constructor(private readonly accountService: AccountService) {}\n  load() { return this.accountService.getAccounts(); }\n  remove(id: number) { return this.accountService.deleteAccount({ id }); }\n  other() { return this.list.getAccounts(); }\n  sig() { return this.accounts.deleteAccount(1); }\n}`,
    "src/app/unrelated.ts": `export class U { x() { return this.s.getAccounts(); } }`,
  });
  const all = linkHttp([api, web]);
  const links = all.filter((l) => l.usage === "used").map((l) => `${l.from.split(":")[0]}:${l.detail.method}->${l.to.split("/").pop()}`).sort();
  // only calls on the generated client's service and only in files that import it are linked
  assert.deepEqual(links, [
    "tt-web/src/app/accounts.component.ts:DELETE->AccountController.cs:11",
    "tt-web/src/app/accounts.component.ts:GET->AccountController.cs:6",
  ]);
  // a spec operation without calls — declared-only (L-1), with the declaration site in swagger.json
  assert.deepEqual(all.filter((l) => l.usage === "declared").map((l) => `${l.from.split(":")[0]}->${l.detail.serverRoute}`), ["tt-web/swagger.json->v{version:apiVersion}/Account/{id}/projects"]);
});

test("linker: committed ng-openapi-gen client (static readonly …GetPath)", () => {
  const root = mkdtempSync(join(tmpdir(), "ngo-"));
  const api = repo(root, "res-api", { "AccountController.cs": `[ApiController]\n[Route("api/accounts")]\npublic class AccountController : AppController {\n  [HttpGet("account-projects")]\n  public Task<X> GetAccountProjects() => null;\n  [HttpGet("{id}/account-assignments/{snapshotId}")]\n  public Task<X> Assignments(int id, int snapshotId) => null;\n}` });
  const web = repo(root, "res-web", { "src/app/core/api/services/account.service.ts": `export class AccountService extends BaseService {\n  static readonly ApiAccountsAccountProjectsGetPath = '/api/accounts/account-projects';\n  apiAccountsAccountProjectsGet$Response(params?: {}) {\n    const rb = new RequestBuilder(this.rootUrl, AccountService.ApiAccountsAccountProjectsGetPath, 'get');\n  }\n  static readonly ApiAccountsIdAccountAssignmentsSnapshotIdGetPath = '/api/accounts/{id}/account-assignments/{snapshotId}';\n}` });
  // with no calls in code both operations are declared-only; from = the line declaring the path constant
  const links = linkHttp([api, web]).map((l) => `${l.usage}:${l.from}:${l.detail.method}->${l.to}`).sort();
  assert.deepEqual(links, [
    "declared:res-web/src/app/core/api/services/account.service.ts:2:GET->res-api/AccountController.cs:5",
    "declared:res-web/src/app/core/api/services/account.service.ts:6:GET->res-api/AccountController.cs:7",
  ]);
});

test("linker: F# controllers, URL with a base address in TS, service URLs in appsettings; protection against /x ↔ {id}", () => {
  const root = mkdtempSync(join(tmpdir(), "fs-"));
  const emp = repo(root, "employee", { "Controllers/EmployeeController.fs": `namespace X\n[<ApiController>]\n[<Route("[controller]")>]\ntype EmployeeController (ctx: Ctx) =\n    inherit ControllerBase()\n    [<HttpGet>]\n    [<AuthorizeSchemes([| Schemes.Google |])>]\n    [<Route("/employee")>]\n    member __.Get() = 1\n    [<HttpGet("brief")>]\n    member __.GetBrief() = 2\n` });
  const idOnly = repo(root, "other", { "C.cs": `public class XController : ControllerBase {\n  [HttpGet("{id}")]\n  public IActionResult Get(int id) => Ok();\n}` });
  const vac = repo(root, "vac-web", { "src/Chart.tsx": "const { data } = useFetch(`${environment.apiEmployeeBaseUrl}/employee/brief`);" });
  const sb = repo(root, "sb-api", { "Http.cs": `var r = await client.GetAsync("/employee");`, "appsettings.json": `{ "Employee": { "EmployeeServiceUrl": "https://api.employee.x.co/employee", "Authority": "https://login.x.co/employee" } }` });
  const all = linkHttp([emp, idOnly, vac, sb]);
  const links = all.filter((l) => l.kind === "http_calls").map((l) => `${l.fromRepo}->${l.toRepo}:${String(l.detail.serverRoute)}`).sort();
  assert.deepEqual(links, ["sb-api->employee:/employee", "sb-api->employee:/employee", "vac-web->employee:Employee/brief"]);
  // Authority is not an API call but an external identity service (L-3c)
  assert.deepEqual(all.filter((l) => l.kind === "depends_on_external").map((l) => `${l.fromRepo}->${l.toRepo}:${l.detail.category}`), ["sb-api->external::login.x.co:identity"]);
});

test("linker: ng-openapi-gen output folder from config (out/person-place) + best route match", () => {
  const root = mkdtempSync(join(tmpdir(), "sbw-"));
  const api = repo(root, "sb-api", { "EmployeeController.cs": `[ApiController]\n[Route("api/[controller]")]\npublic class EmployeeController : ControllerBase {\n  [HttpGet("{id}")]\n  public IActionResult Get(int id) => Ok();\n  [HttpGet("Skills")]\n  public IActionResult Skills() => Ok();\n}` });
  const web = repo(root, "sb-web", {
    "ng-openapi-gen.json": `{ "input": "swagger.json", "output": "out/person-place" }`,
    "swagger.json": JSON.stringify({ paths: { "/api/Employee/Skills": { get: { operationId: "GetSkills" } } } }),
    "src/app/x.component.ts": `import { EmployeeService } from 'out/person-place/services';\nexport class X { load() { return this.employeeService.getSkills(); } }`,
  });
  const links = linkHttp([api, web]).map((l) => `${l.fromRepo}:${l.to.split(":")[1]}:${l.detail.candidates}`);
  assert.deepEqual(links, ["sb-web:7:1"]);
});
