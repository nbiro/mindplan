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
} from "../dist/view.js";
import { GRAPH_VERSION } from "../dist/types.js";

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
      id: "wf-checkout",
      type: "Workflow",
      title: "Checkout",
      description: "Pay",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      belongs_to: ["j-ordering", "j-admin"],
      depends_on: ["f-db"],
    },
    {
      id: "wf-orphan",
      type: "Workflow",
      title: "Orphan",
      description: "No journey",
      state: "draft",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
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
      affects: ["wf-checkout"],
    },
    {
      id: "bug-closed",
      type: "Bug",
      title: "Closed",
      description: "Done",
      state: "resolved",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      affects: ["wf-checkout"],
    },
  ],
  edges: [
    { source: "wf-checkout", target: "j-ordering", type: "belongs_to" },
    { source: "wf-checkout", target: "j-admin", type: "belongs_to" },
    { source: "wf-checkout", target: "f-db", type: "depends_on" },
    { source: "wf-orphan", target: "f-db", type: "depends_on" },
    { source: "bug-race", target: "wf-checkout", type: "affects" },
    { source: "bug-closed", target: "wf-checkout", type: "affects" },
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
  assert.equal(ids.has("bug-closed"), false);
  assert.equal(ids.has("bug-race"), true);
  assert.equal(ids.has("f-db"), true);
});

check("include_retired keeps deprecated and closed bugs", () => {
  const view = prepareViewGraph(baseGraph, { include_retired: true });
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.equal(ids.has("f-old"), true);
  assert.equal(ids.has("bug-closed"), true);
});

check("focus slices to 1-hop neighborhood", () => {
  const view = prepareViewGraph(baseGraph, { focus: "bug-race" });
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.equal(ids.has("bug-race"), true);
  assert.equal(ids.has("wf-checkout"), true);
  assert.equal(ids.has("f-db"), false);
  assert.equal(ids.has("wf-orphan"), false);
});

check("mermaid clusters journeys and foundations", () => {
  const out = graphToMermaid(baseGraph);
  assert.match(out, /^flowchart TB\n/);
  assert.match(out, /subgraph foundations\["Foundations"\]/);
  assert.match(out, /subgraph journey_j_ordering\[/);
  assert.match(out, /subgraph journey_j_admin\[/);
  assert.match(out, /subgraph unassigned\["Unassigned workflows"\]/);
  assert.match(out, /wf_orphan\["wf-orphan · Orphan · draft"\]/);
});

check("mermaid duplicates multi-belongs_to workflows", () => {
  const out = graphToMermaid(baseGraph);
  assert.match(out, /wf_checkout__in__j_ordering/);
  assert.match(out, /wf_checkout__in__j_admin/);
});

check("mermaid omits belongs_to edges and styles affects", () => {
  const out = graphToMermaid(baseGraph);
  assert.equal(out.includes("belongs_to"), false);
  assert.match(out, /bug_race -.-> wf_checkout__/);
  assert.equal(out.includes("supersedes"), false);
  assert.match(out, /wf_checkout__in__j_ordering --> f_db/);
});

check("dot emits digraph with clusters", () => {
  const out = graphToDot(baseGraph);
  assert.match(out, /^digraph MindPlan \{/);
  assert.match(out, /subgraph cluster_foundations/);
  assert.match(out, /subgraph cluster_j_ordering/);
  assert.match(out, /style=dashed/);
  assert.equal(out.includes("supersedes"), false);
});

check("exportMindPlanView returns diagram payload", () => {
  const res = exportMindPlanView(baseGraph, { format: "mermaid", focus: "wf-checkout" });
  assert.equal(res.format, "mermaid");
  assert.equal(res.focus, "wf-checkout");
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
