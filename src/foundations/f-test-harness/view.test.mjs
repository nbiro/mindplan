/**
 * Unit tests for graph view projections (Mermaid / DOT).
 * Run via: npm test (after build).
 */
import assert from "node:assert/strict";
import {
  exportMindPlanView,
  graphToDot,
  graphToMermaid,
  prepareViewGraph,
} from "../../../dist/foundations/f-view-projection/view.js";
import { GRAPH_VERSION } from "../../../dist/foundations/f-domain-model/types.js";

const baseGraph = {
  version: GRAPH_VERSION,
  nodes: [
    {
      id: "j-ordering",
      type: "Journey",
      title: "Ordering",
      description: "Orders",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "j-admin",
      type: "Journey",
      title: "Admin",
      description: "Admin",
      state: "incubation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "f-db",
      type: "Foundation",
      title: "Database",
      description: "DB",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "f-old",
      type: "Foundation",
      title: "Legacy",
      description: "Retired",
      state: "deprecated",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "i-cancelled",
      type: "Interaction",
      title: "Cancelled",
      description: "Abandoned",
      state: "cancelled",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "i-checkout",
      type: "Interaction",
      title: "Checkout",
      description: "Pay",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      belongs_to: ["j-ordering", "j-admin"],
      depends_on: ["f-db"],
      leads_to: ["i-tips"],
    },
    {
      id: "i-tips",
      type: "Interaction",
      title: "Tips",
      description: "Tip",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      belongs_to: ["j-ordering"],
      depends_on: ["f-db"],
    },
    {
      id: "i-orphan",
      type: "Interaction",
      title: "Orphan",
      description: "No journey",
      state: "draft",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      depends_on: ["f-db"],
    },
    {
      id: "if-web",
      type: "Interface",
      title: "Web checkout",
      description: "Page",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      exposes: ["i-checkout"],
      depends_on: ["f-db"],
    },
    {
      id: "bug-race",
      type: "Bug",
      title: "Race",
      description: "Race",
      state: "open",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      affects: ["i-checkout"],
    },
    {
      id: "bug-closed",
      type: "Bug",
      title: "Closed",
      description: "Done",
      state: "resolved",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      affects: ["i-checkout"],
    },
  ],
  edges: [
    { source: "i-checkout", target: "j-ordering", type: "belongs_to" },
    { source: "i-checkout", target: "j-admin", type: "belongs_to" },
    { source: "i-checkout", target: "f-db", type: "depends_on" },
    { source: "i-checkout", target: "i-tips", type: "leads_to" },
    { source: "i-tips", target: "j-ordering", type: "belongs_to" },
    { source: "i-tips", target: "f-db", type: "depends_on" },
    { source: "i-orphan", target: "f-db", type: "depends_on" },
    { source: "if-web", target: "i-checkout", type: "exposes" },
    { source: "if-web", target: "f-db", type: "depends_on" },
    { source: "bug-race", target: "i-checkout", type: "affects" },
    { source: "bug-closed", target: "i-checkout", type: "affects" },
  ],
};

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${label}: ${err instanceof Error ? err.message : err}`);
  }
}

check("filters deprecated and closed bugs by default", () => {
  const view = prepareViewGraph(baseGraph);
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.equal(ids.has("f-old"), false);
  assert.equal(ids.has("i-cancelled"), false);
  assert.equal(ids.has("bug-closed"), false);
  assert.equal(ids.has("bug-race"), true);
  assert.equal(ids.has("f-db"), true);
  assert.equal(ids.has("if-web"), true);
});

check("include_retired keeps deprecated and closed bugs", () => {
  const view = prepareViewGraph(baseGraph, { include_retired: true });
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.equal(ids.has("f-old"), true);
  assert.equal(ids.has("i-cancelled"), true);
  assert.equal(ids.has("bug-closed"), true);
});

check("focus slices to 1-hop neighborhood", () => {
  const view = prepareViewGraph(baseGraph, { focus: "bug-race" });
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.equal(ids.has("bug-race"), true);
  assert.equal(ids.has("i-checkout"), true);
  assert.equal(ids.has("f-db"), false);
  assert.equal(ids.has("i-orphan"), false);
});

check("mermaid clusters journeys, foundations, and interfaces", () => {
  const out = graphToMermaid(baseGraph);
  assert.match(out, /^flowchart TB\n/);
  assert.match(out, /subgraph foundations\["Foundations"\]/);
  assert.match(out, /subgraph interfaces\["Interfaces"\]/);
  assert.match(out, /subgraph journey_j_ordering\[/);
  assert.match(out, /subgraph journey_j_admin\[/);
  assert.match(out, /subgraph unassigned\["Unassigned interactions"\]/);
  assert.match(out, /i_orphan\["i-orphan · Orphan · draft"\]/);
});

check("mermaid duplicates multi-belongs_to interactions", () => {
  const out = graphToMermaid(baseGraph);
  assert.match(out, /i_checkout__in__j_ordering/);
  assert.match(out, /i_checkout__in__j_admin/);
});

check("mermaid omits belongs_to and styles exposes/leads_to/affects", () => {
  const out = graphToMermaid(baseGraph);
  assert.equal(out.includes("belongs_to"), false);
  assert.match(out, /bug_race -.-> i_checkout__/);
  assert.match(out, /if_web -->|exposes| i_checkout__/);
  assert.match(out, /i_checkout__in__j_ordering -.->|leads_to| /);
  assert.equal(out.includes("supersedes"), false);
  assert.match(out, /i_checkout__in__j_ordering --> f_db/);
});

check("dot emits digraph with clusters and new edges", () => {
  const out = graphToDot(baseGraph);
  assert.match(out, /^digraph MindPlan \{/);
  assert.match(out, /subgraph cluster_foundations/);
  assert.match(out, /subgraph cluster_interfaces/);
  assert.match(out, /subgraph cluster_j_ordering/);
  assert.match(out, /label="exposes"/);
  assert.match(out, /label="leads_to"/);
  assert.match(out, /style=dashed/);
  assert.equal(out.includes("supersedes"), false);
});

check("exportMindPlanView returns diagram payload", () => {
  const res = exportMindPlanView(baseGraph, { format: "mermaid", focus: "i-checkout" });
  assert.equal(res.format, "mermaid");
  assert.equal(res.focus, "i-checkout");
  assert.equal(res.include_retired, false);
  assert.ok(res.node_count >= 2);
  assert.match(res.diagram, /flowchart TB/);
});

check("exportMindPlanView dot format", () => {
  const res = exportMindPlanView(baseGraph, { format: "dot" });
  assert.equal(res.format, "dot");
  assert.match(res.diagram, /digraph MindPlan/);
});

console.log(failures === 0 ? "\nVIEW UNIT TESTS PASSED" : `\n${failures} VIEW UNIT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
