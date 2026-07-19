/**
 * Unit tests for graph search ranking (retired-node filter).
 */
import assert from "node:assert/strict";
import { findRelatedNodes, rankNodes } from "../../../dist/foundations/f-graph-search/search.js";
import { GRAPH_VERSION } from "../../../dist/foundations/f-domain-model/types.js";

const graph = {
  version: GRAPH_VERSION,
  nodes: [
    {
      id: "wf-query-graph",
      type: "Workflow",
      title: "Orient on the plan",
      description: "Read orientation tools",
      state: "in-review",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "wf-query-graph-v2",
      type: "Workflow",
      title: "Query graph",
      description: "Read orientation tools",
      state: "deprecated",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "bug-old",
      type: "Bug",
      title: "Old bug",
      description: "query graph bug",
      state: "resolved",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  edges: [],
};

const ranked = rankNodes(graph.nodes, "query graph");
assert.equal(ranked.some((m) => m.id === "wf-query-graph-v2"), false, "deprecated excluded from rank");
assert.equal(ranked.some((m) => m.id === "bug-old"), false, "closed bug excluded from rank");
assert.ok(ranked.some((m) => m.id === "wf-query-graph"), "live workflow ranked");

const found = findRelatedNodes(graph, { query: "query graph orient" });
assert.equal(found.focus, "wf-query-graph");
assert.equal(found.matches.some((m) => m.state === "deprecated"), false);

// Forced focus still works for deprecated ids (explicit node_id)
const forced = findRelatedNodes(graph, { node_id: "wf-query-graph-v2" });
assert.equal(forced.focus, "wf-query-graph-v2");

console.log("ok   search excludes deprecated/closed from ranking");
console.log("SEARCH UNIT TESTS PASSED");
