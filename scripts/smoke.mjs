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
const client = new Client({ name: "smoke", version: "0.1.0" });
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
const wfFolder = path.join(root, "mindplan", "workflows", "wf-checkout");
if (!fs.existsSync(path.join(wfFolder, "context.mdx"))) {
  failures++; console.log("FAIL entity folder scaffold");
} else console.log("ok   entity folder scaffold");
if (fs.existsSync(path.join(root, "mindplan", "mindplan.json"))) {
  failures++; console.log("FAIL mindplan.json must not exist");
} else console.log("ok   no mindplan.json");
const graphFromFm = JSON.parse(await expectOk("read graph from frontmatter", "get_mindplan_graph", {}));
const wfFromFm = graphFromFm.nodes.find((n) => n.id === "wf-checkout");
if (wfFromFm?.title !== "Checkout" || wfFromFm?.description !== "Split & pay") {
  failures++; console.log(`FAIL node title/description from frontmatter: ${JSON.stringify(wfFromFm)}`);
} else console.log("ok   nodes discovered from frontmatter");
await expectBlocked("duplicate id", "create_node", { id: "wf-checkout", type: "Workflow", title: "x", description: "y" });

// --- ghost workflow rule ---
await expectBlocked("ghost workflow (no links)", "update_node_status", { node_id: "wf-checkout", new_status: "ready" });
await expectOk("link belongs_to", "link_nodes", { source_id: "wf-checkout", target_id: "j-ordering", edge_type: "belongs_to" });
await expectBlocked("ghost workflow (no foundation)", "update_node_status", { node_id: "wf-checkout", new_status: "ready" });
await expectOk("link depends_on", "link_nodes", { source_id: "wf-checkout", target_id: "f-db", edge_type: "depends_on" });
const wfCtx = fs.readFileSync(path.join(wfFolder, "context.mdx"), "utf-8");
if (!wfCtx.includes("belongs_to:") || !wfCtx.includes("j-ordering") || !wfCtx.includes("depends_on:") || !wfCtx.includes("f-db")) {
  failures++; console.log("FAIL edges not persisted in wf-checkout frontmatter");
} else console.log("ok   edges in frontmatter");
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
const wfPath = path.join(root, "mindplan", "workflows", "wf-checkout", "context.mdx");
fs.writeFileSync(
  wfPath,
  fs.readFileSync(wfPath, "utf-8").replaceAll("[ ]", "[x]") +
    '\n<StateBadge state="in-progress" />\n'
);
await expectOk("workflow -> in-review", "update_node_status", { node_id: "wf-checkout", new_status: "in-review" });

// --- infrastructure first (ship requires stable foundations) ---
await expectBlocked("infrastructure first (foundation not shipped)", "update_node_status", { node_id: "wf-checkout", new_status: "ship" });
const fPath = path.join(root, "mindplan", "foundations", "f-db", "context.mdx");
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

const bugPath = path.join(root, "mindplan", "bugs", "bug-race", "context.mdx");
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
if (ctx.context_path !== "mindplan/bugs/bug-race/context.mdx") { failures++; console.log("FAIL bug context path"); }
else console.log("ok   bug get_node_context");
if (ctx.title !== "Race condition" || ctx.description !== "Double charge") {
  failures++; console.log(`FAIL bug title/description from context: ${JSON.stringify({ title: ctx.title, description: ctx.description })}`);
} else console.log("ok   bug title/description from frontmatter");

// --- workflow dependency closure ---
await expectOk("create wf-auth", "create_node", { id: "wf-auth", type: "Workflow", title: "Authentication", description: "Login flow" });
await expectOk("create wf-pay", "create_node", { id: "wf-pay", type: "Workflow", title: "Payment", description: "Process payment" });
await expectOk("link wf-pay depends_on wf-auth", "link_nodes", { source_id: "wf-pay", target_id: "wf-auth", edge_type: "depends_on" });
await expectOk("link wf-pay depends_on f-db", "link_nodes", { source_id: "wf-pay", target_id: "f-db", edge_type: "depends_on" });
await expectOk("link wf-auth depends_on f-db", "link_nodes", { source_id: "wf-auth", target_id: "f-db", edge_type: "depends_on" });
await expectBlocked("dependency closure (auth not in journey)", "link_nodes", { source_id: "wf-pay", target_id: "j-ordering", edge_type: "belongs_to" });
const cascade = JSON.parse(await expectOk("link wf-pay with link_dependent", "link_nodes", {
  source_id: "wf-pay", target_id: "j-ordering", edge_type: "belongs_to", link_dependent: true,
}));
if (!cascade.dependents_linked?.some((l) => l.source === "wf-auth" && l.target === "j-ordering")) {
  failures++; console.log(`FAIL dependents_linked missing wf-auth: ${JSON.stringify(cascade.dependents_linked)}`);
} else console.log("ok   link_dependent cascaded wf-auth to journey");

graph = JSON.parse(await expectOk("read graph after link_dependent", "get_mindplan_graph", {}));
const wfAuth = graph.nodes.find((n) => n.id === "wf-auth");
if (!graph.edges.some((e) => e.source === "wf-auth" && e.target === "j-ordering" && e.type === "belongs_to")) {
  failures++; console.log("FAIL wf-auth missing belongs_to j-ordering after cascade");
} else console.log("ok   wf-auth belongs_to j-ordering in graph");

await expectBlocked("depends_on cycle", "link_nodes", { source_id: "wf-auth", target_id: "wf-pay", edge_type: "depends_on" });

await expectOk("wf-auth -> ready", "update_node_status", { node_id: "wf-auth", new_status: "ready" });
await expectOk("wf-pay -> ready", "update_node_status", { node_id: "wf-pay", new_status: "ready" });
await expectOk("wf-auth -> in-progress", "update_node_status", { node_id: "wf-auth", new_status: "in-progress" });
await expectOk("wf-pay -> in-progress", "update_node_status", { node_id: "wf-pay", new_status: "in-progress" });

const wfAuthPath = path.join(root, "mindplan", "workflows", "wf-auth", "context.mdx");
const wfPayPath = path.join(root, "mindplan", "workflows", "wf-pay", "context.mdx");
fs.writeFileSync(wfAuthPath, fs.readFileSync(wfAuthPath, "utf-8").replaceAll("[ ]", "[x]"));
fs.writeFileSync(wfPayPath, fs.readFileSync(wfPayPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("wf-auth -> in-review", "update_node_status", { node_id: "wf-auth", new_status: "in-review" });
await expectOk("wf-pay -> in-review", "update_node_status", { node_id: "wf-pay", new_status: "in-review" });

await expectBlocked("infrastructure first (wf-auth not shipped)", "update_node_status", { node_id: "wf-pay", new_status: "ship" });
await expectOk("wf-auth -> ship", "update_node_status", { node_id: "wf-auth", new_status: "ship" });
await expectOk("wf-pay -> ship", "update_node_status", { node_id: "wf-pay", new_status: "ship" });

graph = JSON.parse(await expectOk("read graph after wf-pay ship", "get_mindplan_graph", {}));
const wfPayShipped = graph.nodes.find((n) => n.id === "wf-pay");
if (wfPayShipped.state !== "stable") { failures++; console.log(`FAIL wf-pay state after ship: ${wfPayShipped.state}`); }
else console.log("ok   wf-pay shipped after wf-auth stable");

// --- versioning and blast radius ---
await expectBlocked("version draft predecessor", "create_node_version", {
  previous_id: "wf-tips", id: "wf-tips-v2", title: "Tips v2", description: "v2",
});

await expectOk("link wf-tips depends_on wf-checkout", "link_nodes", {
  source_id: "wf-tips", target_id: "wf-checkout", edge_type: "depends_on",
});

const versionRes = JSON.parse(await expectOk("create wf-checkout-v2", "create_node_version", {
  previous_id: "wf-checkout", id: "wf-checkout-v2", title: "Checkout v2", description: "Revised checkout",
}));

if (!versionRes.dependents_relinked?.some((l) => l.source === "wf-tips" && l.target === "wf-checkout-v2")) {
  failures++; console.log(`FAIL dependents_relinked missing wf-tips: ${JSON.stringify(versionRes.dependents_relinked)}`);
} else console.log("ok   dependents_relinked includes wf-tips");

graph = JSON.parse(await expectOk("read graph after create_node_version", "get_mindplan_graph", {}));
const tipsDependsCheckout = graph.edges.filter(
  (e) => e.source === "wf-tips" && e.type === "depends_on" && (e.target === "wf-checkout" || e.target === "wf-checkout-v2")
);
if (tipsDependsCheckout.length !== 2) {
  failures++; console.log(`FAIL wf-tips should depend on both checkout versions: ${JSON.stringify(tipsDependsCheckout)}`);
} else console.log("ok   wf-tips duplicated depends_on to new version");
const wfCheckoutOrig = graph.nodes.find((n) => n.id === "wf-checkout");
const wfCheckoutV2 = graph.nodes.find((n) => n.id === "wf-checkout-v2");
if (wfCheckoutOrig.state !== "stable") {
  failures++; console.log(`FAIL predecessor should stay stable after version create: ${wfCheckoutOrig.state}`);
} else console.log("ok   predecessor stays stable after create_node_version");

if (wfCheckoutV2.state !== "draft") {
  failures++; console.log(`FAIL new version should be draft: ${wfCheckoutV2.state}`);
} else console.log("ok   new version created as draft");

const v2Path = path.join(root, "mindplan", "workflows", "wf-checkout-v2", "context.mdx");
const v2Ctx = fs.readFileSync(v2Path, "utf-8");
if (!v2Ctx.includes("supersedes:") || !v2Ctx.includes("wf-checkout") || !v2Ctx.includes("belongs_to:") || !v2Ctx.includes("depends_on:")) {
  failures++; console.log("FAIL v2 missing supersedes or inherited edges in frontmatter");
} else console.log("ok   v2 inherits edges and supersedes");

await expectBlocked("re-version predecessor with successor", "create_node_version", {
  previous_id: "wf-checkout", id: "wf-checkout-v3", title: "Checkout v3", description: "v3",
});

{
  const { error, text } = await call("link_nodes", {
    source_id: "wf-checkout-v2", target_id: "wf-checkout", edge_type: "supersedes",
  });
  if (error && (text.startsWith("Blocked:") || text.includes("Invalid option"))) {
    console.log(`ok   supersedes not allowed via link_nodes -> ${text.slice(0, 80)}...`);
  } else {
    failures++; console.log(`FAIL supersedes via link_nodes: error=${error} text=${text}`);
  }
}

await expectOk("create wf-a", "create_node", { id: "wf-a", type: "Workflow", title: "A", description: "base" });
await expectOk("create wf-b", "create_node", { id: "wf-b", type: "Workflow", title: "B", description: "mid" });
await expectOk("create wf-c", "create_node", { id: "wf-c", type: "Workflow", title: "C", description: "top" });
await expectOk("link wf-a journey", "link_nodes", { source_id: "wf-a", target_id: "j-ordering", edge_type: "belongs_to" });
await expectOk("link wf-a f-db", "link_nodes", { source_id: "wf-a", target_id: "f-db", edge_type: "depends_on" });
await expectOk("link wf-b depends_on wf-a", "link_nodes", { source_id: "wf-b", target_id: "wf-a", edge_type: "depends_on" });
await expectOk("link wf-b f-db", "link_nodes", { source_id: "wf-b", target_id: "f-db", edge_type: "depends_on" });
await expectOk("link wf-b journey", "link_nodes", { source_id: "wf-b", target_id: "j-ordering", edge_type: "belongs_to", link_dependent: true });
await expectOk("link wf-c depends_on wf-b", "link_nodes", { source_id: "wf-c", target_id: "wf-b", edge_type: "depends_on" });
await expectOk("link wf-c f-db", "link_nodes", { source_id: "wf-c", target_id: "f-db", edge_type: "depends_on" });
await expectOk("link wf-c journey", "link_nodes", { source_id: "wf-c", target_id: "j-ordering", edge_type: "belongs_to", link_dependent: true });

const radius = JSON.parse(await expectOk("get_blast_radius wf-a", "get_blast_radius", { node_id: "wf-a" }));
const wfB = radius.affected?.find((a) => a.id === "wf-b");
const wfC = radius.affected?.find((a) => a.id === "wf-c");
if (!wfB || wfB.distance !== 1 || !wfC || wfC.distance !== 2) {
  failures++; console.log(`FAIL blast radius distances: ${JSON.stringify(radius.affected)}`);
} else console.log("ok   get_blast_radius transitive distances");
if (!radius.journeys_at_risk?.includes("j-ordering")) {
  failures++; console.log(`FAIL journeys_at_risk: ${JSON.stringify(radius.journeys_at_risk)}`);
} else console.log("ok   get_blast_radius journeys_at_risk");

await expectOk("wf-checkout-v2 -> ready", "update_node_status", { node_id: "wf-checkout-v2", new_status: "ready" });
await expectOk("wf-checkout-v2 -> in-progress", "update_node_status", { node_id: "wf-checkout-v2", new_status: "in-progress" });
fs.writeFileSync(v2Path, fs.readFileSync(v2Path, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("wf-checkout-v2 -> in-review", "update_node_status", { node_id: "wf-checkout-v2", new_status: "in-review" });

graph = JSON.parse(await expectOk("read graph before v2 ship", "get_mindplan_graph", {}));
const predBeforeShip = graph.nodes.find((n) => n.id === "wf-checkout");
if (predBeforeShip.state !== "stable") {
  failures++; console.log(`FAIL predecessor before v2 ship: ${predBeforeShip.state}`);
} else console.log("ok   predecessor still stable before v2 ship");

const shipV2 = JSON.parse(await expectOk("wf-checkout-v2 -> ship", "update_node_status", { node_id: "wf-checkout-v2", new_status: "ship" }));
if (!shipV2.predecessor_deprecated || shipV2.predecessor_deprecated.id !== "wf-checkout") {
  failures++; console.log(`FAIL predecessor_deprecated missing: ${JSON.stringify(shipV2.predecessor_deprecated)}`);
} else console.log("ok   predecessor deprecated on v2 ship");

graph = JSON.parse(await expectOk("read graph after v2 ship", "get_mindplan_graph", {}));
const predAfterShip = graph.nodes.find((n) => n.id === "wf-checkout");
if (predAfterShip.state !== "deprecated") {
  failures++; console.log(`FAIL predecessor after v2 ship: ${predAfterShip.state}`);
} else console.log("ok   predecessor deprecated after v2 ship");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
