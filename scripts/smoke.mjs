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
if (!fs.existsSync(path.join(wfFolder, "current.mdx"))) {
  failures++; console.log("FAIL entity folder scaffold");
} else console.log("ok   entity folder scaffold");
const mapPath = path.join(root, "mindplan", "map.md");
const mapAfterCreate = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, "utf-8") : "";
if (!mapAfterCreate.includes("```mermaid") || !mapAfterCreate.includes("wf-checkout")) {
  failures++; console.log(`FAIL mindplan/map.md missing or stale after create_node: ${mapAfterCreate.slice(0, 200)}`);
} else console.log("ok   mindplan/map.md after create_node");
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
const mapAfterLink = fs.readFileSync(mapPath, "utf-8");
if (!mapAfterLink.includes("wf_checkout") && !mapAfterLink.includes("wf-checkout")) {
  // Mermaid ids are sanitized with underscores; labels still contain the original id.
  failures++; console.log(`FAIL mindplan/map.md missing workflow after link: ${mapAfterLink.slice(0, 300)}`);
} else if (!mapAfterLink.includes("f-db") && !mapAfterLink.includes("f_db")) {
  failures++; console.log(`FAIL mindplan/map.md missing foundation after link: ${mapAfterLink.slice(0, 300)}`);
} else console.log("ok   mindplan/map.md refreshed after link_nodes");
const wfCtx = fs.readFileSync(path.join(wfFolder, "current.mdx"), "utf-8");
if (!wfCtx.includes("belongs_to:") || !wfCtx.includes("j-ordering") || !wfCtx.includes("depends_on:") || !wfCtx.includes("f-db")) {
  failures++; console.log("FAIL edges not persisted in wf-checkout frontmatter");
} else console.log("ok   edges in frontmatter");
if (!wfCtx.includes("## Affected Files")) {
  failures++; console.log("FAIL workflow scaffold missing ## Affected Files section");
} else console.log("ok   workflow scaffold includes affected files section");

// --- find_related_nodes ---
await expectBlocked("find_related_nodes requires query or node_id", "find_related_nodes", {});
await expectBlocked("find_related_nodes unknown node_id", "find_related_nodes", { node_id: "wf-missing" });
const found = JSON.parse(
  await expectOk("find_related_nodes checkout", "find_related_nodes", { query: "checkout split" })
);
if (found.focus !== "wf-checkout") {
  failures++; console.log(`FAIL find focus: expected wf-checkout, got ${found.focus}`);
} else console.log("ok   find_related_nodes ranks checkout as focus");
const foundEdgeTypes = new Set((found.edges ?? []).map((e) => `${e.source}->${e.target}:${e.type}`));
if (
  !foundEdgeTypes.has("wf-checkout->j-ordering:belongs_to") ||
  !foundEdgeTypes.has("wf-checkout->f-db:depends_on")
) {
  failures++; console.log(`FAIL find neighborhood edges: ${JSON.stringify(found.edges)}`);
} else console.log("ok   find_related_nodes 1-hop edges");
const foundIds = new Set((found.nodes ?? []).map((n) => n.id));
if (!foundIds.has("wf-checkout") || !foundIds.has("j-ordering") || !foundIds.has("f-db")) {
  failures++; console.log(`FAIL find neighborhood nodes: ${JSON.stringify(found.nodes)}`);
} else console.log("ok   find_related_nodes 1-hop nodes");
const forced = JSON.parse(
  await expectOk("find_related_nodes force node_id", "find_related_nodes", {
    query: "ordering",
    node_id: "wf-checkout",
  })
);
if (forced.focus !== "wf-checkout") {
  failures++; console.log(`FAIL forced focus: ${forced.focus}`);
} else console.log("ok   find_related_nodes forces focus via node_id");
const emptyFind = JSON.parse(
  await expectOk("find_related_nodes no match", "find_related_nodes", { query: "zzzz-no-such-feature" })
);
if (emptyFind.focus !== null || (emptyFind.matches?.length ?? 0) !== 0) {
  failures++; console.log(`FAIL empty find: ${JSON.stringify(emptyFind)}`);
} else console.log("ok   find_related_nodes empty matches");

await expectOk("workflow -> ready", "update_node_status", { node_id: "wf-checkout", new_status: "ready" });

// --- export_mindplan_view ---
const viewFull = JSON.parse(await expectOk("export mermaid full", "export_mindplan_view", {}));
if (viewFull.format !== "mermaid" || typeof viewFull.diagram !== "string" || !viewFull.diagram.startsWith("flowchart TB")) {
  failures++; console.log(`FAIL export full mermaid: ${JSON.stringify(viewFull).slice(0, 200)}`);
} else console.log("ok   export_mindplan_view mermaid full");
if (!viewFull.diagram.includes("subgraph foundations") || !viewFull.diagram.includes("journey_j_ordering")) {
  failures++; console.log(`FAIL export missing clusters: ${viewFull.diagram.slice(0, 300)}`);
} else console.log("ok   export_mindplan_view clusters");
const viewFocus = JSON.parse(
  await expectOk("export mermaid focus", "export_mindplan_view", { focus: "wf-checkout" })
);
if (viewFocus.focus !== "wf-checkout" || !viewFocus.diagram.includes("wf_checkout")) {
  failures++; console.log(`FAIL export focus: ${JSON.stringify({ focus: viewFocus.focus, dig: viewFocus.diagram.slice(0, 200) })}`);
} else console.log("ok   export_mindplan_view focus");
const viewDot = JSON.parse(await expectOk("export dot", "export_mindplan_view", { format: "dot" }));
if (viewDot.format !== "dot" || !viewDot.diagram.startsWith("digraph MindPlan")) {
  failures++; console.log(`FAIL export dot: ${viewDot.diagram?.slice(0, 100)}`);
} else console.log("ok   export_mindplan_view dot");
await expectBlocked("export unknown focus", "export_mindplan_view", { focus: "wf-missing" });

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
const wfPath = path.join(root, "mindplan", "workflows", "wf-checkout", "current.mdx");
fs.writeFileSync(
  wfPath,
  fs.readFileSync(wfPath, "utf-8").replaceAll("[ ]", "[x]") +
    '\n<StateBadge state="in-progress" />\n'
);
await expectOk("workflow -> in-review", "update_node_status", { node_id: "wf-checkout", new_status: "in-review" });

// --- infrastructure first (ship requires stable foundations) ---
await expectBlocked("infrastructure first (foundation not shipped)", "update_node_status", { node_id: "wf-checkout", new_status: "ship" });
const fPath = path.join(root, "mindplan", "foundations", "f-db", "current.mdx");
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

const bugPath = path.join(root, "mindplan", "bugs", "bug-race", "current.mdx");
await expectBlocked("bug completion check", "update_node_status", { node_id: "bug-race", new_status: "in-review" });
fs.writeFileSync(bugPath, fs.readFileSync(bugPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("bug -> in-review", "update_node_status", { node_id: "bug-race", new_status: "in-review" });
await expectOk("bug -> resolved", "update_node_status", { node_id: "bug-race", new_status: "resolved" });

graph = JSON.parse(await expectOk("read graph after bug resolved", "get_mindplan_graph", {}));
const viewHideClosed = JSON.parse(
  await expectOk("export hides closed bugs", "export_mindplan_view", { focus: "wf-checkout" })
);
if (viewHideClosed.diagram.includes("bug-race") || viewHideClosed.diagram.includes("bug_race")) {
  failures++; console.log("FAIL export should hide resolved bug by default");
} else console.log("ok   export_mindplan_view hides closed bugs");
const viewShowClosed = JSON.parse(
  await expectOk("export include_retired", "export_mindplan_view", {
    focus: "wf-checkout",
    include_retired: true,
  })
);
if (!viewShowClosed.diagram.includes("bug_race") && !viewShowClosed.diagram.includes("bug-race")) {
  failures++; console.log("FAIL export include_retired should show resolved bug");
} else console.log("ok   export_mindplan_view include_retired shows closed bugs");
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
if (ctx.context_path !== "mindplan/bugs/bug-race/current.mdx") { failures++; console.log("FAIL bug context path"); }
else console.log("ok   bug get_node_context");
if (ctx.title !== "Race condition" || ctx.description !== "Double charge") {
  failures++; console.log(`FAIL bug title/description from context: ${JSON.stringify({ title: ctx.title, description: ctx.description })}`);
} else console.log("ok   bug title/description from frontmatter");
if (!ctx.record?.id || ctx.record.id !== "bug-race" || typeof ctx.body !== "string") {
  failures++; console.log(`FAIL get_node_context record+body: ${JSON.stringify({ record: ctx.record, bodyType: typeof ctx.body })}`);
} else console.log("ok   get_node_context record+body");

// --- orient_for_work ---
await expectBlocked("orient_for_work requires query or node_id", "orient_for_work", {});
const oriented = JSON.parse(
  await expectOk("orient_for_work checkout", "orient_for_work", { query: "checkout" })
);
if (oriented.focus !== "wf-checkout" || !oriented.context?.record?.id || oriented.context.record.id !== "wf-checkout") {
  failures++; console.log(`FAIL orient_for_work context: ${JSON.stringify({ focus: oriented.focus, record: oriented.context?.record })}`);
} else console.log("ok   orient_for_work includes context record");
if (!oriented.blast_radius?.node_id || oriented.blast_radius.node_id !== "wf-checkout") {
  failures++; console.log(`FAIL orient_for_work blast_radius: ${JSON.stringify(oriented.blast_radius)}`);
} else console.log("ok   orient_for_work includes blast_radius for workflow");

// --- patch_node_territory ---
await expectBlocked("patch_node_territory empty", "patch_node_territory", { node_id: "wf-tips" });
const patchDesc = JSON.parse(
  await expectOk("patch workflow description", "patch_node_territory", {
    node_id: "wf-tips",
    description: "Tipping flow (revised scope)",
  })
);
if (!patchDesc.patched_fields?.includes("description")) {
  failures++; console.log(`FAIL patch description fields: ${JSON.stringify(patchDesc)}`);
} else console.log("ok   patch_node_territory description");
graph = JSON.parse(await expectOk("read graph after description patch", "get_mindplan_graph", {}));
const wfTipsPatched = graph.nodes.find((n) => n.id === "wf-tips");
if (wfTipsPatched?.description !== "Tipping flow (revised scope)") {
  failures++; console.log(`FAIL description not in graph: ${wfTipsPatched?.description}`);
} else console.log("ok   patched description visible in graph");
await expectBlocked("patch shipped workflow description", "patch_node_territory", {
  node_id: "wf-checkout",
  description: "should not apply",
});
const wfTipsCtxPath = path.join(root, "mindplan", "workflows", "wf-tips", "current.mdx");
const patchCheck = JSON.parse(
  await expectOk("patch toggle checkbox", "patch_node_territory", {
    node_id: "wf-tips",
    toggle_checkboxes: [{ contains: "Requirements defined", checked: true }],
  })
);
if (!patchCheck.patched_fields?.includes("toggle_checkboxes")) {
  failures++; console.log(`FAIL patch checkbox fields: ${JSON.stringify(patchCheck)}`);
} else console.log("ok   patch_node_territory toggle_checkboxes");
const tipsAfterCheck = fs.readFileSync(wfTipsCtxPath, "utf-8");
if (!tipsAfterCheck.includes("- [x] Requirements defined")) {
  failures++; console.log("FAIL checkbox not toggled on disk");
} else console.log("ok   patch_node_territory persisted checkbox");
const patchFiles = JSON.parse(
  await expectOk("patch append affected files", "patch_node_territory", {
    node_id: "wf-tips",
    append_affected_files: ["src/tips.ts"],
  })
);
if (!patchFiles.patched_fields?.includes("append_affected_files")) {
  failures++; console.log(`FAIL patch affected files fields: ${JSON.stringify(patchFiles)}`);
} else console.log("ok   patch_node_territory append_affected_files");
const wfTipsFiles = JSON.parse(
  await expectOk("get_workflow_files after patch", "get_workflow_files", { node_id: "wf-tips" })
);
if (!wfTipsFiles.files?.includes("src/tips.ts")) {
  failures++; console.log(`FAIL affected files after patch: ${JSON.stringify(wfTipsFiles)}`);
} else console.log("ok   append_affected_files via patch_node_territory");

// --- workflow affected files ---
const wfFilesEmpty = JSON.parse(
  await expectOk("get_workflow_files empty", "get_workflow_files", { node_id: "wf-checkout" })
);
if (wfFilesEmpty.node_id !== "wf-checkout" || (wfFilesEmpty.files?.length ?? 0) !== 0) {
  failures++; console.log(`FAIL empty affected files: ${JSON.stringify(wfFilesEmpty)}`);
} else console.log("ok   get_workflow_files empty scaffold");
fs.writeFileSync(
  wfPath,
  fs.readFileSync(wfPath, "utf-8").replace(
    "_Project files touched during implementation (project-relative paths)._",
    "- `src/checkout.ts`\n- tests/checkout.test.ts"
  )
);
const wfFiles = JSON.parse(
  await expectOk("get_workflow_files populated", "get_workflow_files", { node_id: "wf-checkout" })
);
if (
  wfFiles.files?.length !== 2 ||
  !wfFiles.files.includes("src/checkout.ts") ||
  !wfFiles.files.includes("tests/checkout.test.ts")
) {
  failures++; console.log(`FAIL affected files parse: ${JSON.stringify(wfFiles)}`);
} else console.log("ok   get_workflow_files parses list");
await expectBlocked("get_workflow_files non-workflow", "get_workflow_files", { node_id: "f-db" });

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

const wfAuthPath = path.join(root, "mindplan", "workflows", "wf-auth", "current.mdx");
const wfPayPath = path.join(root, "mindplan", "workflows", "wf-pay", "current.mdx");
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

// --- stable-id evolution (open_next / promote) ---
await expectBlocked("open_next on draft", "open_next", {
  node_id: "wf-tips", title: "Tips v2", description: "v2",
});

await expectOk("link wf-tips depends_on wf-checkout", "link_nodes", {
  source_id: "wf-tips", target_id: "wf-checkout", edge_type: "depends_on",
});

const openNextRes = JSON.parse(await expectOk("open_next wf-checkout", "open_next", {
  node_id: "wf-checkout", title: "Checkout v2", description: "Revised checkout",
}));
if (openNextRes.next?.state !== "draft") {
  failures++; console.log(`FAIL open_next should create draft next: ${JSON.stringify(openNextRes.next)}`);
} else console.log("ok   open_next creates draft next slot");

graph = JSON.parse(await expectOk("read graph after open_next", "get_mindplan_graph", {}));
const tipsDependsAfterOpen = graph.edges.filter(
  (e) => e.source === "wf-tips" && e.type === "depends_on" && e.target === "wf-checkout"
);
if (tipsDependsAfterOpen.length !== 1) {
  failures++; console.log(`FAIL wf-tips should still depend on wf-checkout: ${JSON.stringify(tipsDependsAfterOpen)}`);
} else console.log("ok   dependents keep same id after open_next");

const blastWhileNext = JSON.parse(
  await expectOk("blast radius while next open", "get_blast_radius", { node_id: "wf-checkout" })
);
const tipsInBlast = blastWhileNext.affected?.find((a) => a.id === "wf-tips");
if (!tipsInBlast || tipsInBlast.distance !== 1) {
  failures++; console.log(`FAIL blast should include wf-tips@1: ${JSON.stringify(blastWhileNext.affected)}`);
} else console.log("ok   get_blast_radius includes dependents of stable id");
if (blastWhileNext.via_supersedes !== undefined) {
  failures++; console.log(`FAIL via_supersedes should be removed: ${JSON.stringify(blastWhileNext.via_supersedes)}`);
} else console.log("ok   get_blast_radius has no via_supersedes");

const wfCheckoutLive = graph.nodes.find((n) => n.id === "wf-checkout");
if (wfCheckoutLive.state !== "stable" || wfCheckoutLive.next?.state !== "draft") {
  failures++; console.log(`FAIL live should stay stable with draft next: ${JSON.stringify(wfCheckoutLive)}`);
} else console.log("ok   live stays stable after open_next");

const nextPath = path.join(root, "mindplan", "workflows", "wf-checkout", "next.mdx");
const nextCtx = fs.readFileSync(nextPath, "utf-8");
if (!nextCtx.includes("state: draft") || !nextCtx.includes("belongs_to:") || !nextCtx.includes("depends_on:")) {
  failures++; console.log("FAIL next.mdx missing draft state or inherited edges");
} else console.log("ok   next.mdx inherits edges and starts draft");

await expectBlocked("open_next twice", "open_next", {
  node_id: "wf-checkout", title: "Checkout v3", description: "v3",
});

// Unshipped dependent can still ship against the live node while next is draft.
const tipsPath = path.join(root, "mindplan", "workflows", "wf-tips", "current.mdx");
fs.writeFileSync(tipsPath, fs.readFileSync(tipsPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("wf-tips -> in-review while next draft", "update_node_status", {
  node_id: "wf-tips", new_status: "in-review",
});
await expectOk("wf-tips -> ship while next draft", "update_node_status", {
  node_id: "wf-tips", new_status: "ship",
});
console.log("ok   unshipped dependent can ship while next evolution is still draft");

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

await expectOk("wf-checkout next -> ready", "update_node_status", { node_id: "wf-checkout", new_status: "ready" });
await expectOk("wf-checkout next -> in-progress", "update_node_status", { node_id: "wf-checkout", new_status: "in-progress" });
fs.writeFileSync(nextPath, fs.readFileSync(nextPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("wf-checkout next -> in-review", "update_node_status", { node_id: "wf-checkout", new_status: "in-review" });

graph = JSON.parse(await expectOk("read graph before promote", "get_mindplan_graph", {}));
const beforePromote = graph.nodes.find((n) => n.id === "wf-checkout");
if (beforePromote.state !== "stable" || beforePromote.next?.state !== "in-review") {
  failures++; console.log(`FAIL before promote: ${JSON.stringify(beforePromote)}`);
} else console.log("ok   live still stable with next in-review before ship");

const shipNext = JSON.parse(await expectOk("wf-checkout ship promotes next", "update_node_status", { node_id: "wf-checkout", new_status: "ship" }));
if (!shipNext.promoted_next) {
  failures++; console.log(`FAIL promoted_next missing: ${JSON.stringify(shipNext)}`);
} else console.log("ok   ship promotes next over current");
if (shipNext.new_state !== "stable") {
  failures++; console.log(`FAIL after promote state: ${shipNext.new_state}`);
} else console.log("ok   promoted node is stable");

if (fs.existsSync(nextPath)) {
  failures++; console.log("FAIL next.mdx should be deleted after promote");
} else console.log("ok   next.mdx removed after promote");

const currentAfter = fs.readFileSync(path.join(root, "mindplan", "workflows", "wf-checkout", "current.mdx"), "utf-8");
if (!currentAfter.includes("Checkout v2") || !currentAfter.includes("Revised checkout")) {
  failures++; console.log("FAIL current.mdx should carry promoted title/description");
} else console.log("ok   current.mdx updated from next on promote");

graph = JSON.parse(await expectOk("read graph after promote", "get_mindplan_graph", {}));
const afterPromote = graph.nodes.find((n) => n.id === "wf-checkout");
if (afterPromote.next) {
  failures++; console.log(`FAIL next should be gone after promote: ${JSON.stringify(afterPromote.next)}`);
} else console.log("ok   no next slot after promote");
const tipsDependsAfterPromote = graph.edges.filter(
  (e) => e.source === "wf-tips" && e.type === "depends_on" && e.target === "wf-checkout"
);
if (tipsDependsAfterPromote.length !== 1) {
  failures++; console.log(`FAIL wf-tips should still depend once on wf-checkout: ${JSON.stringify(tipsDependsAfterPromote)}`);
} else console.log("ok   dependents unchanged after promote (stable id)");

// discard_next path
await expectOk("open_next again for discard", "open_next", { node_id: "wf-checkout" });
await expectOk("discard_next", "discard_next", { node_id: "wf-checkout" });
if (fs.existsSync(nextPath)) {
  failures++; console.log("FAIL next.mdx should be gone after discard");
} else console.log("ok   discard_next removes next.mdx");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
