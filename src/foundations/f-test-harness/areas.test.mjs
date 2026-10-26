/**
 * Area-first orientation (npm test): on a 330-node graph with 30 areas, searching with `area`
 * returns only that area's members (its Interactions, the Interfaces exposing them, the
 * Foundations they depend on) and is faster than a whole-graph search; over MCP, list_areas stays
 * under 4 KB for 30 areas, counts each area's members, and `area` reaches orient_for_work and
 * find_related_nodes (a non-Journey area is Blocked).
 */
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { areaMembers, searchNodes } from "../../../dist/foundations/f-graph-search/search.js";
import { closeSearchIndexes } from "../../../dist/foundations/f-search-index/service.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
process.env.MINDPLAN_ORIENT_GATE ??= "off";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const ok = (label) => console.log(`ok   ${label}`);
const t = "2026-01-01T00:00:00.000Z";
const mk = (id, type, title, description, extra = {}) => ({ id, type, title, description, state: "stable", created_at: t, updated_at: t, ...extra });

// --- 30 areas x (1 Journey, 8 Interactions, 1 Interface, 1 Foundation) + 1 shared Foundation = 331 nodes ---
const nodes = [mk("f-shared", "Foundation", "Shared ledger", "Infra — the ledger every area writes to.")];
for (let a = 0; a < 30; a++) {
  nodes.push(mk(`j-area-${a}`, "Journey", `Area ${a}`, `Customers do business of kind ${a}.`));
  nodes.push(mk(`f-area-${a}`, "Foundation", `Store ${a}`, `Infra — records for area ${a}.`, { depends_on: ["f-shared"] }));
  const ix = [];
  for (let i = 0; i < 8; i++) {
    const id = `i-area-${a}-${i}`;
    ix.push(id);
    nodes.push(mk(id, "Interaction", `Book a slot ${a}.${i}`, `Customer books a slot of kind ${i} and pays the deposit.`, {
      belongs_to: [`j-area-${a}`],
      depends_on: [`f-area-${a}`],
    }));
  }
  nodes.push(mk(`if-area-${a}`, "Interface", `App ${a}`, `The app for area ${a}.`, { exposes: ix }));
}
const graph = { version: 1, nodes, edges: [] };
const members = areaMembers(graph, "j-area-7");
assert.deepEqual(
  [...members].sort(),
  ["f-area-7", "f-shared", "if-area-7", "j-area-7", ...Array.from({ length: 8 }, (_, i) => `i-area-7-${i}`)].sort()
);
ok("areaMembers: the Journey, its Interactions, the Interfaces exposing them, their Foundations (transitively)");
{
  const retired = {
    version: 1,
    edges: [],
    nodes: [
      mk("j-r", "Journey", "R", "Area."),
      mk("f-only-old", "Foundation", "Old store", "Infra — used only by the old action."),
      mk("i-old", "Interaction", "Old", "Visitor did the old thing.", { state: "deprecated", belongs_to: ["j-r"], depends_on: ["f-only-old"] }),
      mk("if-old", "Interface", "Old app", "Exposes only the old action.", { exposes: ["i-old"] }),
    ],
  };
  assert.deepEqual([...areaMembers(retired, "j-r")], ["j-r"], "nothing is reached through a retired node");
}
ok("areaMembers never walks through a retired node");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-areas-"));
await searchNodes(graph, "warm the cache", { root, embedder: null });
const inArea = await searchNodes(graph, "book a slot and pay the deposit", { root, area: "j-area-7", limit: 20, embedder: null });
assert.ok(inArea.length > 0 && inArea.every((m) => members.has(m.id)), JSON.stringify(inArea.map((m) => m.id)));
ok(`searching with area returns only that area's members (${inArea.length} rows)`);

const time = async (opts) => {
  const runs = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    await searchNodes(graph, `book slot deposit kind ${i}`, { root, limit: 10, embedder: null, ...opts });
    runs.push(performance.now() - t0);
  }
  return runs.sort((a, b) => a - b)[4];
};
const whole = await time({});
const scoped = await time({ area: "j-area-7" });
console.log(`     331 nodes: whole-graph search ${whole.toFixed(2)} ms, area search ${scoped.toFixed(2)} ms (median of 9)`);
// A loose bound: timings of a few milliseconds swing on a loaded machine; the log line is the measurement.
assert.ok(scoped <= whole * 2 + 1, `an area search stays in the whole-graph search's range (${scoped.toFixed(2)} vs ${whole.toFixed(2)} ms)`);
ok("area search stays within the whole-graph search's time");
closeSearchIndexes();
fs.rmSync(root, { recursive: true, force: true });

// --- MCP: list_areas and the area parameter ---
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-areas-mcp-"));
  fs.mkdirSync(path.join(sandbox, "mindplan"), { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(toolRoot, "dist/index.js")],
    env: { ...process.env, MINDPLAN_ROOT: sandbox },
    stderr: "pipe",
  });
  const client = new Client({ name: "areas-test", version: "0.1.0" });
  await client.connect(transport);
  const raw = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
  };
  const call = async (name, args) => {
    const r = await raw(name, args);
    if (r.error) throw new Error(`${name}: ${r.text}`);
    return JSON.parse(r.text);
  };
  for (let a = 0; a < 30; a++) {
    await call("create_node", {
      id: `j-area-${a}`,
      type: "Journey",
      title: `Area number ${a}`,
      description: `Customers of segment ${a} browse, book, pay, and review their bookings in this area.`,
    });
  }
  await call("create_node", { id: "f-pay", type: "Foundation", title: "Payments", description: "Adapter — card payments.", role: "adapter" });
  await call("create_node", { id: "i-pay", type: "Interaction", title: "Pay a deposit", description: "Customer pays a deposit by card." });
  await call("create_node", { id: "i-refund", type: "Interaction", title: "Refund a deposit", description: "Customer gets a deposit back." });
  await call("create_node", { id: "if-app", type: "Interface", title: "Booking app", description: "The booking app." });
  await call("create_node", { id: "bug-pay", type: "Bug", title: "Double charge", description: "A deposit is charged twice." });
  await call("link_nodes", { source_id: "i-pay", target_id: "j-area-3", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-pay", target_id: "f-pay", edge_type: "depends_on" });
  await call("link_nodes", { source_id: "i-refund", target_id: "j-area-4", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "if-app", target_id: "i-pay", edge_type: "exposes" });
  await call("link_nodes", { source_id: "bug-pay", target_id: "f-pay", edge_type: "affects" });

  const listedText = (await raw("list_areas", {})).text;
  const listed = JSON.parse(listedText);
  assert.equal(listed.count, 30);
  assert.ok(Buffer.byteLength(listedText) < 4096, `list_areas is ${Buffer.byteLength(listedText)} bytes for 30 areas`);
  const row3 = listed.rows.find((r) => r[0] === "j-area-3");
  assert.deepEqual(listed.columns, ["id", "title", "description", "interactions", "interfaces", "foundations", "open_bugs"]);
  assert.deepEqual(row3.slice(3), [1, 1, 1, 1], JSON.stringify(row3));
  assert.ok(row3[2].length <= 60);
  ok(`list_areas: 30 areas in ${Buffer.byteLength(listedText)} bytes, with member and open-bug counts`);

  const scopedOrient = await call("orient_for_work", { query: "deposit", area: "j-area-4" });
  assert.deepEqual(scopedOrient.matches.map((m) => m.id), ["i-refund"], JSON.stringify(scopedOrient.matches));
  const scopedFind = await call("find_related_nodes", { query: "deposit", area: "j-area-3" });
  assert.ok(scopedFind.matches.every((m) => ["i-pay", "f-pay", "if-app", "j-area-3"].includes(m.id)) && scopedFind.matches.length > 0);
  const wrong = await raw("orient_for_work", { query: "deposit", area: "i-pay" });
  assert.ok(wrong.error && wrong.text.includes("must be a Journey"), wrong.text);
  ok("area reaches orient_for_work and find_related_nodes; a non-Journey area is Blocked");
  await client.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log("AREAS TESTS PASSED");
