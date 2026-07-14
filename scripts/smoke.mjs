// End-to-end smoke test: spawns the built server over stdio and exercises
// every tool plus each Compiler Rule. Run with: npm test (from repo root)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const toolRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-smoke-"));
console.log("Sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
}
async function expectOk(label, tool, args) {
  const { error, text } = await call(tool, args);
  if (error) { failures++; console.log(`FAIL ${label}: unexpected error -> ${text}`); }
  else console.log(`ok   ${label}`);
  return text;
}
async function expectBlocked(label, tool, args) {
  const { error, text } = await call(tool, args);
  if (error && text.startsWith("Blocked: ")) console.log(`ok   ${label} -> ${text}`);
  else { failures++; console.log(`FAIL ${label}: expected Blocked, got error=${error} text=${text}`); }
}

// --- create nodes ---
await expectOk("create journey", "create_node", { id: "j-ordering", type: "Journey", title: "Ordering", description: "Diner orders food" });
await expectOk("create foundation", "create_node", { id: "f-db", type: "Foundation", title: "Database schema", description: "Core tables" });
await expectOk("create workflow", "create_node", { id: "wf-checkout", type: "Workflow", title: "Checkout", description: "Split & pay" });
const wfFolder = path.join(root, ".mindplan", "workflows", "wf-checkout");
if (!fs.existsSync(path.join(wfFolder, "context.mdx"))) {
  failures++; console.log("FAIL entity folder scaffold");
} else console.log("ok   entity folder scaffold");
await expectBlocked("duplicate id", "create_node", { id: "wf-checkout", type: "Workflow", title: "x", description: "y" });

// --- ghost workflow rule ---
await expectBlocked("ghost workflow (no links)", "update_node_status", { node_id: "wf-checkout", new_status: "ready" });
await expectOk("link belongs_to", "link_nodes", { source_id: "wf-checkout", target_id: "j-ordering", edge_type: "belongs_to" });
await expectBlocked("ghost workflow (no foundation)", "update_node_status", { node_id: "wf-checkout", new_status: "ready" });
await expectOk("link depends_on", "link_nodes", { source_id: "wf-checkout", target_id: "f-db", edge_type: "depends_on" });
await expectOk("workflow -> ready", "update_node_status", { node_id: "wf-checkout", new_status: "ready" });

// --- taxonomy rules ---
await expectBlocked("journey depends_on foundation", "link_nodes", { source_id: "j-ordering", target_id: "f-db", edge_type: "depends_on" });
await expectBlocked("foundation belongs_to journey", "link_nodes", { source_id: "f-db", target_id: "j-ordering", edge_type: "belongs_to" });

// --- journey computed states ---
await expectOk("workflow -> in-progress", "update_node_status", { node_id: "wf-checkout", new_status: "in-progress" });
let graph = JSON.parse(await expectOk("read graph", "get_mindplan_graph", {}));
const journey = graph.nodes.find((n) => n.id === "j-ordering");
if (journey.state !== "incubation") { failures++; console.log(`FAIL journey state: expected incubation, got ${journey.state}`); }
else console.log("ok   journey computed as incubation");

await expectBlocked("manual journey state", "update_node_status", { node_id: "j-ordering", new_status: "stable" });

// --- completion check ---
await expectBlocked("completion check (unchecked boxes)", "update_node_status", { node_id: "wf-checkout", new_status: "in-review" });
const wfPath = path.join(root, ".mindplan", "workflows", "wf-checkout", "context.mdx");
fs.writeFileSync(
  wfPath,
  fs.readFileSync(wfPath, "utf-8").replaceAll("[ ]", "[x]") +
    '\n<StateBadge state="in-progress" />\n'
);
await expectOk("workflow -> in-review", "update_node_status", { node_id: "wf-checkout", new_status: "in-review" });

// --- infrastructure first (ship requires stable foundations) ---
await expectBlocked("infrastructure first (foundation not shipped)", "update_node_status", { node_id: "wf-checkout", new_status: "ship" });
const fPath = path.join(root, ".mindplan", "foundations", "f-db", "context.mdx");
fs.writeFileSync(fPath, fs.readFileSync(fPath, "utf-8").replaceAll("[ ]", "[x]"));
for (const s of ["ready", "in-progress", "in-review"]) {
  await expectOk(`foundation -> ${s}`, "update_node_status", { node_id: "f-db", new_status: s });
}
await expectOk("foundation -> ship (stable)", "update_node_status", { node_id: "f-db", new_status: "ship" });

graph = JSON.parse(await expectOk("read graph after f-db ship", "get_mindplan_graph", {}));
const fDb = graph.nodes.find((n) => n.id === "f-db");
if (fDb.state !== "stable") { failures++; console.log(`FAIL f-db state: expected stable, got ${fDb.state}`); }
else console.log("ok   foundation shipped as stable");

await expectOk("workflow -> ship (stable)", "update_node_status", { node_id: "wf-checkout", new_status: "ship" });

graph = JSON.parse(await expectOk("read graph after wf ship", "get_mindplan_graph", {}));
const wf = graph.nodes.find((n) => n.id === "wf-checkout");
const j2 = graph.nodes.find((n) => n.id === "j-ordering");
if (wf.state !== "stable") { failures++; console.log(`FAIL wf-checkout state: expected stable, got ${wf.state}`); }
else console.log("ok   workflow shipped as stable");
if (j2.state !== "stable") { failures++; console.log(`FAIL journey state: expected stable, got ${j2.state}`); }
else console.log("ok   journey computed as stable");

const journeyBeforeBug = j2.state;

// --- bug: ghost bug + lifecycle + stability flip ---
await expectOk("create bug", "create_node", { id: "bug-race", type: "Bug", title: "Race condition", description: "Double charge" });
await expectBlocked("ghost bug (no affects)", "update_node_status", { node_id: "bug-race", new_status: "triaged" });
await expectOk("link affects wf", "link_nodes", { source_id: "bug-race", target_id: "wf-checkout", edge_type: "affects" });

graph = JSON.parse(await expectOk("read graph after affects link", "get_mindplan_graph", {}));
const wfAfterLink = graph.nodes.find((n) => n.id === "wf-checkout");
if (wfAfterLink.state !== "unstable") { failures++; console.log(`FAIL wf unstable on open bug link: got ${wfAfterLink.state}`); }
else console.log("ok   workflow unstable when open bug linked");

const jAfterBug = graph.nodes.find((n) => n.id === "j-ordering");
if (jAfterBug.state !== journeyBeforeBug) { failures++; console.log(`FAIL journey changed on bug link: ${journeyBeforeBug} -> ${jAfterBug.state}`); }
else console.log("ok   journey unchanged by bug activity");

await expectOk("bug -> triaged", "update_node_status", { node_id: "bug-race", new_status: "triaged" });
await expectOk("bug -> fixing", "update_node_status", { node_id: "bug-race", new_status: "fixing" });

const bugPath = path.join(root, ".mindplan", "bugs", "bug-race", "context.mdx");
await expectBlocked("bug completion check", "update_node_status", { node_id: "bug-race", new_status: "in-review" });
fs.writeFileSync(bugPath, fs.readFileSync(bugPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("bug -> in-review", "update_node_status", { node_id: "bug-race", new_status: "in-review" });
await expectOk("bug -> resolved", "update_node_status", { node_id: "bug-race", new_status: "resolved" });

graph = JSON.parse(await expectOk("read graph after bug resolved", "get_mindplan_graph", {}));
const wfAfterFix = graph.nodes.find((n) => n.id === "wf-checkout");
if (wfAfterFix.state !== "stable") { failures++; console.log(`FAIL wf stable after bug resolved: got ${wfAfterFix.state}`); }
else console.log("ok   workflow stable after bug resolved");

// --- evolving: second in-progress workflow ---
await expectOk("create wf2", "create_node", { id: "wf-tips", type: "Workflow", title: "Tips", description: "Tipping flow" });
await expectOk("link wf2 journey", "link_nodes", { source_id: "wf-tips", target_id: "j-ordering", edge_type: "belongs_to" });
await expectOk("link wf2 foundation", "link_nodes", { source_id: "wf-tips", target_id: "f-db", edge_type: "depends_on" });
await expectOk("wf2 -> ready", "update_node_status", { node_id: "wf-tips", new_status: "ready" });
const res = JSON.parse(await expectOk("wf2 -> in-progress", "update_node_status", { node_id: "wf-tips", new_status: "in-progress" }));
if (res.journeys_recomputed?.[0]?.state !== "evolving") { failures++; console.log(`FAIL journey evolving: ${JSON.stringify(res.journeys_recomputed)}`); }
else console.log("ok   journey computed as evolving");

await expectBlocked("skip to ship", "update_node_status", { node_id: "wf-tips", new_status: "ship" });
await expectBlocked("bug affects journey", "link_nodes", { source_id: "bug-race", target_id: "j-ordering", edge_type: "affects" });

const ctx = JSON.parse(await expectOk("get_node_context bug", "get_node_context", { node_id: "bug-race" }));
if (ctx.context_path !== ".mindplan/bugs/bug-race/context.mdx") { failures++; console.log("FAIL bug context path"); }
else console.log("ok   bug get_node_context");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
