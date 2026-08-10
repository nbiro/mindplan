/**
 * Unit tests for graph search ranking (retired-node filter) + Interaction/Interface neighborhoods.
 */
import assert from "node:assert/strict";
import {
  expandNeighborhood,
  findRelatedNodes,
  rankNodes,
} from "../../../dist/foundations/f-graph-search/search.js";
import { GRAPH_VERSION } from "../../../dist/foundations/f-domain-model/types.js";

const graph = {
  version: GRAPH_VERSION,
  nodes: [
    {
      id: "i-query-graph",
      type: "Interaction",
      title: "Orient on the plan",
      description: "Read orientation tools",
      state: "in-review",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      belongs_to: ["j-sdlc"],
      leads_to: ["i-steer"],
    },
    {
      id: "i-steer",
      type: "Interaction",
      title: "Steer the plan",
      description: "Mutate graph tools",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      shipped_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "if-mcp-tools",
      type: "Interface",
      title: "MCP tools",
      description: "MCP tool Interface exposing orient",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      shipped_at: "2026-01-01T00:00:00.000Z",
      exposes: ["i-query-graph"],
    },
    {
      id: "j-sdlc",
      type: "Journey",
      title: "Plan software",
      description: "Territory SDLC",
      state: "stable",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "i-query-graph-v2",
      type: "Interaction",
      title: "Query graph",
      description: "Read orientation tools",
      state: "deprecated",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "i-query-cancelled",
      type: "Interaction",
      title: "Query cancelled",
      description: "query graph abandoned",
      state: "cancelled",
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
  edges: [
    { source: "i-query-graph", target: "j-sdlc", type: "belongs_to" },
    { source: "i-query-graph", target: "i-steer", type: "leads_to" },
    { source: "if-mcp-tools", target: "i-query-graph", type: "exposes" },
  ],
};

const ranked = rankNodes(graph.nodes, "query graph");
assert.equal(ranked.some((m) => m.id === "i-query-graph-v2"), false, "deprecated excluded from rank");
assert.equal(ranked.some((m) => m.id === "i-query-cancelled"), false, "cancelled excluded from rank");
assert.equal(ranked.some((m) => m.id === "bug-old"), false, "closed bug excluded from rank");
assert.ok(ranked.some((m) => m.id === "i-query-graph"), "live interaction ranked");

const ifaceRanked = rankNodes(graph.nodes, "MCP tools Interface");
assert.ok(ifaceRanked.some((m) => m.id === "if-mcp-tools"), "Interface ranked by title");

const found = findRelatedNodes(graph, { query: "query graph orient" });
assert.equal(found.focus, "i-query-graph");
assert.equal(found.matches.some((m) => m.state === "deprecated"), false);
assert.equal(found.matches.some((m) => m.state === "cancelled"), false);

// Forced focus still works for deprecated ids (explicit node_id)
const forced = findRelatedNodes(graph, { node_id: "i-query-graph-v2" });
assert.equal(forced.focus, "i-query-graph-v2");

const nbr = expandNeighborhood(graph, "i-query-graph");
assert.ok(nbr.nodes.some((n) => n.id === "if-mcp-tools"), "exposes neighbor Interface included");
assert.ok(nbr.nodes.some((n) => n.id === "i-steer"), "leads_to neighbor Interaction included");
assert.ok(nbr.nodes.some((n) => n.id === "j-sdlc"), "belongs_to Journey included");
assert.ok(
  nbr.edges.some((e) => e.type === "exposes" && e.source === "if-mcp-tools"),
  "exposes edge in neighborhood"
);
assert.ok(
  nbr.edges.some((e) => e.type === "leads_to" && e.target === "i-steer"),
  "leads_to edge in neighborhood"
);

const ifaceFocus = findRelatedNodes(graph, { query: "MCP tools" });
assert.equal(ifaceFocus.focus, "if-mcp-tools");
assert.ok(
  ifaceFocus.nodes.some((n) => n.id === "i-query-graph"),
  "Interface focus neighborhood includes exposed Interaction"
);

console.log("ok   search excludes deprecated/cancelled/closed from ranking");
console.log("ok   Interface ranking + exposes/leads_to neighborhoods");
console.log("SEARCH UNIT TESTS PASSED");
