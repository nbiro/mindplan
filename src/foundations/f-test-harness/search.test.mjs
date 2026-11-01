/**
 * Unit tests for graph search ranking (retired-node filter) + Interaction/Interface neighborhoods.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import assert from "node:assert/strict";
import {
  expandNeighborhood,
  findRelatedNodes,
  rankNodes,
} from "../../../dist/foundations/f-graph-search/search.js";
import { GRAPH_VERSION } from "../../../dist/foundations/f-domain-model/types.js";
import { resolveNodeRules, rulesAudience, rulesImpact } from "../../../dist/foundations/f-graph-search/rules.js";
import {
  countCheckboxesInText,
  joinNodeRules,
  splitNodeRules,
} from "../../../dist/foundations/f-territory-store/store.js";

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
      type: "Capability",
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
assert.ok(nbr.nodes.some((n) => n.id === "j-sdlc"), "belongs_to Capability included");
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

// --- node rules: resolution, audience, and the Rules section helpers ---
{
  const mk = (id, type, extra = {}) => ({
    id,
    type,
    title: id,
    description: id,
    state: "stable",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
  const g = {
    version: GRAPH_VERSION,
    edges: [],
    nodes: [
      mk("j-a", "Capability", { rules: "J" }),
      mk("f-low", "Foundation", { rules: "LOW" }),
      mk("f-mid", "Foundation", { rules: "MID", depends_on: ["f-low"] }),
      mk("f-dead", "Foundation", { rules: "DEAD", state: "deprecated" }),
      mk("i-x", "Interaction", {
        rules: "X",
        belongs_to: ["j-a"],
        depends_on: ["f-mid", "f-dead"],
        leads_to: ["i-y"],
      }),
      mk("i-y", "Interaction", { rules: "Y", belongs_to: ["j-a"] }),
      mk("if-p", "Interface", { rules: "P", depends_on: ["f-mid"], exposes: ["i-x"] }),
      mk("b-1", "Bug", { state: "open", affects: ["i-x", "f-mid"] }),
      mk("b-done", "Bug", { state: "resolved", affects: ["i-x"] }),
      mk("b-wont", "Bug", { state: "wontfix", rules: "WONT", affects: ["i-x"] }),
    ],
  };
  const impact = rulesImpact(g, g.nodes.find((n) => n.id === "f-low"));
  assert.equal(impact.has_rules, true);
  assert.deepEqual(impact.inherited_by.map((e) => e.id), ["f-mid", "b-1", "i-x", "if-p"]);
  const label = (id) => resolveNodeRules(g, id).map((e) => `${e.node_id}:${e.via}:${e.distance}`);

  assert.deepEqual(label("i-x"), ["i-x:self:0", "j-a:belongs_to:1", "f-mid:depends_on:1", "f-low:depends_on:2"]);
  assert.deepEqual(label("i-y"), ["i-y:self:0", "j-a:belongs_to:1"], "leads_to / siblings are not inherited");
  assert.deepEqual(label("j-a"), ["j-a:self:0"], "nothing flows down to a Capability");
  assert.deepEqual(label("f-mid"), ["f-mid:self:0", "f-low:depends_on:1"], "nothing flows up to a Foundation");
  assert.deepEqual(label("if-p"), ["if-p:self:0", "f-mid:depends_on:1", "f-low:depends_on:2"], "exposes is not inherited");
  assert.equal(label("i-x").some((e) => e.startsWith("f-dead")), false, "retired nodes are omitted");
  assert.deepEqual(
    label("b-1"),
    ["f-mid:affects:1", "i-x:affects:1", "f-low:affects:2", "j-a:affects:2"],
    "Bug takes the resolution of each affected node; a node reached twice keeps its smallest distance"
  );
  assert.deepEqual(resolveNodeRules(g, "nope"), []);
  assert.equal(
    rulesAudience(g, "i-x").some((e) => e.id === "b-done" || e.id === "b-wont"),
    false,
    "closed Bugs are not in the rules audience"
  );
  assert.equal(
    rulesAudience(g, "f-mid").some((e) => e.id === "b-done"),
    false,
    "a resolved Bug does not appear under any Foundation either"
  );
  assert.deepEqual(rulesAudience(g, "b-wont"), [], "a closed Bug's own rules reach nobody");

  assert.deepEqual(
    rulesAudience(g, "f-low").map((e) => e.id),
    ["f-mid", "b-1", "i-x", "if-p"]
  );
  for (const target of g.nodes) {
    const expected = g.nodes
      .filter((n) => n.id !== target.id && !["resolved", "wontfix", "cancelled", "deprecated"].includes(n.state) && target.rules && resolveNodeRules(g, n.id).some((e) => e.node_id === target.id))
      .map((n) => n.id)
      .sort();
    assert.deepEqual(rulesAudience(g, target.id).map((e) => e.id).sort(), expected, `audience of ${target.id} inverts resolution`);
  }
  assert.deepEqual(rulesAudience(g, "b-1"), [], "a node without rules reaches nobody");

  const body = "# T\n\n## Purpose\n\nBody.\n\n## Rules\n\n- One\n- [ ] two\n\n## Attachments\n\n_None._\n";
  const split = splitNodeRules(body);
  assert.equal(split.rules, "- One\n- [ ] two");
  assert.equal(split.body.includes("## Rules"), false);
  assert.equal(countCheckboxesInText(body).unchecked, 0, "Rules checkboxes are not Atomic Ops");
  const rejoined = joinNodeRules(split.body, split.rules);
  assert.equal(splitNodeRules(rejoined).rules, "- One\n- [ ] two");
  assert.ok(rejoined.indexOf("## Rules") < rejoined.indexOf("## Attachments"), "Rules sits before Attachments");
  assert.equal(splitNodeRules(joinNodeRules(split.body, "")).rules, "", "empty rules adds no section");
  const noAtt = joinNodeRules("# T\n\nBody.\n", "- r");
  assert.ok(noAtt.endsWith("## Rules\n\n- r\n"), "appended at the end without Attachments");
  assert.equal(joinNodeRules(rejoined, ""), rejoined);
  const crlfBody = joinNodeRules("# T\r\n\r\nBody.\r\n", "- r");
  assert.ok(crlfBody.includes("\r\n## Rules\r\n\r\n- r\r\n") && !/[^\r]\n/.test(crlfBody), "CRLF bodies stay CRLF");
  assert.equal(splitNodeRules(crlfBody).rules, "- r");
  console.log("ok   node rules inheritance, audience inverse, and Rules section helpers");
}
console.log("SEARCH UNIT TESTS PASSED");
