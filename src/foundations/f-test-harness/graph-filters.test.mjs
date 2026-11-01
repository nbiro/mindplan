/**
 * get_mindplan_graph filters and projection: state, type, and change alone and together, fields
 * (id always present, unknown names rejected), edges (true, false, or edge types; unknown types
 * rejected), paging over a filtered set, and no parameters returning the unfiltered output. Run via
 * npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
process.env.MINDPLAN_ORIENT_GATE ??= "off";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-graph-filters-"));
console.log("Graph-filters sandbox:", root);
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "graph-filters-test", version: "0.1.0" });
await client.connect(transport);

async function raw(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return { error: Boolean(res.isError), text: res.content?.[0]?.text ?? "" };
}
async function call(tool, args) {
  const res = await raw(tool, args);
  if (res.error) throw new Error(`${tool}: ${res.text}`);
  return JSON.parse(res.text || "{}");
}
const ids = (page) => page.nodes.map((n) => n.id).join(",");

try {
  await call("create_node", { id: "j-shop", type: "Capability", title: "Shop", description: "Visitors buy things." });
  for (const [id, change] of [["f-db", "c-core"], ["f-pay", "c-pay"], ["f-ui", undefined]]) {
    await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra", ...(change ? { change } : {}) });
  }
  for (const [id, change] of [["i-buy", "c-pay"], ["i-browse", "c-core"], ["i-refund", "c-pay"]]) {
    await call("create_node", { id, type: "Interaction", title: id, description: `Visitor does ${id}.`, change });
    await call("link_nodes", { source_id: id, target_id: "j-shop", edge_type: "belongs_to" });
    await call("link_nodes", { source_id: id, target_id: "f-db", edge_type: "depends_on" });
  }
  await call("link_nodes", { source_id: "i-buy", target_id: "f-pay", edge_type: "depends_on" });
  await call("link_nodes", { source_id: "f-pay", target_id: "f-db", edge_type: "depends_on" });
  await call("create_node", { id: "bug-double-charge", type: "Bug", title: "Double charge", description: "Pay twice." });
  await call("link_nodes", { source_id: "bug-double-charge", target_id: "i-buy", edge_type: "affects" });
  // f-ui and i-buy move to ready; everything else stays draft (the Bug: open).
  for (const id of ["f-ui", "i-buy"]) {
    const file = path.join(root, "mindplan", id.startsWith("f-") ? "foundations" : "interactions", id, `${id}.mdx`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace(/^_.*?_$/gm, (l) => (l.includes("attachments/") ? l : "Filled.")));
  }
  await call("update_node_status", { node_id: "f-ui", new_status: "ready" });
  await call("update_node_status", { node_id: "i-buy", new_status: "ready" });

  const all = await call("get_mindplan_graph", {});
  check(
    "no parameters returns every node, every edge, and the old shape",
    all.total_nodes === 8 &&
      all.nodes.length === 8 &&
      all.total_edges === all.edges.length &&
      all.next_offset === undefined &&
      all.nodes[0].id === "bug-double-charge" &&
      "created_at" in all.nodes[0],
    JSON.stringify({ total: all.total_nodes, edges: all.total_edges })
  );
  const empty = await call("get_mindplan_graph", { offset: 0, limit: 200 });
  check("default paging arguments equal no parameters", JSON.stringify(empty) === JSON.stringify(all));

  const ready = await call("get_mindplan_graph", { state: "ready" });
  check("state alone matches the state field", ids(ready) === "f-ui,i-buy" && ready.total_nodes === 2, ids(ready));
  const states = await call("get_mindplan_graph", { state: ["ready", "open"] });
  check("an array of states combines with OR", ids(states) === "bug-double-charge,f-ui,i-buy", ids(states));
  const foundations = await call("get_mindplan_graph", { type: "Foundation" });
  check("type alone", ids(foundations) === "f-db,f-pay,f-ui", ids(foundations));
  const types = await call("get_mindplan_graph", { type: ["Capability", "Bug"] });
  check("an array of types combines with OR", ids(types) === "bug-double-charge,j-shop", ids(types));
  const pay = await call("get_mindplan_graph", { change: "c-pay" });
  check("change alone", ids(pay) === "f-pay,i-buy,i-refund", ids(pay));
  const combined = await call("get_mindplan_graph", { state: "draft", type: "Interaction", change: "c-pay" });
  check("state + type + change combine with AND", ids(combined) === "i-refund", ids(combined));
  check(
    "edges keep the source-in-page rule and total_edges counts the filtered set's edges",
    pay.edges.every((e) => ["f-pay", "i-buy", "i-refund"].includes(e.source)) && pay.total_edges === pay.edges.length && pay.total_edges === 6,
    JSON.stringify(pay.edges)
  );

  const projected = await call("get_mindplan_graph", { type: "Interaction", fields: ["type", "title", "change"] });
  check(
    "fields returns only the listed fields plus id",
    projected.nodes.every((n) => Object.keys(n).sort().join(",") === "change,id,title,type"),
    JSON.stringify(projected.nodes)
  );
  check("projection keeps the edges", projected.edges.length === all.edges.filter((e) => e.source.startsWith("i-")).length);
  const unknown = await raw("get_mindplan_graph", { fields: ["id", "colour"] });
  check(
    "an unknown field is Blocked naming the valid fields",
    unknown.error && unknown.text.includes('unknown field "colour"') && unknown.text.includes("Valid fields: id, type, title"),
    unknown.text
  );
  const badState = await raw("get_mindplan_graph", { state: "planned" });
  check("an unknown state is rejected by the schema", badState.error, badState.text);

  const first = await call("get_mindplan_graph", { state: "draft", limit: 2 });
  const second = await call("get_mindplan_graph", { state: "draft", limit: 2, offset: first.next_offset });
  const draftIds = ["f-db", "f-pay", "i-browse", "i-refund", "j-shop"];
  check(
    "paging walks the filtered set: totals, next_offset, and pages",
    first.total_nodes === 5 && first.next_offset === 2 && ids(first) === "f-db,f-pay" && ids(second) === "i-browse,i-refund" && second.next_offset === 4,
    JSON.stringify({ first: ids(first), second: ids(second), next: first.next_offset, total: first.total_nodes })
  );
  const third = await call("get_mindplan_graph", { state: "draft", limit: 2, offset: second.next_offset });
  check(
    "every filtered node comes back exactly once and the last page has no next_offset",
    [first, second, third].flatMap((p) => p.nodes.map((n) => n.id)).join(",") === draftIds.join(",") && third.next_offset === undefined,
    ids(third)
  );

  // --- edges: true (default) | false | edge types ---
  const edgesTrue = await call("get_mindplan_graph", { edges: true });
  check("edges omitted and edges: true return the same reply", JSON.stringify(edgesTrue) === JSON.stringify(all));
  const noEdges = await call("get_mindplan_graph", { edges: false });
  check(
    "edges: false returns the same nodes with no edges and no total_edges",
    !("edges" in noEdges) && !("total_edges" in noEdges) && JSON.stringify(noEdges.nodes) === JSON.stringify(all.nodes) && noEdges.total_nodes === 8,
    Object.keys(noEdges).join(",")
  );
  const dependsOn = await call("get_mindplan_graph", { edges: ["depends_on"] });
  const allDependsOn = all.edges.filter((e) => e.type === "depends_on");
  check(
    'edges: ["depends_on"] keeps only depends_on edges and counts them',
    dependsOn.edges.length === allDependsOn.length && dependsOn.edges.length > 0 && dependsOn.edges.every((e) => e.type === "depends_on") && dependsOn.total_edges === allDependsOn.length && ids(dependsOn) === ids(all),
    JSON.stringify(dependsOn.edges)
  );
  const twoTypes = await call("get_mindplan_graph", { edges: ["depends_on", "affects"] });
  check(
    "edge types combine with OR",
    twoTypes.edges.length === all.edges.filter((e) => e.type === "depends_on" || e.type === "affects").length && twoTypes.edges.some((e) => e.type === "affects"),
    JSON.stringify(twoTypes.edges)
  );
  const badEdge = await raw("get_mindplan_graph", { edges: ["depends_on", "calls"] });
  check(
    "an unknown edge type is Blocked naming the valid ones",
    badEdge.error && badEdge.text.includes('unknown edge type "calls"') && badEdge.text.includes("Valid edge types: depends_on, belongs_to, exposes, leads_to, affects, mounts"),
    badEdge.text
  );
  const planned = await call("get_mindplan_graph", { state: ["draft", "ready"], fields: ["id", "type", "title", "change"], edges: false });
  const plannedWithEdges = await call("get_mindplan_graph", { state: ["draft", "ready"], fields: ["id", "type", "title", "change"] });
  check(
    "edges: false with state and fields keeps the node rows and paging",
    !("edges" in planned) && JSON.stringify(planned.nodes) === JSON.stringify(plannedWithEdges.nodes) && planned.total_nodes === 7,
    JSON.stringify(planned)
  );
  const payDeps = await call("get_mindplan_graph", { change: "c-pay", type: "Interaction", edges: ["depends_on"], fields: ["state"] });
  check(
    "edge types with change, type, and fields: only those types from the filtered set",
    ids(payDeps) === "i-buy,i-refund" &&
      payDeps.nodes.every((n) => Object.keys(n).sort().join(",") === "id,state") &&
      payDeps.edges.every((e) => e.type === "depends_on" && ["i-buy", "i-refund"].includes(e.source)) &&
      payDeps.edges.length === 3 &&
      payDeps.total_edges === 3,
    JSON.stringify(payDeps)
  );
  const pagedDeps = await call("get_mindplan_graph", { edges: ["depends_on"], limit: 3 });
  check(
    "edge types with paging: edges from the page, total_edges over the whole set",
    pagedDeps.edges.every((e) => pagedDeps.nodes.some((n) => n.id === e.source)) && pagedDeps.total_edges === allDependsOn.length && pagedDeps.next_offset === 3,
    JSON.stringify(pagedDeps)
  );
} finally {
  await client.close();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll graph-filters checks passed.");
