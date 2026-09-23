// End-to-end smoke test: spawns the built server over stdio and exercises
// every tool plus each Compiler Rule. Run with: npm test (from repo root)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-smoke-"));
console.log("Sandbox:", root);

// Ownership universe config
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

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
async function expectBlockedContaining(label, tool, args, needle) {
  const { error, text } = await call(tool, args);
  if (error && text.startsWith("Blocked: ") && text.includes(needle)) {
    console.log(`ok   ${label} -> ${text}`);
  } else {
    failures++;
    console.log(`FAIL ${label}: expected Blocked containing "${needle}", got error=${error} text=${text}`);
  }
}

/** Replace create_node scaffold stubs so Minimum Territory Shape can pass. */
function fillMinimumTerritoryShape(filePath) {
  let raw = fs.readFileSync(filePath, "utf-8");
  raw = raw.replace(/^_.*?_$/gm, (line) => {
    if (line.includes("attachments/") || line.includes("`attachments/`")) return line;
    return "Smoke-filled territory content for Minimum Territory Shape.";
  });
  raw = raw.replace(/^(\d+\.\s+)_.*?_$/gm, "$1Smoke repro step.");
  raw = raw.replace(/\*\*Expected:\*\*\s*_.*?_/g, "**Expected:** Smoke expected outcome");
  raw = raw.replace(/\*\*Actual:\*\*\s*_.*?_/g, "**Actual:** Smoke actual outcome");
  // Foundations created before Purpose/AC existed still need those sections.
  if (filePath.includes(`${path.sep}foundations${path.sep}`) && !/^## Purpose\s*$/m.test(raw)) {
    raw = raw.replace(
      /(# [^\n]+\n\n[^\n]+\n\n)/,
      "$1## Purpose\n\nSmoke-filled territory content for Minimum Territory Shape.\n\n"
    );
  }
  if (
    filePath.includes(`${path.sep}foundations${path.sep}`) &&
    !/^## Acceptance Criteria\s*$/m.test(raw)
  ) {
    raw = raw.replace(
      /(## Shared Substrate Spec\n\n[\s\S]*?\n\n)/,
      "$1## Acceptance Criteria\n\nSmoke-filled territory content for Minimum Territory Shape.\n\n"
    );
  }
  if (filePath.includes(`${path.sep}interfaces${path.sep}`) && !/^## Purpose\s*$/m.test(raw)) {
    raw = raw.replace(
      /(# [^\n]+\n\n[^\n]+\n\n)/,
      "$1## Purpose\n\nSmoke-filled territory content for Minimum Territory Shape.\n\n"
    );
  }
  // Rename legacy ## Checklist to ## Atomic Ops when present.
  raw = raw.replace(/^## Checklist\s*$/m, "## Atomic Ops");
  fs.writeFileSync(filePath, raw);
}

function territoryPath(...parts) {
  return path.join(root, "mindplan", ...parts, "current.mdx");
}

function nextTerritoryPath(...parts) {
  return path.join(root, "mindplan", ...parts, "next.mdx");
}

// --- create nodes ---
const createdJourney = JSON.parse(
  await expectOk("create journey", "create_node", { id: "j-ordering", type: "Journey", title: "Ordering", description: "Diner orders food" })
);
if (!createdJourney.changed_files?.includes("mindplan/journeys/j-ordering/current.mdx") || !createdJourney.changed_files?.includes("mindplan/map.md")) {
  failures++; console.log(`FAIL create_node changed_files journey: ${JSON.stringify(createdJourney.changed_files)}`);
} else console.log("ok   create_node changed_files (journey)");
await expectOk("create foundation", "create_node", {
  id: "f-db",
  type: "Foundation",
  title: "Database schema",
  description: "Infra — Core tables",
  role: "infra",
});
const createdIx = JSON.parse(
  await expectOk("create interaction", "create_node", { id: "i-checkout", type: "Interaction", title: "Checkout", description: "Split & pay" })
);
if (
  !createdIx.changed_files?.includes("mindplan/interactions/i-checkout/current.mdx") ||
  createdIx.changed_files?.some((f) => String(f).includes("src/interactions/")) ||
  !createdIx.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL create_node changed_files interaction: ${JSON.stringify(createdIx.changed_files)}`);
} else console.log("ok   create_node changed_files (interaction)");
const ixFolder = path.join(root, "mindplan", "interactions", "i-checkout");
if (!fs.existsSync(path.join(ixFolder, "current.mdx"))) {
  failures++; console.log("FAIL entity folder scaffold");
} else console.log("ok   entity folder scaffold");
const mapPath = path.join(root, "mindplan", "map.md");
const mapAfterCreate = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, "utf-8") : "";
if (!mapAfterCreate.includes("```mermaid") || !mapAfterCreate.includes("i-checkout")) {
  failures++; console.log(`FAIL mindplan/map.md missing or stale after create_node: ${mapAfterCreate.slice(0, 200)}`);
} else console.log("ok   mindplan/map.md after create_node");
if (fs.existsSync(path.join(root, "mindplan", "mindplan.json"))) {
  failures++; console.log("FAIL mindplan.json must not exist");
} else console.log("ok   no mindplan.json");
const graphFromFm = JSON.parse(await expectOk("read graph from frontmatter", "get_mindplan_graph", {}));
const ixFromFm = graphFromFm.nodes.find((n) => n.id === "i-checkout");
if (ixFromFm?.title !== "Checkout" || ixFromFm?.description !== "Split & pay") {
  failures++; console.log(`FAIL node title/description from frontmatter: ${JSON.stringify(ixFromFm)}`);
} else console.log("ok   nodes discovered from frontmatter");
await expectBlocked("duplicate id", "create_node", { id: "i-checkout", type: "Interaction", title: "x", description: "y" });
{
  const { error, text } = await call("create_node", { id: "wf-legacy", type: "Workflow", title: "x", description: "y" });
  if (!error) {
    failures++; console.log(`FAIL Workflow type rejected: expected error, got ok -> ${text}`);
  } else console.log(`ok   Workflow type rejected -> ${text.slice(0, 120)}`);
}
// --- ghost interaction rule ---
await expectBlockedContaining("ghost interaction (no links)", "update_node_status", { node_id: "i-checkout", new_status: "ready" }, "Ghost Interaction");
await expectOk("link belongs_to", "link_nodes", { source_id: "i-checkout", target_id: "j-ordering", edge_type: "belongs_to" });
await expectBlockedContaining("ghost interaction (no foundation)", "update_node_status", { node_id: "i-checkout", new_status: "ready" }, "Ghost Interaction");
const linkedDepends = JSON.parse(
  await expectOk("link depends_on", "link_nodes", { source_id: "i-checkout", target_id: "f-db", edge_type: "depends_on" })
);
if (
  !linkedDepends.changed_files?.includes("mindplan/interactions/i-checkout/current.mdx") ||
  !linkedDepends.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL link_nodes changed_files: ${JSON.stringify(linkedDepends.changed_files)}`);
} else console.log("ok   link_nodes changed_files");
const mapAfterLink = fs.readFileSync(mapPath, "utf-8");
if (!mapAfterLink.includes("i_checkout") && !mapAfterLink.includes("i-checkout")) {
  failures++; console.log(`FAIL mindplan/map.md missing interaction after link: ${mapAfterLink.slice(0, 300)}`);
} else if (!mapAfterLink.includes("f-db") && !mapAfterLink.includes("f_db")) {
  failures++; console.log(`FAIL mindplan/map.md missing foundation after link: ${mapAfterLink.slice(0, 300)}`);
} else console.log("ok   mindplan/map.md refreshed after link_nodes");
const ixCtx = fs.readFileSync(path.join(ixFolder, "current.mdx"), "utf-8");
if (!ixCtx.includes("belongs_to:") || !ixCtx.includes("j-ordering") || !ixCtx.includes("depends_on:") || !ixCtx.includes("f-db")) {
  failures++; console.log("FAIL edges not persisted in i-checkout frontmatter");
} else console.log("ok   edges in frontmatter");
if (ixCtx.includes("## Affected Files")) {
  failures++; console.log("FAIL interaction scaffold still has removed ## Affected Files section");
} else console.log("ok   interaction scaffold has no affected files section");
const ixImplDir = path.join(root, "src", "interactions", "i-checkout");
const fImplDir = path.join(root, "src", "foundations", "f-db");
if (fs.existsSync(ixImplDir) || fs.existsSync(fImplDir)) {
  failures++; console.log("FAIL create_node must not scaffold src packages");
} else console.log("ok   create_node skips package scaffolds");
const jImplDir = path.join(root, "src", "journeys");
if (fs.existsSync(jImplDir)) {
  failures++; console.log("FAIL journey must not have implementation package tree");
} else console.log("ok   journey has no implementation package");

// Claim implementation files for pipeline nodes that will reach in-review/ship
fs.mkdirSync(ixImplDir, { recursive: true });
fs.mkdirSync(fImplDir, { recursive: true });
fs.writeFileSync(path.join(fImplDir, "schema.ts"), "export const tables = [];\n");
fs.writeFileSync(
  path.join(ixImplDir, "checkout.ts"),
  'import { tables } from "../../foundations/f-db/schema.js";\nexport const checkout = tables;\n'
);
await expectOk("set implements f-db", "set_implementation_files", {
  node_id: "f-db",
  files: ["src/foundations/f-db/"],
});
await expectOk("set implements i-checkout", "set_implementation_files", {
  node_id: "i-checkout",
  files: ["src/interactions/i-checkout/"],
});

// --- Interface + exposes / Ghost Interface ---
const createdIface = JSON.parse(
  await expectOk("create interface", "create_node", {
    id: "if-web",
    type: "Interface",
    title: "Web checkout",
    description: "Checkout page",
  })
);
if (
  !createdIface.changed_files?.includes("mindplan/interfaces/if-web/current.mdx") ||
  createdIface.changed_files?.some((f) => String(f).includes("src/interfaces/"))
) {
  failures++; console.log(`FAIL create_node changed_files interface: ${JSON.stringify(createdIface.changed_files)}`);
} else console.log("ok   create_node changed_files (interface)");
fs.mkdirSync(path.join(root, "src", "interfaces", "if-web"), { recursive: true });
fs.writeFileSync(
  path.join(root, "src", "interfaces", "if-web", "page.ts"),
  'import { checkout } from "../../interactions/i-checkout/checkout.js";\nexport const page = checkout;\n'
);
await expectOk("set implements if-web", "set_implementation_files", {
  node_id: "if-web",
  files: ["src/interfaces/if-web/"],
});
await expectBlockedContaining("ghost interface (no exposes)", "update_node_status", {
  node_id: "if-web", new_status: "ready",
}, "Ghost Interface");
await expectOk("link exposes", "link_nodes", {
  source_id: "if-web", target_id: "i-checkout", edge_type: "exposes",
});
await expectOk("link interface depends_on f-db", "link_nodes", {
  source_id: "if-web", target_id: "f-db", edge_type: "depends_on",
});
await expectBlockedContaining(
  "minimum territory shape (interface scaffold)",
  "update_node_status",
  { node_id: "if-web", new_status: "ready" },
  "Minimum Territory Shape"
);
fillMinimumTerritoryShape(territoryPath("interfaces", "if-web"));
await expectOk("interface -> ready", "update_node_status", { node_id: "if-web", new_status: "ready" });

// --- taxonomy: legal / illegal edge shapes ---
await expectBlocked("journey depends_on foundation", "link_nodes", { source_id: "j-ordering", target_id: "f-db", edge_type: "depends_on" });
await expectBlocked("foundation belongs_to journey", "link_nodes", { source_id: "f-db", target_id: "j-ordering", edge_type: "belongs_to" });
await expectBlocked("foundation exposes interaction", "link_nodes", {
  source_id: "f-db", target_id: "i-checkout", edge_type: "exposes",
});
await expectBlocked("leads_to to journey", "link_nodes", {
  source_id: "i-checkout", target_id: "j-ordering", edge_type: "leads_to",
});
await expectBlocked("interface leads_to interaction", "link_nodes", {
  source_id: "if-web", target_id: "i-checkout", edge_type: "leads_to",
});

await expectOk("create i-tips early for leads_to", "create_node", {
  id: "i-tips", type: "Interaction", title: "Tips", description: "Tipping flow",
});
await expectOk("link tips journey", "link_nodes", {
  source_id: "i-tips", target_id: "j-ordering", edge_type: "belongs_to",
});
await expectOk("link tips foundation", "link_nodes", {
  source_id: "i-tips", target_id: "f-db", edge_type: "depends_on",
});
await expectBlocked("interaction exposes interaction", "link_nodes", {
  source_id: "i-checkout", target_id: "i-tips", edge_type: "exposes",
});
await expectOk("leads_to checkout -> tips", "link_nodes", {
  source_id: "i-checkout", target_id: "i-tips", edge_type: "leads_to",
});
await expectOk("leads_to cycle tips -> checkout", "link_nodes", {
  source_id: "i-tips", target_id: "i-checkout", edge_type: "leads_to",
});
console.log("ok   leads_to cycles are allowed");

await expectBlockedContaining(
  "interaction independence",
  "link_nodes",
  { source_id: "i-tips", target_id: "i-checkout", edge_type: "depends_on" },
  "Interaction Independence"
);

// --- find_related_nodes ---
await expectBlocked("find_related_nodes requires query or node_id", "find_related_nodes", {});
await expectBlocked("find_related_nodes unknown node_id", "find_related_nodes", { node_id: "i-missing" });
const found = JSON.parse(
  await expectOk("find_related_nodes checkout", "find_related_nodes", { query: "checkout split" })
);
if (found.focus !== "i-checkout") {
  failures++; console.log(`FAIL find focus: expected i-checkout, got ${found.focus}`);
} else console.log("ok   find_related_nodes ranks checkout as focus");
const foundEdgeTypes = new Set((found.edges ?? []).map((e) => `${e.source}->${e.target}:${e.type}`));
if (
  !foundEdgeTypes.has("i-checkout->j-ordering:belongs_to") ||
  !foundEdgeTypes.has("i-checkout->f-db:depends_on")
) {
  failures++; console.log(`FAIL find neighborhood edges: ${JSON.stringify(found.edges)}`);
} else console.log("ok   find_related_nodes 1-hop edges");
const foundIds = new Set((found.nodes ?? []).map((n) => n.id));
if (!foundIds.has("i-checkout") || !foundIds.has("j-ordering") || !foundIds.has("f-db")) {
  failures++; console.log(`FAIL find neighborhood nodes: ${JSON.stringify(found.nodes)}`);
} else console.log("ok   find_related_nodes 1-hop nodes");
const forced = JSON.parse(
  await expectOk("find_related_nodes force node_id", "find_related_nodes", {
    query: "ordering",
    node_id: "i-checkout",
  })
);
if (forced.focus !== "i-checkout") {
  failures++; console.log(`FAIL forced focus: ${forced.focus}`);
} else console.log("ok   find_related_nodes forces focus via node_id");
const emptyFind = JSON.parse(
  await expectOk("find_related_nodes no match", "find_related_nodes", { query: "zzzz-no-such-feature" })
);
if (emptyFind.focus !== null || (emptyFind.matches?.length ?? 0) !== 0) {
  failures++; console.log(`FAIL empty find: ${JSON.stringify(emptyFind)}`);
} else console.log("ok   find_related_nodes empty matches");

await expectBlockedContaining(
  "minimum territory shape (interaction scaffold)",
  "update_node_status",
  { node_id: "i-checkout", new_status: "ready" },
  "Minimum Territory Shape"
);
fillMinimumTerritoryShape(territoryPath("interactions", "i-checkout"));
const ixReady = JSON.parse(
  await expectOk("interaction -> ready", "update_node_status", { node_id: "i-checkout", new_status: "ready" })
);
if (
  !ixReady.changed_files?.includes("mindplan/interactions/i-checkout/current.mdx") ||
  !ixReady.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL update_node_status changed_files: ${JSON.stringify(ixReady.changed_files)}`);
} else console.log("ok   update_node_status changed_files");

// --- export_mindplan_view ---
const viewFull = JSON.parse(await expectOk("export mermaid full", "export_mindplan_view", {}));
if (viewFull.format !== "mermaid" || typeof viewFull.diagram !== "string" || !viewFull.diagram.startsWith("flowchart TB")) {
  failures++; console.log(`FAIL export full mermaid: ${JSON.stringify(viewFull).slice(0, 200)}`);
} else console.log("ok   export_mindplan_view mermaid full");
if (!viewFull.diagram.includes("subgraph foundations") || !viewFull.diagram.includes("journey_j_ordering")) {
  failures++; console.log(`FAIL export missing clusters: ${viewFull.diagram.slice(0, 300)}`);
} else console.log("ok   export_mindplan_view clusters");
if (!viewFull.diagram.includes("subgraph interfaces") || !viewFull.diagram.includes("exposes")) {
  failures++; console.log(`FAIL export missing interfaces/exposes: ${viewFull.diagram.slice(0, 400)}`);
} else console.log("ok   export_mindplan_view interfaces + exposes");
const viewFocus = JSON.parse(
  await expectOk("export mermaid focus", "export_mindplan_view", { focus: "i-checkout" })
);
if (viewFocus.focus !== "i-checkout" || !viewFocus.diagram.includes("i_checkout")) {
  failures++; console.log(`FAIL export focus: ${JSON.stringify({ focus: viewFocus.focus, dig: viewFocus.diagram.slice(0, 200) })}`);
} else console.log("ok   export_mindplan_view focus");
const viewDot = JSON.parse(await expectOk("export dot", "export_mindplan_view", { format: "dot" }));
if (viewDot.format !== "dot" || !viewDot.diagram.startsWith("digraph MindPlan")) {
  failures++; console.log(`FAIL export dot: ${viewDot.diagram?.slice(0, 100)}`);
} else console.log("ok   export_mindplan_view dot");
await expectBlocked("export unknown focus", "export_mindplan_view", { focus: "i-missing" });

// --- journey computed states ---
await expectOk("interaction -> in-progress", "update_node_status", { node_id: "i-checkout", new_status: "in-progress" });
let graph = JSON.parse(await expectOk("read graph", "get_mindplan_graph", {}));
const journey = graph.nodes.find((n) => n.id === "j-ordering");
if (journey.state !== "incubation") { failures++; console.log(`FAIL journey state: expected incubation, got ${journey.state}`); }
else console.log("ok   journey computed as incubation");

await expectBlocked("manual journey state", "update_node_status", { node_id: "j-ordering", new_status: "stable" });

// --- open checklist while building + Completion Check at ship ---
const ixPath = path.join(root, "mindplan", "interactions", "i-checkout", "current.mdx");
{
  let ixRaw = fs.readFileSync(ixPath, "utf-8");
  ixRaw = ixRaw
    .replace("- [ ] Requirements defined", "- [x] Requirements defined")
    .replace("- [ ] Implementation complete", "- [x] Implementation complete");
  // leave "Tests passing" unchecked
  fs.writeFileSync(ixPath, ixRaw);
}
await expectBlockedContaining(
  "last checkbox while in-progress",
  "patch_node_territory",
  {
    node_id: "i-checkout",
    toggle_checkboxes: [{ contains: "Tests passing", checked: true }],
  },
  "Checklist Complete"
);
await expectOk("interaction -> in-review with unchecked", "update_node_status", {
  node_id: "i-checkout",
  new_status: "in-review",
});
await expectBlockedContaining(
  "completion check blocks ship with unchecked",
  "update_node_status",
  { node_id: "i-checkout", new_status: "ship" },
  "Completion Check"
);
await expectOk("complete last checkbox in-review", "patch_node_territory", {
  node_id: "i-checkout",
  toggle_checkboxes: [{ contains: "Tests passing", checked: true }],
});
fs.writeFileSync(
  ixPath,
  fs.readFileSync(ixPath, "utf-8") + '\n<StateBadge state="in-review" />\n'
);

// --- infrastructure first (ship requires stable foundations) ---
await expectBlockedContaining(
  "infrastructure first (foundation not shipped)",
  "update_node_status",
  { node_id: "i-checkout", new_status: "ship" },
  "Infrastructure First"
);
const fPath = path.join(root, "mindplan", "foundations", "f-db", "current.mdx");
fillMinimumTerritoryShape(fPath);
fs.writeFileSync(fPath, fs.readFileSync(fPath, "utf-8").replaceAll("[ ]", "[x]"));
for (const s of ["ready", "in-progress", "in-review"]) {
  await expectOk(`foundation -> ${s}`, "update_node_status", { node_id: "f-db", new_status: s });
}
await expectOk("foundation -> ship (stable)", "update_node_status", { node_id: "f-db", new_status: "ship" });

graph = JSON.parse(await expectOk("read graph after f-db ship", "get_mindplan_graph", {}));
const fDb = graph.nodes.find((n) => n.id === "f-db");
if (fDb.state !== "stable") { failures++; console.log(`FAIL f-db state: expected stable, got ${fDb.state}`); }
else console.log("ok   foundation shipped as stable");

await expectOk("interaction -> ship (stable)", "update_node_status", { node_id: "i-checkout", new_status: "ship" });

graph = JSON.parse(await expectOk("read graph after i-checkout ship", "get_mindplan_graph", {}));
const ix = graph.nodes.find((n) => n.id === "i-checkout");
const j2 = graph.nodes.find((n) => n.id === "j-ordering");
if (ix.state !== "stable") { failures++; console.log(`FAIL i-checkout state: expected stable, got ${ix.state}`); }
else console.log("ok   interaction shipped as stable");
if (j2.state !== "stable") { failures++; console.log(`FAIL journey state: expected stable, got ${j2.state}`); }
else console.log("ok   journey computed as stable");

const journeyBeforeBug = j2.state;

// --- Behavior First: Interface ship blocked until exposed Interaction is stable ---
await expectOk("create i-pending", "create_node", {
  id: "i-pending", type: "Interaction", title: "Pending", description: "Not shipped yet",
});
await expectOk("link pending journey", "link_nodes", {
  source_id: "i-pending", target_id: "j-ordering", edge_type: "belongs_to",
});
await expectOk("link pending foundation", "link_nodes", {
  source_id: "i-pending", target_id: "f-db", edge_type: "depends_on",
});
await expectOk("create if-pending", "create_node", {
  id: "if-pending", type: "Interface", title: "Pending UI", description: "Exposes pending",
});
await expectOk("link if-pending exposes", "link_nodes", {
  source_id: "if-pending", target_id: "i-pending", edge_type: "exposes",
});
await expectOk("link if-pending depends_on", "link_nodes", {
  source_id: "if-pending", target_id: "f-db", edge_type: "depends_on",
});
fillMinimumTerritoryShape(territoryPath("interfaces", "if-pending"));
fs.mkdirSync(path.join(root, "src", "interfaces", "if-pending"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "interfaces", "if-pending", "ui.ts"), "export {};\n");
await expectOk("set implements if-pending", "set_implementation_files", {
  node_id: "if-pending",
  files: ["src/interfaces/if-pending/"],
});

await expectOk("if-pending -> ready", "update_node_status", { node_id: "if-pending", new_status: "ready" });
await expectOk("if-pending -> in-progress", "update_node_status", { node_id: "if-pending", new_status: "in-progress" });
const ifPendingPath = path.join(root, "mindplan", "interfaces", "if-pending", "current.mdx");
fs.writeFileSync(ifPendingPath, fs.readFileSync(ifPendingPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("if-pending -> in-review", "update_node_status", { node_id: "if-pending", new_status: "in-review" });
await expectBlockedContaining(
  "behavior first (exposed interaction not stable)",
  "update_node_status",
  { node_id: "if-pending", new_status: "ship" },
  "Behavior First"
);
await expectOk("cancel if-pending after Behavior First gate", "update_node_status", {
  node_id: "if-pending", new_status: "cancelled",
});
await expectOk("cancel i-pending", "update_node_status", {
  node_id: "i-pending", new_status: "cancelled",
});

// Ship if-web after exposed i-checkout is stable (and foundation stable)
await expectOk("if-web -> in-progress", "update_node_status", { node_id: "if-web", new_status: "in-progress" });
const ifWebPath = path.join(root, "mindplan", "interfaces", "if-web", "current.mdx");
fs.writeFileSync(ifWebPath, fs.readFileSync(ifWebPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("if-web -> in-review", "update_node_status", { node_id: "if-web", new_status: "in-review" });
await expectOk("if-web -> ship", "update_node_status", { node_id: "if-web", new_status: "ship" });
graph = JSON.parse(await expectOk("read graph after if-web ship", "get_mindplan_graph", {}));
const ifWeb = graph.nodes.find((n) => n.id === "if-web");
if (ifWeb.state !== "stable") { failures++; console.log(`FAIL if-web state: expected stable, got ${ifWeb.state}`); }
else console.log("ok   interface shipped after Behavior First");

// --- bug: ghost bug + lifecycle + stability flip ---
await expectOk("create bug", "create_node", { id: "bug-race", type: "Bug", title: "Race condition", description: "Double charge" });
await expectBlocked("ghost bug (no affects)", "update_node_status", { node_id: "bug-race", new_status: "triaged" });
await expectOk("link affects interaction", "link_nodes", { source_id: "bug-race", target_id: "i-checkout", edge_type: "affects" });

graph = JSON.parse(await expectOk("read graph after affects link", "get_mindplan_graph", {}));
const ixAfterLink = graph.nodes.find((n) => n.id === "i-checkout");
if (ixAfterLink.state !== "unstable") { failures++; console.log(`FAIL interaction unstable on open bug link: got ${ixAfterLink.state}`); }
else console.log("ok   interaction unstable when open bug linked");

const jAfterBug = graph.nodes.find((n) => n.id === "j-ordering");
if (jAfterBug.state !== journeyBeforeBug) { failures++; console.log(`FAIL journey changed on bug link: ${journeyBeforeBug} -> ${jAfterBug.state}`); }
else console.log("ok   journey unchanged by bug activity");

await expectOk("bug -> triaged", "update_node_status", { node_id: "bug-race", new_status: "triaged" });
await expectOk("bug -> fixing", "update_node_status", { node_id: "bug-race", new_status: "fixing" });

const bugPath = path.join(root, "mindplan", "bugs", "bug-race", "current.mdx");
fillMinimumTerritoryShape(bugPath);
await expectOk("bug -> in-review with unchecked", "update_node_status", {
  node_id: "bug-race",
  new_status: "in-review",
});
await expectBlockedContaining(
  "bug completion check blocks resolved",
  "update_node_status",
  { node_id: "bug-race", new_status: "resolved" },
  "Completion Check"
);
fs.writeFileSync(bugPath, fs.readFileSync(bugPath, "utf-8").replaceAll("[ ]", "[x]"));
await expectOk("bug -> resolved", "update_node_status", { node_id: "bug-race", new_status: "resolved" });

graph = JSON.parse(await expectOk("read graph after bug resolved", "get_mindplan_graph", {}));
const viewHideClosed = JSON.parse(
  await expectOk("export hides closed bugs", "export_mindplan_view", { focus: "i-checkout" })
);
if (viewHideClosed.diagram.includes("bug-race") || viewHideClosed.diagram.includes("bug_race")) {
  failures++; console.log("FAIL export should hide resolved bug by default");
} else console.log("ok   export_mindplan_view hides closed bugs");
const viewShowClosed = JSON.parse(
  await expectOk("export include_retired", "export_mindplan_view", {
    focus: "i-checkout",
    include_retired: true,
  })
);
if (!viewShowClosed.diagram.includes("bug_race") && !viewShowClosed.diagram.includes("bug-race")) {
  failures++; console.log("FAIL export include_retired should show resolved bug");
} else console.log("ok   export_mindplan_view include_retired shows closed bugs");
const ixAfterFix = graph.nodes.find((n) => n.id === "i-checkout");
if (ixAfterFix.state !== "stable") { failures++; console.log(`FAIL interaction stable after bug resolved: got ${ixAfterFix.state}`); }
else console.log("ok   interaction stable after bug resolved");

// --- evolving: second in-progress interaction ---
fillMinimumTerritoryShape(territoryPath("interactions", "i-tips"));
await expectOk("i-tips -> ready", "update_node_status", { node_id: "i-tips", new_status: "ready" });
const res = JSON.parse(await expectOk("i-tips -> in-progress", "update_node_status", { node_id: "i-tips", new_status: "in-progress" }));
if (res.journeys_recomputed?.[0]?.state !== "evolving") { failures++; console.log(`FAIL journey evolving: ${JSON.stringify(res.journeys_recomputed)}`); }
else console.log("ok   journey computed as evolving");

await expectBlocked("skip to ship", "update_node_status", { node_id: "i-tips", new_status: "ship" });
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

// --- orient_for_work + reachability ---
await expectBlocked("orient_for_work requires query or node_id", "orient_for_work", {});
const oriented = JSON.parse(
  await expectOk("orient_for_work checkout", "orient_for_work", { query: "checkout" })
);
if (oriented.focus !== "i-checkout" || !oriented.context?.record?.id || oriented.context.record.id !== "i-checkout") {
  failures++; console.log(`FAIL orient_for_work context: ${JSON.stringify({ focus: oriented.focus, record: oriented.context?.record })}`);
} else console.log("ok   orient_for_work includes context record");
if (!oriented.blast_radius?.node_id || oriented.blast_radius.node_id !== "i-checkout") {
  failures++; console.log(`FAIL orient_for_work blast_radius: ${JSON.stringify(oriented.blast_radius)}`);
} else console.log("ok   orient_for_work includes blast_radius for interaction");
const orientReach = oriented.blast_radius?.reachability;
if (
  !orientReach?.exposing_interfaces?.some((n) => n.id === "if-web") ||
  !orientReach?.containing_journeys?.some((n) => n.id === "j-ordering") ||
  !orientReach?.leads_to_downstream?.some((n) => n.id === "i-tips")
) {
  failures++; console.log(`FAIL orient reachability: ${JSON.stringify(orientReach)}`);
} else console.log("ok   orient_for_work blast_radius includes reachability");

const blastIx = JSON.parse(
  await expectOk("get_blast_radius interaction reachability", "get_blast_radius", { node_id: "i-checkout" })
);
if (
  !blastIx.reachability?.exposing_interfaces?.some((n) => n.id === "if-web") ||
  !blastIx.reachability?.containing_journeys?.some((n) => n.id === "j-ordering") ||
  !blastIx.reachability?.leads_to_downstream?.some((n) => n.id === "i-tips" && n.distance === 1)
) {
  failures++; console.log(`FAIL get_blast_radius reachability: ${JSON.stringify(blastIx.reachability)}`);
} else console.log("ok   get_blast_radius includes Interaction reachability");

// --- patch_node_territory ---
await expectBlocked("patch_node_territory empty", "patch_node_territory", { node_id: "i-tips" });
const patchDesc = JSON.parse(
  await expectOk("patch interaction description", "patch_node_territory", {
    node_id: "i-tips",
    description: "Tipping flow (revised scope)",
  })
);
if (!patchDesc.patched_fields?.includes("description")) {
  failures++; console.log(`FAIL patch description fields: ${JSON.stringify(patchDesc)}`);
} else if (
  !patchDesc.path?.includes("i-tips") ||
  !patchDesc.changed_files?.includes(patchDesc.path)
) {
  failures++; console.log(`FAIL patch_node_territory path/changed_files: ${JSON.stringify(patchDesc)}`);
} else console.log("ok   patch_node_territory description");
graph = JSON.parse(await expectOk("read graph after description patch", "get_mindplan_graph", {}));
const tipsPatched = graph.nodes.find((n) => n.id === "i-tips");
if (tipsPatched?.description !== "Tipping flow (revised scope)") {
  failures++; console.log(`FAIL description not in graph: ${tipsPatched?.description}`);
} else console.log("ok   patched description visible in graph");
await expectBlocked("patch shipped interaction description", "patch_node_territory", {
  node_id: "i-checkout",
  description: "should not apply",
});
const tipsCtxPath = path.join(root, "mindplan", "interactions", "i-tips", "current.mdx");
const patchCheck = JSON.parse(
  await expectOk("patch toggle checkbox", "patch_node_territory", {
    node_id: "i-tips",
    toggle_checkboxes: [{ contains: "Requirements defined", checked: true }],
  })
);
if (!patchCheck.patched_fields?.includes("toggle_checkboxes")) {
  failures++; console.log(`FAIL patch checkbox fields: ${JSON.stringify(patchCheck)}`);
} else console.log("ok   patch_node_territory toggle_checkboxes");
const tipsAfterCheck = fs.readFileSync(tipsCtxPath, "utf-8");
if (!tipsAfterCheck.includes("- [x] Requirements defined")) {
  failures++; console.log("FAIL checkbox not toggled on disk");
} else console.log("ok   patch_node_territory persisted checkbox");

// --- implementation files ---
const ixImpl = JSON.parse(
  await expectOk("get_node_implementation interaction", "get_node_implementation", { node_id: "i-checkout" })
);
if (!Array.isArray(ixImpl.files) || !ixImpl.files.some((f) => String(f.path).includes("checkout.ts"))) {
  failures++; console.log(`FAIL interaction implementation: ${JSON.stringify(ixImpl)}`);
} else console.log("ok   get_node_implementation interaction");
const ifaceImpl = JSON.parse(
  await expectOk("get_node_implementation interface", "get_node_implementation", { node_id: "if-web" })
);
if (!Array.isArray(ifaceImpl.files) || ifaceImpl.files.length < 1) {
  failures++; console.log(`FAIL interface implementation: ${JSON.stringify(ifaceImpl)}`);
} else console.log("ok   get_node_implementation interface");
const fImpl = JSON.parse(
  await expectOk("get_node_implementation foundation", "get_node_implementation", { node_id: "f-db" })
);
if (!Array.isArray(fImpl.files) || !fImpl.files.some((f) => String(f.path).includes("schema.ts"))) {
  failures++; console.log(`FAIL foundation implementation: ${JSON.stringify(fImpl)}`);
} else console.log("ok   get_node_implementation foundation");
const pathLookup = JSON.parse(
  await expectOk("get_node_implementation path", "get_node_implementation", {
    path: "src/foundations/f-db/schema.ts",
  })
);
if (pathLookup.owner?.node_id !== "f-db") {
  failures++; console.log(`FAIL path lookup: ${JSON.stringify(pathLookup)}`);
} else console.log("ok   get_node_implementation path lookup");
const journeyImpl = JSON.parse(
  await expectOk("get_node_implementation journey", "get_node_implementation", { node_id: "j-ordering" })
);
if (!Array.isArray(journeyImpl.files)) {
  failures++; console.log(`FAIL journey rollup: ${JSON.stringify(journeyImpl)}`);
} else console.log("ok   get_node_implementation journey rollup");
const tipsCreate = JSON.parse(
  await expectOk("get tips implementation", "get_node_implementation", { node_id: "i-tips" })
);
if (!Array.isArray(tipsCreate.files)) {
  failures++; console.log(`FAIL tips implementation: ${JSON.stringify(tipsCreate)}`);
} else console.log("ok   i-tips implementation query");

// Claim files for later-created nodes before they ship
async function claimDir(nodeId, relDir, seedFile, contents = "export {};\n") {
  const abs = path.join(root, ...relDir.split("/"));
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, seedFile), contents);
  await expectOk(`set implements ${nodeId}`, "set_implementation_files", {
    node_id: nodeId,
    files: [`${relDir}/`],
  });
}
// --- link_dependent / Dependency Closure must not exist ---
{
  const { error, text } = await call("link_nodes", {
    source_id: "i-tips",
    target_id: "j-ordering",
    edge_type: "belongs_to",
    link_dependent: true,
  });
  // Already linked; either ignored extra arg + "already linked" style ok, or Blocked — but must NOT cascade dependents
  if (error && text.includes("Dependency Closure")) {
    failures++; console.log(`FAIL link_dependent/Dependency Closure must be removed: ${text}`);
  } else {
    console.log("ok   no Dependency Closure / link_dependent cascade");
  }
}

// Foundation depends_on cycle still rejected
await expectOk("create f-cache", "create_node", {
  id: "f-cache", type: "Foundation", title: "Cache", description: "Infra — cache", role: "infra",
});
await expectOk("link f-cache depends_on f-db", "link_nodes", {
  source_id: "f-cache", target_id: "f-db", edge_type: "depends_on",
});
await expectBlocked("depends_on cycle foundations", "link_nodes", {
  source_id: "f-db", target_id: "f-cache", edge_type: "depends_on",
});

// --- stable-id evolution (open_next / promote) ---
await expectBlocked("open_next on draft", "open_next", {
  node_id: "i-tips", title: "Tips v2", description: "v2",
});

const openNextRes = JSON.parse(await expectOk("open_next i-checkout", "open_next", {
  node_id: "i-checkout", title: "Checkout v2", description: "Revised checkout",
}));
if (openNextRes.next?.state !== "draft") {
  failures++; console.log(`FAIL open_next should create draft next: ${JSON.stringify(openNextRes.next)}`);
} else console.log("ok   open_next creates draft next slot");
if (
  !openNextRes.changed_files?.includes("mindplan/interactions/i-checkout/next.mdx") ||
  !openNextRes.changed_files?.includes("mindplan/interactions/i-checkout/next-attachments/.gitkeep") ||
  !openNextRes.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL open_next changed_files: ${JSON.stringify(openNextRes.changed_files)}`);
} else console.log("ok   open_next changed_files");

graph = JSON.parse(await expectOk("read graph after open_next", "get_mindplan_graph", {}));
const tipsLeadsAfterOpen = graph.edges.filter(
  (e) => e.source === "i-tips" && e.type === "leads_to" && e.target === "i-checkout"
);
if (tipsLeadsAfterOpen.length !== 1) {
  failures++; console.log(`FAIL i-tips should still leads_to i-checkout: ${JSON.stringify(tipsLeadsAfterOpen)}`);
} else console.log("ok   leads_to keep same id after open_next");

const blastWhileNext = JSON.parse(
  await expectOk("blast radius while next open", "get_blast_radius", { node_id: "i-checkout" })
);
if (!blastWhileNext.reachability?.exposing_interfaces?.some((n) => n.id === "if-web")) {
  failures++; console.log(`FAIL blast reachability while next open: ${JSON.stringify(blastWhileNext.reachability)}`);
} else console.log("ok   get_blast_radius reachability while next open");
if (blastWhileNext.via_supersedes !== undefined) {
  failures++; console.log(`FAIL via_supersedes should be removed: ${JSON.stringify(blastWhileNext.via_supersedes)}`);
} else console.log("ok   get_blast_radius has no via_supersedes");

const ixCheckoutLive = graph.nodes.find((n) => n.id === "i-checkout");
if (ixCheckoutLive.state !== "stable" || ixCheckoutLive.next?.state !== "draft") {
  failures++; console.log(`FAIL live should stay stable with draft next: ${JSON.stringify(ixCheckoutLive)}`);
} else console.log("ok   live stays stable after open_next");

const nextPath = path.join(root, "mindplan", "interactions", "i-checkout", "next.mdx");
const nextCtx = fs.readFileSync(nextPath, "utf-8");
if (!nextCtx.includes("state: draft") || !nextCtx.includes("belongs_to:") || !nextCtx.includes("depends_on:")) {
  failures++; console.log("FAIL next.mdx missing draft state or inherited edges");
} else console.log("ok   next.mdx inherits edges and starts draft");
if (!nextCtx.includes("implements:") || !ixCheckoutLive.implements?.includes("src/interactions/i-checkout/")) {
  failures++; console.log(`FAIL open_next should copy implements: ${JSON.stringify(ixCheckoutLive.implements)}`);
} else console.log("ok   open_next copies implements to next");

await expectOk("set implements i-checkout next", "set_implementation_files", {
  node_id: "i-checkout",
  files: ["src/interactions/i-checkout/", "src/interactions/i-checkout/extra.ts"],
  slot: "next",
});
fs.writeFileSync(path.join(root, "src", "interactions", "i-checkout", "extra.ts"), "export {};\n");

await expectBlocked("open_next twice", "open_next", {
  node_id: "i-checkout", title: "Checkout v3", description: "v3",
});

// Sibling interaction can still ship against live foundations while next is draft.
const tipsPath = path.join(root, "mindplan", "interactions", "i-tips", "current.mdx");
fs.writeFileSync(tipsPath, fs.readFileSync(tipsPath, "utf-8").replaceAll("[ ]", "[x]"));
fs.mkdirSync(path.join(root, "src", "interactions", "i-tips"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "interactions", "i-tips", "tips.ts"), "export {};\n");
await expectOk("set implements i-tips", "set_implementation_files", {
  node_id: "i-tips",
  files: ["src/interactions/i-tips/"],
});
await expectOk("i-tips -> in-review while next draft", "update_node_status", {
  node_id: "i-tips", new_status: "in-review",
});
await expectOk("i-tips -> ship while next draft", "update_node_status", {
  node_id: "i-tips", new_status: "ship",
});
console.log("ok   sibling interaction can ship while next evolution is still draft");

// Foundation reverse-depends_on blast radius (transitive Foundation chain + journeys_at_risk)
await expectOk("create f-a", "create_node", { id: "f-a", type: "Foundation", title: "A", description: "Infra — base", role: "infra" });
await expectOk("create f-b", "create_node", { id: "f-b", type: "Foundation", title: "B", description: "Infra — mid", role: "infra" });
await expectOk("create f-c", "create_node", { id: "f-c", type: "Foundation", title: "C", description: "Infra — top", role: "infra" });
await expectOk("link f-b depends_on f-a", "link_nodes", { source_id: "f-b", target_id: "f-a", edge_type: "depends_on" });
await expectOk("link f-c depends_on f-b", "link_nodes", { source_id: "f-c", target_id: "f-b", edge_type: "depends_on" });
await expectOk("create i-on-a", "create_node", {
  id: "i-on-a", type: "Interaction", title: "On A", description: "uses f-a",
});
await expectOk("link i-on-a journey", "link_nodes", {
  source_id: "i-on-a", target_id: "j-ordering", edge_type: "belongs_to",
});
await expectOk("link i-on-a f-a", "link_nodes", {
  source_id: "i-on-a", target_id: "f-a", edge_type: "depends_on",
});

const radius = JSON.parse(await expectOk("get_blast_radius f-a", "get_blast_radius", { node_id: "f-a" }));
const fB = radius.affected?.find((a) => a.id === "f-b");
const fC = radius.affected?.find((a) => a.id === "f-c");
const iOnA = radius.affected?.find((a) => a.id === "i-on-a");
if (!fB || fB.distance !== 1 || !fC || fC.distance !== 2 || !iOnA || iOnA.distance !== 1) {
  failures++; console.log(`FAIL blast radius distances: ${JSON.stringify(radius.affected)}`);
} else console.log("ok   get_blast_radius transitive distances");
if (!radius.journeys_at_risk?.includes("j-ordering")) {
  failures++; console.log(`FAIL journeys_at_risk: ${JSON.stringify(radius.journeys_at_risk)}`);
} else console.log("ok   get_blast_radius journeys_at_risk");

await expectOk("i-checkout next -> ready", "update_node_status", { node_id: "i-checkout", new_status: "ready" });
await expectOk("i-checkout next -> in-progress", "update_node_status", { node_id: "i-checkout", new_status: "in-progress" });
fs.writeFileSync(nextPath, fs.readFileSync(nextPath, "utf-8").replaceAll("[ ]", "[x]"));
const nextAttNote = path.join(root, "mindplan", "interactions", "i-checkout", "next-attachments", "note.txt");
fs.writeFileSync(nextAttNote, "promote me");
await expectOk("i-checkout next -> in-review", "update_node_status", { node_id: "i-checkout", new_status: "in-review" });

graph = JSON.parse(await expectOk("read graph before promote", "get_mindplan_graph", {}));
const beforePromote = graph.nodes.find((n) => n.id === "i-checkout");
if (beforePromote.state !== "stable" || beforePromote.next?.state !== "in-review") {
  failures++; console.log(`FAIL before promote: ${JSON.stringify(beforePromote)}`);
} else console.log("ok   live still stable with next in-review before ship");

const shipNext = JSON.parse(await expectOk("i-checkout ship promotes next", "update_node_status", { node_id: "i-checkout", new_status: "ship" }));
if (!shipNext.promoted_next) {
  failures++; console.log(`FAIL promoted_next missing: ${JSON.stringify(shipNext)}`);
} else console.log("ok   ship promotes next over current");
if (shipNext.new_state !== "stable") {
  failures++; console.log(`FAIL after promote state: ${shipNext.new_state}`);
} else console.log("ok   promoted node is stable");
if (
  !shipNext.changed_files?.includes("mindplan/interactions/i-checkout/current.mdx") ||
  !shipNext.changed_files?.includes("mindplan/interactions/i-checkout/next.mdx") ||
  !shipNext.changed_files?.includes("mindplan/interactions/i-checkout/next-attachments") ||
  !shipNext.changed_files?.includes("mindplan/interactions/i-checkout/next-attachments/note.txt") ||
  !shipNext.changed_files?.includes("mindplan/interactions/i-checkout/attachments/note.txt") ||
  !shipNext.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL promote changed_files: ${JSON.stringify(shipNext.changed_files)}`);
} else console.log("ok   promote changed_files includes attachments");
const promotedAtt = path.join(root, "mindplan", "interactions", "i-checkout", "attachments", "note.txt");
if (!fs.existsSync(promotedAtt)) {
  failures++; console.log("FAIL promote should copy next-attachments/note.txt into attachments/");
} else console.log("ok   promote copied next-attachment into attachments/");

if (fs.existsSync(nextPath)) {
  failures++; console.log("FAIL next.mdx should be deleted after promote");
} else console.log("ok   next.mdx removed after promote");

const currentAfter = fs.readFileSync(path.join(root, "mindplan", "interactions", "i-checkout", "current.mdx"), "utf-8");
if (!currentAfter.includes("Checkout v2") || !currentAfter.includes("Revised checkout")) {
  failures++; console.log("FAIL current.mdx should carry promoted title/description");
} else console.log("ok   current.mdx updated from next on promote");

graph = JSON.parse(await expectOk("read graph after promote", "get_mindplan_graph", {}));
const afterPromote = graph.nodes.find((n) => n.id === "i-checkout");
if (afterPromote.next) {
  failures++; console.log(`FAIL next should be gone after promote: ${JSON.stringify(afterPromote.next)}`);
} else console.log("ok   no next slot after promote");
if (
  !afterPromote.implements?.includes("src/interactions/i-checkout/") ||
  !afterPromote.implements?.includes("src/interactions/i-checkout/extra.ts") ||
  !currentAfter.includes("implements:") ||
  !currentAfter.includes("src/interactions/i-checkout/extra.ts")
) {
  failures++; console.log(`FAIL promote must keep implements: ${JSON.stringify(afterPromote.implements)}`);
} else console.log("ok   promote keeps implements on current");
const tipsLeadsAfterPromote = graph.edges.filter(
  (e) => e.source === "i-tips" && e.type === "leads_to" && e.target === "i-checkout"
);
if (tipsLeadsAfterPromote.length !== 1) {
  failures++; console.log(`FAIL i-tips should still leads_to once on i-checkout: ${JSON.stringify(tipsLeadsAfterPromote)}`);
} else console.log("ok   leads_to unchanged after promote (stable id)");

// discard_next path
const openForDiscard = JSON.parse(await expectOk("open_next again for discard", "open_next", { node_id: "i-checkout" }));
const discardRes = JSON.parse(await expectOk("discard_next", "discard_next", { node_id: "i-checkout" }));
if (fs.existsSync(nextPath)) {
  failures++; console.log("FAIL next.mdx should be gone after discard");
} else console.log("ok   discard_next removes next.mdx");
if (
  !discardRes.changed_files?.includes("mindplan/interactions/i-checkout/next.mdx") ||
  !discardRes.changed_files?.includes("mindplan/interactions/i-checkout/next-attachments") ||
  !discardRes.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL discard_next changed_files: ${JSON.stringify(discardRes.changed_files)}`);
} else console.log("ok   discard_next changed_files");
void openForDiscard;

// --- force_unship (mistaken ship recovery) ---
await expectBlocked("force_unship wrong confirm", "force_unship", {
  node_id: "i-tips",
  confirm: "nope",
});
await expectBlocked("force_unship mismatched token", "force_unship", {
  node_id: "i-tips",
  confirm: "unship:i-checkout",
});

await expectOk("open_next before force_unship gate", "open_next", { node_id: "i-tips" });
await expectBlocked("force_unship while next open", "force_unship", {
  node_id: "i-tips",
  confirm: "unship:i-tips",
});
await expectOk("discard_next before force_unship", "discard_next", { node_id: "i-tips" });

await expectBlocked("force_unship with shipped dependents", "force_unship", {
  node_id: "f-db",
  confirm: "unship:f-db",
});

const unshipRes = JSON.parse(
  await expectOk("force_unship i-tips to ready", "force_unship", {
    node_id: "i-tips",
    confirm: "unship:i-tips",
    new_status: "ready",
  })
);
if (unshipRes.new_state !== "ready" || unshipRes.shipped_at !== null) {
  failures++;
  console.log(`FAIL force_unship result: ${JSON.stringify(unshipRes)}`);
} else console.log("ok   force_unship returns ready and cleared shipped_at");
if (!unshipRes.changed_files?.includes("mindplan/interactions/i-tips/current.mdx")) {
  failures++;
  console.log(`FAIL force_unship changed_files: ${JSON.stringify(unshipRes.changed_files)}`);
} else console.log("ok   force_unship changed_files");

graph = JSON.parse(await expectOk("read graph after force_unship", "get_mindplan_graph", {}));
const tipsUnshipped = graph.nodes.find((n) => n.id === "i-tips");
if (tipsUnshipped.state !== "ready" || tipsUnshipped.shipped_at) {
  failures++;
  console.log(`FAIL i-tips after force_unship: ${JSON.stringify(tipsUnshipped)}`);
} else console.log("ok   force_unship cleared production posture on disk/graph");

const tipsFm = fs.readFileSync(tipsPath, "utf-8");
if (/^shipped_at:/m.test(tipsFm) || !/^state: ready$/m.test(tipsFm)) {
  failures++;
  console.log("FAIL i-tips current.mdx should be ready without shipped_at");
} else console.log("ok   force_unship removed shipped_at from frontmatter");

await expectBlocked("stable to ready still blocked on update_node_status", "update_node_status", {
  node_id: "i-checkout",
  new_status: "ready",
});

// --- cancelled (pre-ship abandon) ---
await expectOk("create f-deadend", "create_node", {
  id: "f-deadend",
  type: "Foundation",
  title: "Dead end",
  description: "Infra — Abandoned before ship",
  role: "infra",
});
fillMinimumTerritoryShape(territoryPath("foundations", "f-deadend"));
await expectOk("f-deadend -> ready", "update_node_status", {
  node_id: "f-deadend",
  new_status: "ready",
});
await expectOk("f-deadend -> in-progress", "update_node_status", {
  node_id: "f-deadend",
  new_status: "in-progress",
});
await expectOk("create i-depends-deadend", "create_node", {
  id: "i-depends-deadend",
  type: "Interaction",
  title: "Depends on deadend",
  description: "Blocks cancel",
});
await expectOk("link depends-deadend belongs_to", "link_nodes", {
  source_id: "i-depends-deadend",
  target_id: "j-ordering",
  edge_type: "belongs_to",
});
await expectOk("link depends-deadend -> f-db", "link_nodes", {
  source_id: "i-depends-deadend",
  target_id: "f-db",
  edge_type: "depends_on",
});
await expectOk("link depends-deadend -> f-deadend", "link_nodes", {
  source_id: "i-depends-deadend",
  target_id: "f-deadend",
  edge_type: "depends_on",
});
await expectBlocked("cancel blocked by active dependent", "update_node_status", {
  node_id: "f-deadend",
  new_status: "cancelled",
});
await expectOk("cancel the dependent first", "update_node_status", {
  node_id: "i-depends-deadend",
  new_status: "cancelled",
});
await expectOk("cancel f-deadend", "update_node_status", {
  node_id: "f-deadend",
  new_status: "cancelled",
});
await expectBlocked("cancelled is terminal", "update_node_status", {
  node_id: "f-deadend",
  new_status: "draft",
});
await expectBlocked("cannot cancel shipped i-checkout", "update_node_status", {
  node_id: "i-checkout",
  new_status: "cancelled",
});

// cancel blocked by next.depends_on on a shipped peer (target is still pre-ship)
await expectOk("create f-needed", "create_node", {
  id: "f-needed",
  type: "Foundation",
  title: "Needed",
  description: "Infra — required by next evolution",
  role: "infra",
});
fillMinimumTerritoryShape(territoryPath("foundations", "f-needed"));
await expectOk("f-needed -> ready", "update_node_status", {
  node_id: "f-needed",
  new_status: "ready",
});
await expectOk("open_next i-checkout for next depends_on", "open_next", {
  node_id: "i-checkout",
});
await expectOk("link next depends_on f-needed", "link_nodes", {
  source_id: "i-checkout",
  target_id: "f-needed",
  edge_type: "depends_on",
});
await expectBlocked("cancel blocked by next depends_on", "update_node_status", {
  node_id: "f-needed",
  new_status: "cancelled",
});
await expectOk("discard_next after next-depends cancel gate", "discard_next", {
  node_id: "i-checkout",
});
await expectOk("cancel f-needed after discard_next", "update_node_status", {
  node_id: "f-needed",
  new_status: "cancelled",
});

// --- next-slot depends_on cycle (Foundations) + corrupt frontmatter + bug retreat ---
async function shipFoundation(id, title) {
  await expectOk(`create ${id}`, "create_node", {
    id,
    type: "Foundation",
    title,
    description: `Infra — ${title} for cycle smoke`,
    role: "infra",
  });
  fillMinimumTerritoryShape(territoryPath("foundations", id));
  const pkg = path.join(root, "src", "foundations", id);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "index.ts"), "export {};\n");
  await expectOk(`set implements ${id}`, "set_implementation_files", {
    node_id: id,
    files: [`src/foundations/${id}/`],
  });
  await expectOk(`${id} -> ready`, "update_node_status", { node_id: id, new_status: "ready" });
  await expectOk(`${id} -> in-progress`, "update_node_status", {
    node_id: id,
    new_status: "in-progress",
  });
  const p = path.join(root, "mindplan", "foundations", id, "current.mdx");
  fs.writeFileSync(p, fs.readFileSync(p, "utf-8").replaceAll("[ ]", "[x]"));
  await expectOk(`${id} -> in-review`, "update_node_status", {
    node_id: id,
    new_status: "in-review",
  });
  await expectOk(`${id} -> ship`, "update_node_status", { node_id: id, new_status: "ship" });
}
await shipFoundation("f-cyc-a", "Cycle A");
await shipFoundation("f-cyc-b", "Cycle B");
await expectOk("open_next f-cyc-a", "open_next", { node_id: "f-cyc-a" });
await expectOk("open_next f-cyc-b", "open_next", { node_id: "f-cyc-b" });
await expectOk("link f-cyc-a next depends_on f-cyc-b", "link_nodes", {
  source_id: "f-cyc-a",
  target_id: "f-cyc-b",
  edge_type: "depends_on",
});
await expectBlocked("next depends_on cycle", "link_nodes", {
  source_id: "f-cyc-b",
  target_id: "f-cyc-a",
  edge_type: "depends_on",
});
await expectOk("discard_next f-cyc-a", "discard_next", { node_id: "f-cyc-a" });
await expectOk("discard_next f-cyc-b", "discard_next", { node_id: "f-cyc-b" });

const corruptPath = path.join(root, "mindplan", "interactions", "i-tips", "current.mdx");
const corruptRaw = fs.readFileSync(corruptPath, "utf-8");
fs.writeFileSync(corruptPath, corruptRaw.replace(/^---\r?\n[\s\S]*?\r?\n---/, "# no frontmatter\n"));
await expectBlocked("corrupt frontmatter status", "update_node_status", {
  node_id: "i-tips",
  new_status: "in-progress",
});
fs.writeFileSync(corruptPath, corruptRaw);

await expectOk("create bug-retreat", "create_node", {
  id: "bug-retreat",
  type: "Bug",
  title: "Retreat smoke",
  description: "covers fixing -> open",
});
await expectOk("link bug-retreat affects", "link_nodes", {
  source_id: "bug-retreat",
  target_id: "f-cyc-a",
  edge_type: "affects",
});
await expectOk("bug-retreat -> triaged", "update_node_status", {
  node_id: "bug-retreat",
  new_status: "triaged",
});
await expectOk("bug-retreat -> fixing", "update_node_status", {
  node_id: "bug-retreat",
  new_status: "fixing",
});
await expectOk("bug-retreat fixing -> open", "update_node_status", {
  node_id: "bug-retreat",
  new_status: "open",
});

const viewNoRetired = JSON.parse(
  await expectOk("view hides cancelled", "export_mindplan_view", { format: "mermaid" })
);
if (viewNoRetired.diagram.includes("f-deadend")) {
  failures++;
  console.log("FAIL cancelled node should be hidden from default view");
} else console.log("ok   cancelled hidden from default view");
const viewRetired = JSON.parse(
  await expectOk("view include_retired shows cancelled", "export_mindplan_view", {
    format: "mermaid",
    include_retired: true,
  })
);
if (!viewRetired.diagram.includes("f-deadend")) {
  failures++;
  console.log("FAIL include_retired should show cancelled node");
} else console.log("ok   include_retired shows cancelled");

// --- CLI init resolves package templates from nested dist layout ---
const initRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-"));
const { spawnSync } = await import("child_process");
const initResult = spawnSync(process.execPath, [serverEntry, "init"], {
  cwd: initRoot,
  env: { ...process.env, MINDPLAN_ROOT: initRoot },
  encoding: "utf-8",
});
if (initResult.status !== 0) {
  failures++;
  console.log(`FAIL mindplan-mcp init exit ${initResult.status}: ${initResult.stderr || initResult.stdout}`);
} else if (!fs.existsSync(path.join(initRoot, "mindplan", "agent", "playbook.md"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install playbook (packageRoot likely wrong)");
} else if (!fs.existsSync(path.join(initRoot, "AGENTS.md"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install AGENTS.md");
} else if (!fs.existsSync(path.join(initRoot, ".cursorignore"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install .cursorignore");
} else if (
  (() => {
    const ignore = fs.readFileSync(path.join(initRoot, ".cursorignore"), "utf-8");
    return ignore.includes("current.mdx") || ignore.includes("next.mdx") || !ignore.includes("mindplan/map.md");
  })()
) {
  failures++;
  console.log("FAIL .cursorignore must ignore map.md only (not current.mdx/next.mdx)");
} else if (!fs.existsSync(path.join(initRoot, ".cursor", "permissions.json"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install .cursor/permissions.json");
} else if (
  (() => {
    const perms = fs.readFileSync(path.join(initRoot, ".cursor", "permissions.json"), "utf-8");
    return !perms.includes("mindplan:*");
  })()
) {
  failures++;
  console.log("FAIL .cursor/permissions.json must allowlist mindplan:*");
} else if (!fs.existsSync(path.join(initRoot, "mindplan", "agent", "integrations", "codex.md"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install Codex integration guide");
} else if (!fs.existsSync(path.join(initRoot, "mindplan", "agent", "skills", "plan-project", "SKILL.md"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install plan-project skill");
} else if (!fs.existsSync(path.join(initRoot, "mindplan", "agent", "skills", "review-work", "SKILL.md"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install review-work skill");
} else if (!fs.existsSync(path.join(initRoot, "mindplan", "agent", "skills", "code-review", "SKILL.md"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install code-review skill");
} else if (
  !fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-define-entities", "SKILL.md")) ||
  !fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-plan-project", "SKILL.md")) ||
  !fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-review-work", "SKILL.md")) ||
  !fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-code-review", "SKILL.md"))
) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install Cursor skills under .cursor/skills/");
} else if (!fs.existsSync(path.join(initRoot, ".cursor", "rules", "mindplan.mdc"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install .cursor/rules/mindplan.mdc");
} else if (
  (() => {
    const rule = fs.readFileSync(path.join(initRoot, ".cursor", "rules", "mindplan.mdc"), "utf-8");
    return !rule.includes("alwaysApply: true") || !rule.includes("MindPlan Agent Playbook");
  })()
) {
  failures++;
  console.log("FAIL .cursor/rules/mindplan.mdc must include alwaysApply frontmatter and playbook body");
} else if (
  (() => {
    const cfgPath = path.join(initRoot, "mindplan", "config.json");
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return !Array.isArray(cfg.sources) || !("exclude" in cfg);
  })()
) {
  failures++;
  console.log("FAIL mindplan-mcp init should write { sources, exclude } by default");
} else {
  console.log("ok   mindplan-mcp init installs templates from package root");
}

const layoutReject = spawnSync(process.execPath, [serverEntry, "init", "--layout", "free"], {
  cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-layout-")),
  encoding: "utf-8",
});
if (layoutReject.status === 0 || !(layoutReject.stderr || "").includes("--layout")) {
  failures++;
  console.log(`FAIL --layout should be rejected: ${layoutReject.stderr || layoutReject.stdout}`);
} else console.log("ok   --layout is rejected");

// Migrate legacy implementation_packages
const migrateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-migrate-"));
fs.mkdirSync(path.join(migrateRoot, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(migrateRoot, "mindplan", "config.json"),
  JSON.stringify({ implementation_packages: "required" }, null, 2) + "\n"
);
const migrateInit = spawnSync(process.execPath, [serverEntry, "init"], {
  cwd: migrateRoot,
  env: { ...process.env, MINDPLAN_ROOT: migrateRoot },
  encoding: "utf-8",
});
if (migrateInit.status !== 0) {
  failures++;
  console.log(`FAIL init migration exit ${migrateInit.status}: ${migrateInit.stderr || migrateInit.stdout}`);
} else {
  const cfg = JSON.parse(fs.readFileSync(path.join(migrateRoot, "mindplan", "config.json"), "utf-8"));
  if (!Array.isArray(cfg.sources) || cfg.sources[0] !== "src/**") {
    failures++;
    console.log(`FAIL migration sources: ${JSON.stringify(cfg)}`);
  } else console.log("ok   init migrates implementation_packages → sources");
}

// init -f / --force: overwrite mutated agent assets; preserve sources config
{
  const forceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-force-"));
  const forceEnv = { ...process.env, MINDPLAN_ROOT: forceRoot };
  const first = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: forceRoot,
    env: forceEnv,
    encoding: "utf-8",
  });
  if (first.status !== 0) {
    failures++;
    console.log(`FAIL init (force suite) exit ${first.status}: ${first.stderr || first.stdout}`);
  } else {
    const playbookPath = path.join(forceRoot, "mindplan", "agent", "playbook.md");
    const marker = "FORCE_OVERWRITE_MARKER_DO_NOT_SHIP";
    fs.writeFileSync(playbookPath, marker, "utf-8");
    // Widen sources to prove -f does not overwrite config
    fs.writeFileSync(
      path.join(forceRoot, "mindplan", "config.json"),
      JSON.stringify({ sources: ["app/**"], exclude: ["app/**/*.test.ts"] }, null, 2) + "\n"
    );

    const bare = spawnSync(process.execPath, [serverEntry, "init"], {
      cwd: forceRoot,
      env: forceEnv,
      encoding: "utf-8",
    });
    if (bare.status !== 0) {
      failures++;
      console.log(`FAIL bare init (force suite) exit ${bare.status}: ${bare.stderr || bare.stdout}`);
    } else if (fs.readFileSync(playbookPath, "utf-8") !== marker) {
      failures++;
      console.log("FAIL bare init must not overwrite existing playbook");
    } else {
      console.log("ok   bare init leaves mutated playbook");
    }

    const forced = spawnSync(process.execPath, [serverEntry, "init", "-f"], {
      cwd: forceRoot,
      env: forceEnv,
      encoding: "utf-8",
    });
    if (forced.status !== 0) {
      failures++;
      console.log(`FAIL init -f exit ${forced.status}: ${forced.stderr || forced.stdout}`);
    } else {
      const restored = fs.readFileSync(playbookPath, "utf-8");
      if (restored === marker || !restored.includes("MindPlan Agent Playbook")) {
        failures++;
        console.log("FAIL init -f must restore playbook from package templates");
      } else {
        console.log("ok   init -f overwrites mutated playbook from templates");
      }
      const cfg = JSON.parse(fs.readFileSync(path.join(forceRoot, "mindplan", "config.json"), "utf-8"));
      if (cfg.sources?.[0] !== "app/**") {
        failures++;
        console.log(`FAIL init -f must preserve sources config: ${JSON.stringify(cfg)}`);
      } else {
        console.log("ok   init -f preserves existing sources config");
      }
    }

    fs.writeFileSync(playbookPath, marker, "utf-8");
    const forcedLong = spawnSync(process.execPath, [serverEntry, "init", "--force"], {
      cwd: forceRoot,
      env: forceEnv,
      encoding: "utf-8",
    });
    if (forcedLong.status !== 0) {
      failures++;
      console.log(`FAIL init --force exit ${forcedLong.status}: ${forcedLong.stderr || forcedLong.stdout}`);
    } else if (fs.readFileSync(playbookPath, "utf-8") === marker) {
      failures++;
      console.log("FAIL init --force must overwrite mutated playbook");
    } else {
      console.log("ok   init --force overwrites mutated playbook");
    }
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
