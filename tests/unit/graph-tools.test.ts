// Graph tools in repo-context (a graphify.serve 0.9.66 port). Full parity with Graphify on a real graph —
// tests/regression/graph-parity.*; here — behavior on a small graph without Python.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeGraph, getNeighbors, getNode, queryGraph, queryTerms, shortestPath } from "../../src/server/graph-tools.js";

const n = (id: string, label: string, file: string, line = 1) => ({ id, label, file_type: "code", source_file: file, source_location: `L${line}`, repo: id.split("::")[0] });
const e = (source: string, target: string, relation: string, extra: object = {}) => ({ source, target, relation, confidence: "EXTRACTED", source_file: "x", source_location: "L5", ...extra });
const g = CodeGraph.fromJson({
  nodes: [
    n("rb::baseline", "BaselineService", "rb/BaselineService.cs", 12), n("rb::baseline_get", ".GetHolidays()", "rb/BaselineService.cs", 69),
    n("tt::op", "OperationalController", "tt/OperationalController.cs", 16), n("tt::op_hy", ".GetHolidaysByYear()", "tt/OperationalController.cs", 40),
    n("tt::svc", "HolidayService", "tt/HolidayService.cs", 5), n("tt::svc_get", ".Get()", "tt/HolidayService.cs", 9),
    n("a::emp", "EmployeeController", "a/EmployeeController.cs", 3), n("b::emp", "EmployeeController", "b/EmployeeController.cs", 3),
  ],
  links: [
    e("rb::baseline", "rb::baseline_get", "method"), e("tt::op", "tt::op_hy", "method"), e("tt::svc", "tt::svc_get", "method"),
    e("rb::baseline_get", "tt::op_hy", "http_calls", { confidence: "INFERRED" }),
    e("tt::op_hy", "tt::svc_get", "calls", { context: "call" }),
    e("tt::op_hy", "tt::svc", "references", { context: "field" }),
    e("tt::op_hy", "tt::svc_get", "calls", { context: "call", source_location: "L44" }),   // parallel edge → collapses (DiGraph)
    e("ghost::x", "tt::svc", "imports"),                                                   // unknown end → implicit node
  ],
});

test("graph: DiGraph semantics — parallel edges collapse, unknown ends become nodes", () => {
  assert.equal(g.nodes.size, 9);
  assert.equal(g.edgeCount, 7);
  assert.equal(g.succ.get("tt::op_hy")!.get("tt::svc_get")!.source_location, "L44");
});

test("queryTerms: stop words (EN/DE…) are dropped; if only stop words remain — they are kept", () => {
  assert.deepEqual(queryTerms("who calls GetHolidaysByYear?"), ["calls", "getholidaysbyyear"]);
  assert.deepEqual(queryTerms("how does it work"), ["how", "does", "work"]);
});

test("query_graph: exact name — seed first; traversal sees a call from another repo; context_filter narrows edges", () => {
  const out = queryGraph(g, { question: "GetHolidaysByYear" });
  assert.match(out, /Start: \['\.GetHolidaysByYear\(\)'\]/);
  assert.match(out.split("\n\n")[1], /^NODE \.GetHolidaysByYear\(\)/);
  assert.match(out, /EDGE \.GetHolidays\(\) --http_calls \[INFERRED\]--> \.GetHolidaysByYear\(\)/);  // call direction preserved
  const calls = queryGraph(g, { question: "GetHolidaysByYear", context_filter: ["call"] });
  assert.match(calls, /Context: call \(explicit\)/);
  assert.doesNotMatch(calls, /--references/);
  assert.equal(queryGraph(g, { question: "zzzqqq" }), "No matching nodes found.");
});

test("query_graph: budget truncation does not remove the seed node and says so honestly", () => {
  const out = queryGraph(g, { question: "GetHolidaysByYear", token_budget: 20 });
  assert.match(out, /TRUNCATED|Complete answer over budget/);
  assert.match(out, /NODE \.GetHolidaysByYear\(\)/);
});

test("get_node / get_neighbors: direction --> / <--, relation_filter, ambiguity between files and path::symbol", () => {
  assert.match(getNode(g, { label: "BaselineService" }), /Source: rb\/BaselineService\.cs L12/);
  const nb = getNeighbors(g, { label: "GetHolidaysByYear" });
  assert.match(nb, /--> \.Get\(\) \[calls\]/);
  assert.match(nb, /<-- \.GetHolidays\(\) \[http_calls\]/);
  assert.doesNotMatch(getNeighbors(g, { label: "GetHolidaysByYear", relation_filter: "http" }), /\[calls\]/);
  assert.match(getNode(g, { label: "EmployeeController" }), /^Ambiguous: 'employeecontroller' matches 2 nodes/);
  assert.match(getNode(g, { label: "b/EmployeeController.cs::EmployeeController" }), /ID: b::emp/);
  assert.match(getNode(g, { label: "nope" }), /No node matching/);
});

test("shortest_path: default direction, undirected on request, same node — a hint", () => {
  assert.match(shortestPath(g, { source: "GetHolidays", target: "HolidayService" }), /Shortest path \(3 hops\):\n {2}\.GetHolidays\(\) --http_calls \[INFERRED\]--> \.GetHolidaysByYear\(\) --calls \[EXTRACTED\]--> \.Get\(\) <--method \[EXTRACTED\]-- HolidayService|Shortest path \(2 hops\)/);
  assert.match(shortestPath(g, { source: "HolidayService", target: "BaselineService" }), /No directed path/);
  assert.match(shortestPath(g, { source: "HolidayService", target: "BaselineService", undirected: true }), /Shortest path \(\d hops\)/);
  assert.match(shortestPath(g, { source: "BaselineService", target: "BaselineService" }), /both resolved to the same node/);
});
