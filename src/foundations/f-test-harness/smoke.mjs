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

// --- server instructions are a short reanchor pointer (initialize) ---
{
  const expectedInstructions =
    "Before answering any questions or writing any code for this project, call get_project and read the response. " +
    "Follow the playbook (systems dialect) and the project description and rules it returns. " +
    "Project rules are mandatory: before each action, call get_rules then orient_for_work. " +
    "Before any new-feature code change, update or create the matching nodes using the plan-project skill.";
  const instructions = client.getInstructions();
  if (instructions !== expectedInstructions) {
    failures++;
    console.log(
      `FAIL MCP initialize instructions must be the short reanchor pointer (got ${instructions === undefined ? "undefined" : `${instructions.length} chars`})`
    );
  } else console.log("ok   MCP initialize instructions are the short reanchor pointer");
  const bundledPlaybook = fs.readFileSync(path.join(toolRoot, "templates", "agent", "playbook.md"), "utf-8");
  if (
    !bundledPlaybook.includes("get_project.playbook") ||
    !bundledPlaybook.includes("get_rules") ||
    !bundledPlaybook.includes("plan-project") ||
    !bundledPlaybook.includes("When the implementation is done and a merge is requested, `ship` the node")
  ) {
    failures++;
    console.log("FAIL playbook must mention get_rules, plan-project, and ship-on-merge handoff");
  } else console.log("ok   playbook mentions get_rules and plan-project");
  const playbookLines = bundledPlaybook.split("\n").length;
  if (playbookLines > 60) {
    failures++;
    console.log(`FAIL playbook should stay one screen (${playbookLines} lines)`);
  } else console.log("ok   playbook is one screen");
  for (const banned of ["base_sha", "Verdict:", "Atomic Op", "mindplan-mcp check", "Plan Reviewer"]) {
    if (bundledPlaybook.includes(banned)) {
      failures++;
      console.log(`FAIL playbook must not contain review/checklist procedure text: "${banned}"`);
    }
  }
}
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
  const id = parts[parts.length - 1];
  return path.join(root, "mindplan", ...parts, `${id}.mdx`);
}

function nextTerritoryPath(...parts) {
  const id = parts[parts.length - 1];
  return path.join(root, "mindplan", ...parts, `${id}.next.mdx`);
}

// --- get_project (empty brief + bundled playbook in sandbox) ---
{
  const bundledPlaybook = fs.readFileSync(path.join(toolRoot, "templates", "agent", "playbook.md"), "utf-8");
  const gp = await call("get_project", {});
  if (gp.error) {
    failures++;
    console.log(`FAIL get_project: ${gp.text}`);
  } else {
    let payload;
    try {
      payload = JSON.parse(gp.text);
    } catch {
      payload = null;
    }
    if (
      !payload ||
      payload.path !== "mindplan/project.md" ||
      payload.description !== "" ||
      payload.rules !== "" ||
      payload.playbook !== bundledPlaybook
    ) {
      failures++;
      console.log(`FAIL get_project shape (empty brief + playbook): ${gp.text.slice(0, 200)}`);
    } else console.log("ok   get_project returns empty brief + bundled playbook");
  }
}

// --- get_rules (mandatory rules only) ---
{
  const gr = await call("get_rules", {});
  if (gr.error) {
    failures++;
    console.log(`FAIL get_rules: ${gr.text}`);
  } else {
    let payload;
    try {
      payload = JSON.parse(gr.text);
    } catch {
      payload = null;
    }
    if (
      !payload ||
      payload.path !== "mindplan/project.md" ||
      typeof payload.rules !== "string" ||
      "playbook" in payload ||
      "description" in payload
    ) {
      failures++;
      console.log(`FAIL get_rules shape: ${gr.text.slice(0, 200)}`);
    } else console.log("ok   get_rules returns path and rules only");
  }
}

{
  const listed = await client.listTools();
  const names = new Set((listed.tools ?? []).map((t) => t.name));
  if (names.size !== 23 || !names.has("get_rules")) {
    failures++;
    console.log(`FAIL expected 23 tools including get_rules (got ${names.size})`);
  } else console.log("ok   twenty-three tools registered including get_rules");
  const orient = (listed.tools ?? []).find((t) => t.name === "orient_for_work");
  if (!orient?.description?.startsWith("Call before each action")) {
    failures++;
    console.log("FAIL orient_for_work description must lead with when to call it");
  } else console.log("ok   orient_for_work description has when-hint");
}

{
  const rules = "- Branch from latest main\n- Keep tests green";
  const described = JSON.parse(
    await expectOk("patch_project_description", "patch_project_description", {
      description: "A product.",
    })
  );
  if (
    described.description !== "A product." ||
    described.rules !== "" ||
    !described.changed_files?.includes("mindplan/project.md")
  ) {
    failures++;
    console.log(`FAIL patch_project_description must write description only: ${JSON.stringify(described)}`);
  } else console.log("ok   patch_project_description leaves rules unchanged");

  const ruled = JSON.parse(
    await expectOk("patch_project_rules", "patch_project_rules", { rules })
  );
  if (ruled.description !== "A product." || ruled.rules !== rules) {
    failures++;
    console.log(`FAIL patch_project_rules must keep description: ${JSON.stringify(ruled)}`);
  } else console.log("ok   patch_project_rules leaves description unchanged");

  await expectOk("replace description keeps rules", "patch_project_description", {
    description: "A revised product.",
  });
  const gp = await call("get_project", {});
  let payload;
  try {
    payload = JSON.parse(gp.text);
  } catch {
    payload = null;
  }
  if (
    gp.error ||
    !payload ||
    payload.description !== "A revised product." ||
    payload.rules !== rules
  ) {
    failures++;
    console.log(`FAIL get_project must return split brief writes: ${gp.text.slice(0, 240)}`);
  } else console.log("ok   get_project returns description and rules from separate writes");

  for (const tool of ["patch_project_description", "patch_project_rules"]) {
    try {
      const missing = await call(tool, {});
      if (!missing.error) {
        failures++;
        console.log(`FAIL ${tool} must require its section`);
      } else console.log(`ok   ${tool} rejects a missing section`);
    } catch {
      console.log(`ok   ${tool} rejects a missing section`);
    }
  }

  await expectOk("clear project description", "patch_project_description", { description: "" });
  await expectOk("clear project rules", "patch_project_rules", { rules: "" });
}

// --- create nodes ---
const createdJourney = JSON.parse(
  await expectOk("create journey", "create_node", { id: "j-ordering", type: "Journey", title: "Ordering", description: "Diner orders food" })
);
if (!createdJourney.changed_files?.includes("mindplan/journeys/j-ordering/j-ordering.mdx") || !createdJourney.changed_files?.includes("mindplan/map.md")) {
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
  !createdIx.changed_files?.includes("mindplan/interactions/i-checkout/i-checkout.mdx") ||
  createdIx.changed_files?.some((f) => String(f).includes("src/interactions/")) ||
  !createdIx.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL create_node changed_files interaction: ${JSON.stringify(createdIx.changed_files)}`);
} else console.log("ok   create_node changed_files (interaction)");
const ixFolder = path.join(root, "mindplan", "interactions", "i-checkout");
if (!fs.existsSync(path.join(ixFolder, "i-checkout.mdx"))) {
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
  !linkedDepends.changed_files?.includes("mindplan/interactions/i-checkout/i-checkout.mdx") ||
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
const ixCtx = fs.readFileSync(path.join(ixFolder, "i-checkout.mdx"), "utf-8");
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
  !createdIface.changed_files?.includes("mindplan/interfaces/if-web/if-web.mdx") ||
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
  !ixReady.changed_files?.includes("mindplan/interactions/i-checkout/i-checkout.mdx") ||
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
const ixPath = path.join(root, "mindplan", "interactions", "i-checkout", "i-checkout.mdx");
{
  let ixRaw = fs.readFileSync(ixPath, "utf-8");
  ixRaw = ixRaw
    .replace("- [ ] Requirements defined", "- [x] Requirements defined")
    .replace("- [ ] Implementation complete", "- [x] Implementation complete");
  // leave "Tests passing" unchecked
  fs.writeFileSync(ixPath, ixRaw);
}
// Atomic Ops are a ship-time ledger: completing every box while building is allowed.
await expectOk("last checkbox while in-progress is allowed", "patch_node_territory", {
  node_id: "i-checkout",
  toggle_checkboxes: [{ contains: "Tests passing", checked: true }],
});
await expectOk("reopen last checkbox (restore ship-time ledger)", "patch_node_territory", {
  node_id: "i-checkout",
  toggle_checkboxes: [{ contains: "Tests passing", checked: false }],
});
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
const fPath = path.join(root, "mindplan", "foundations", "f-db", "f-db.mdx");
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
const ifPendingPath = path.join(root, "mindplan", "interfaces", "if-pending", "if-pending.mdx");
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
const ifWebPath = path.join(root, "mindplan", "interfaces", "if-web", "if-web.mdx");
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

const bugPath = path.join(root, "mindplan", "bugs", "bug-race", "bug-race.mdx");
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
if (ctx.current_path !== "mindplan/bugs/bug-race/bug-race.mdx") { failures++; console.log("FAIL bug current_path"); }
else console.log("ok   bug get_node_context");
if (ctx.record?.title !== "Race condition" || ctx.record?.description !== "Double charge") {
  failures++; console.log(`FAIL bug title/description from record: ${JSON.stringify({ title: ctx.record?.title, description: ctx.record?.description })}`);
} else console.log("ok   bug title/description from record");
if (!ctx.record?.id || ctx.record.id !== "bug-race" || typeof ctx.body !== "string") {
  failures++; console.log(`FAIL get_node_context record+body: ${JSON.stringify({ record: ctx.record, bodyType: typeof ctx.body })}`);
} else console.log("ok   get_node_context record+body");
if (
  "raw_context" in ctx ||
  "context_path" in ctx ||
  "title" in ctx ||
  "description" in ctx
) {
  failures++; console.log(`FAIL get_node_context still has removed fields: ${JSON.stringify(Object.keys(ctx))}`);
} else console.log("ok   get_node_context omits raw_context/context_path/title/description");

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
if (
  oriented.context &&
  ("raw_context" in oriented.context ||
    "context_path" in oriented.context ||
    "title" in oriented.context ||
    "description" in oriented.context ||
    (oriented.context.next && "raw" in oriented.context.next))
) {
  failures++; console.log(`FAIL orient context still has removed fields: ${JSON.stringify(Object.keys(oriented.context))}`);
} else console.log("ok   orient_for_work context omits raw_context/aliases");

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
{
  const groups = blastIx.affected_files ?? [];
  const focusGroup = groups.find((g) => g.owner_id === "i-checkout");
  const bad = groups.some(
    (g) =>
      !Array.isArray(g.via) ||
      !Array.isArray(g.files) ||
      typeof g.owner_id !== "string" ||
      typeof g.owner_type !== "string" ||
      "path" in g
  );
  if (bad || !focusGroup?.via?.includes("focus") || !focusGroup.files?.length) {
    failures++; console.log(`FAIL affected_files not grouped by owner: ${JSON.stringify(groups)}`);
  } else console.log("ok   get_blast_radius affected_files grouped by owner");
}
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
const tipsCtxPath = path.join(root, "mindplan", "interactions", "i-tips", "i-tips.mdx");
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

{
  const mirrorBefore = path.join(root, "mindplan", "interactions", "i-checkout", "i-checkout.next.mdx");
  const liveBefore = path.join(root, "mindplan", "interactions", "i-checkout", "i-checkout.mdx");
  if (!fs.existsSync(mirrorBefore) || !fs.readFileSync(mirrorBefore, "utf-8").includes("state: mirror")) {
    failures++;
    console.log("FAIL first ship should leave a standing mirror twin");
  } else {
    const stripState = (raw) => raw.replace(/^state:\s*.*$/m, "state: <ignored>");
    if (stripState(fs.readFileSync(liveBefore, "utf-8")) !== stripState(fs.readFileSync(mirrorBefore, "utf-8"))) {
      failures++;
      console.log("FAIL mirror twin should match live except state");
    } else console.log("ok   standing mirror twin after first ship");
  }
}

const openNextRes = JSON.parse(await expectOk("open_next i-checkout", "open_next", {
  node_id: "i-checkout", title: "Checkout v2", description: "Revised checkout",
}));
if (openNextRes.next?.state !== "draft") {
  failures++; console.log(`FAIL open_next should flip mirror to draft: ${JSON.stringify(openNextRes.next)}`);
} else console.log("ok   open_next flips mirror twin to draft");
if (
  !openNextRes.changed_files?.includes("mindplan/interactions/i-checkout/i-checkout.next.mdx") ||
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

const nextPath = path.join(root, "mindplan", "interactions", "i-checkout", "i-checkout.next.mdx");
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
const tipsPath = path.join(root, "mindplan", "interactions", "i-tips", "i-tips.mdx");
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

// --- blast radius omits cancelled by default; include_retired restores; traverse through retired ---
await expectOk("create f-retired-mid", "create_node", {
  id: "f-retired-mid", type: "Foundation", title: "Retired mid", description: "Infra — cancelled mid hop", role: "infra",
});
await expectOk("link f-retired-mid depends_on f-a", "link_nodes", {
  source_id: "f-retired-mid", target_id: "f-a", edge_type: "depends_on",
});
await expectOk("cancel f-retired-mid", "update_node_status", {
  node_id: "f-retired-mid", new_status: "cancelled",
});
await expectOk("create f-live-beyond", "create_node", {
  id: "f-live-beyond", type: "Foundation", title: "Live beyond", description: "Infra — lives past retired", role: "infra",
});
await expectOk("link f-live-beyond depends_on f-retired-mid", "link_nodes", {
  source_id: "f-live-beyond", target_id: "f-retired-mid", edge_type: "depends_on",
});
const radiusDefault = JSON.parse(
  await expectOk("get_blast_radius f-a default retired filter", "get_blast_radius", { node_id: "f-a" })
);
const retiredHidden = radiusDefault.affected?.find((a) => a.id === "f-retired-mid");
const liveBeyond = radiusDefault.affected?.find((a) => a.id === "f-live-beyond");
const retiredInFiles = (radiusDefault.affected_files ?? []).some((g) => g.owner_id === "f-retired-mid");
if (retiredHidden || retiredInFiles) {
  failures++; console.log(`FAIL cancelled should be omitted by default: ${JSON.stringify(radiusDefault.affected)}`);
} else console.log("ok   get_blast_radius omits cancelled by default");
if (!liveBeyond || liveBeyond.distance !== 2) {
  failures++; console.log(`FAIL live beyond retired missing/wrong distance: ${JSON.stringify(radiusDefault.affected)}`);
} else console.log("ok   get_blast_radius keeps live dependent behind retired at true distance");
const radiusRetired = JSON.parse(
  await expectOk("get_blast_radius f-a include_retired", "get_blast_radius", {
    node_id: "f-a", include_retired: true,
  })
);
const retiredShown = radiusRetired.affected?.find((a) => a.id === "f-retired-mid");
const retiredFileGroup = (radiusRetired.affected_files ?? []).find((g) => g.owner_id === "f-retired-mid");
if (!retiredShown || retiredShown.distance !== 1) {
  failures++; console.log(`FAIL include_retired should show cancelled: ${JSON.stringify(radiusRetired.affected)}`);
} else console.log("ok   get_blast_radius include_retired shows cancelled");
if (!retiredFileGroup?.via?.includes("dependent")) {
  failures++; console.log(`FAIL include_retired affected_files missing retired owner: ${JSON.stringify(radiusRetired.affected_files)}`);
} else console.log("ok   get_blast_radius include_retired includes retired owner files");

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
  !shipNext.changed_files?.includes("mindplan/interactions/i-checkout/i-checkout.mdx") ||
  !shipNext.changed_files?.includes("mindplan/interactions/i-checkout/i-checkout.next.mdx") ||
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

if (!fs.existsSync(nextPath) || !fs.readFileSync(nextPath, "utf-8").includes("state: mirror")) {
  failures++; console.log("FAIL next.mdx should be restored as mirror after promote");
} else console.log("ok   next.mdx restored as mirror after promote");

const currentAfter = fs.readFileSync(path.join(root, "mindplan", "interactions", "i-checkout", "i-checkout.mdx"), "utf-8");
if (!currentAfter.includes("Checkout v2") || !currentAfter.includes("Revised checkout")) {
  failures++; console.log("FAIL current.mdx should carry promoted title/description");
} else console.log("ok   current.mdx updated from next on promote");

graph = JSON.parse(await expectOk("read graph after promote", "get_mindplan_graph", {}));
const afterPromote = graph.nodes.find((n) => n.id === "i-checkout");
if (afterPromote.next) {
  failures++; console.log(`FAIL open evolution should be gone after promote: ${JSON.stringify(afterPromote.next)}`);
} else console.log("ok   no open evolution after promote (mirror twin remains)");
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
if (!fs.existsSync(nextPath) || !fs.readFileSync(nextPath, "utf-8").includes("state: mirror")) {
  failures++; console.log("FAIL discard_next should restore mirror twin");
} else console.log("ok   discard_next restores mirror twin");
if (
  !discardRes.restored_mirror ||
  !discardRes.changed_files?.includes("mindplan/interactions/i-checkout/i-checkout.next.mdx") ||
  !discardRes.changed_files?.includes("mindplan/map.md")
) {
  failures++; console.log(`FAIL discard_next changed_files: ${JSON.stringify(discardRes.changed_files)}`);
} else console.log("ok   discard_next changed_files");
void openForDiscard;

// --- MCP writers: config, attachments, mirror guard, drift check ---
{
  const cfgRes = JSON.parse(
    await expectOk("patch_config sources", "patch_config", {
      sources: ["src/**", "lib/**"],
      exclude: ["src/generated/**"],
    })
  );
  if (
    !cfgRes.config?.sources?.includes("lib/**") ||
    !cfgRes.changed_files?.includes("mindplan/config.json")
  ) {
    failures++;
    console.log(`FAIL patch_config: ${JSON.stringify(cfgRes)}`);
  } else console.log("ok   patch_config writes config.json");

  const noteB64 = Buffer.from("review note", "utf-8").toString("base64");
  const putRes = JSON.parse(
    await expectOk("put_attachment on live", "put_attachment", {
      node_id: "i-checkout",
      filename: "note.txt",
      content_base64: noteB64,
    })
  );
  const attPath = path.join(root, "mindplan", "interactions", "i-checkout", "attachments", "note.txt");
  if (!fs.existsSync(attPath) || fs.readFileSync(attPath, "utf-8") !== "review note") {
    failures++;
    console.log(`FAIL put_attachment did not write note.txt: ${JSON.stringify(putRes)}`);
  } else console.log("ok   put_attachment writes attachments/");

  await expectBlocked("put_attachment rejects ..", "put_attachment", {
    node_id: "i-checkout",
    filename: "..",
    content_base64: noteB64,
  });
  await expectBlocked("remove_attachment rejects ..", "remove_attachment", {
    node_id: "i-checkout",
    filename: "..",
  });
  await expectBlocked("put_attachment rejects bad base64", "put_attachment", {
    node_id: "i-checkout",
    filename: "bad.txt",
    content_base64: "not!!!base64",
  });
  await expectOk("put_attachment empty payload", "put_attachment", {
    node_id: "i-checkout",
    filename: "empty.txt",
    content_base64: "",
  });
  // "hi" → aGk= ; unpadded aGk must also be accepted
  await expectOk("put_attachment unpadded base64", "put_attachment", {
    node_id: "i-checkout",
    filename: "hi.txt",
    content_base64: "aGk",
  });
  const hiPath = path.join(root, "mindplan", "interactions", "i-checkout", "attachments", "hi.txt");
  if (!fs.existsSync(hiPath) || fs.readFileSync(hiPath, "utf-8") !== "hi") {
    failures++;
    console.log("FAIL unpadded base64 should decode to hi");
  } else console.log("ok   put_attachment accepts empty and unpadded base64");
  await expectOk("remove empty attachment", "remove_attachment", {
    node_id: "i-checkout",
    filename: "empty.txt",
  });
  await expectOk("remove hi attachment", "remove_attachment", {
    node_id: "i-checkout",
    filename: "hi.txt",
  });
  await expectBlocked("put_attachment on next without evolution", "put_attachment", {
    node_id: "i-checkout",
    filename: "x.txt",
    content_base64: noteB64,
    slot: "next",
  });

  const rmRes = JSON.parse(
    await expectOk("remove_attachment note", "remove_attachment", {
      node_id: "i-checkout",
      filename: "note.txt",
    })
  );
  if (fs.existsSync(attPath) || !rmRes.removed) {
    failures++;
    console.log(`FAIL remove_attachment: ${JSON.stringify(rmRes)}`);
  } else console.log("ok   remove_attachment deletes attachments/");

  await expectBlocked("patch next while mirror", "patch_node_territory", {
    node_id: "i-checkout",
    body: "# must not write mirror\n",
    slot: "next",
  });

  // Drift the twin with a host write; open_next and check must Block; init heals.
  fs.appendFileSync(nextPath, "\n<!-- drift -->\n");
  await expectBlocked("open_next while mirror drifted", "open_next", {
    node_id: "i-checkout",
  });
  const { spawnSync } = await import("child_process");
  const checkDrift = spawnSync(process.execPath, [serverEntry, "check"], {
    env: { ...process.env, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
  if (checkDrift.status === 0 || !`${checkDrift.stdout}${checkDrift.stderr}`.includes("mirror:")) {
    failures++;
    console.log(
      `FAIL check should Block drifted mirror (status=${checkDrift.status}): ${checkDrift.stdout}${checkDrift.stderr}`
    );
  } else console.log("ok   check Blocks drifted mirror twin");

  const initHeal = spawnSync(process.execPath, [serverEntry, "init"], {
    env: { ...process.env, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
  const stripState = (raw) => raw.replace(/^state:\s*.*$/m, "state: <ignored>");
  const liveNow = fs.readFileSync(path.join(root, "mindplan", "interactions", "i-checkout", "i-checkout.mdx"), "utf-8");
  const twinNow = fs.readFileSync(nextPath, "utf-8");
  if (
    initHeal.status !== 0 ||
    !twinNow.includes("state: mirror") ||
    stripState(liveNow) !== stripState(twinNow)
  ) {
    failures++;
    console.log(
      `FAIL init should heal drifted mirror (status=${initHeal.status}): ${initHeal.stdout}${initHeal.stderr}`
    );
  } else console.log("ok   init heals drifted mirror twin");
}

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
if (!unshipRes.changed_files?.includes("mindplan/interactions/i-tips/i-tips.mdx")) {
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

const tipsNextAfterUnship = path.join(root, "mindplan", "interactions", "i-tips", "i-tips.next.mdx");
if (fs.existsSync(tipsNextAfterUnship)) {
  failures++;
  console.log("FAIL force_unship should delete the standing mirror twin");
} else console.log("ok   force_unship deletes standing mirror twin");

// --- deprecate shipped pipeline node deletes mirror twin + lists it in changed_files ---
{
  await expectOk("create f-retire-twin", "create_node", {
    id: "f-retire-twin",
    type: "Foundation",
    title: "Retire twin",
    description: "Infra — deprecate clears standing twin",
    role: "infra",
  });
  const retirePath = territoryPath("foundations", "f-retire-twin");
  fillMinimumTerritoryShape(retirePath);
  fs.writeFileSync(retirePath, fs.readFileSync(retirePath, "utf-8").replaceAll("[ ]", "[x]"));
  fs.mkdirSync(path.join(root, "src", "foundations", "f-retire-twin"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "foundations", "f-retire-twin", "index.ts"), "export {};\n");
  await expectOk("set implements f-retire-twin", "set_implementation_files", {
    node_id: "f-retire-twin",
    files: ["src/foundations/f-retire-twin/"],
  });
  for (const s of ["ready", "in-progress", "in-review"]) {
    await expectOk(`f-retire-twin -> ${s}`, "update_node_status", {
      node_id: "f-retire-twin",
      new_status: s,
    });
  }
  await expectOk("f-retire-twin -> ship", "update_node_status", {
    node_id: "f-retire-twin",
    new_status: "ship",
  });
  const retireNext = nextTerritoryPath("foundations", "f-retire-twin");
  if (!fs.existsSync(retireNext) || !fs.readFileSync(retireNext, "utf-8").includes("state: mirror")) {
    failures++;
    console.log("FAIL f-retire-twin ship should leave a mirror twin");
  }
  const deprecateRes = JSON.parse(
    await expectOk("deprecate f-retire-twin", "update_node_status", {
      node_id: "f-retire-twin",
      new_status: "deprecated",
    })
  );
  if (fs.existsSync(retireNext)) {
    failures++;
    console.log("FAIL deprecate should delete the standing mirror twin");
  } else if (
    !deprecateRes.changed_files?.includes("mindplan/foundations/f-retire-twin/f-retire-twin.next.mdx")
  ) {
    failures++;
    console.log(
      `FAIL deprecate changed_files should list deleted twin: ${JSON.stringify(deprecateRes.changed_files)}`
    );
  } else console.log("ok   deprecate deletes mirror twin and lists it in changed_files");
}

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
  const p = path.join(root, "mindplan", "foundations", id, `${id}.mdx`);
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

const corruptPath = path.join(root, "mindplan", "interactions", "i-tips", "i-tips.mdx");
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
} else if (!fs.existsSync(path.join(initRoot, "mindplan", "project.md"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install mindplan/project.md");
} else if (
  fs.readFileSync(path.join(initRoot, "mindplan", "project.md"), "utf-8") !==
  fs.readFileSync(path.join(toolRoot, "templates", "agent", "project.md"), "utf-8")
) {
  failures++;
  console.log("FAIL init project.md must be a copy of templates/agent/project.md");
} else if (
  (() => {
    const stub = fs.readFileSync(path.join(toolRoot, "templates", "agent", "agents-stub.md"), "utf-8");
    return (
      !stub.includes("get_project") ||
      !stub.includes("get_rules") ||
      !stub.includes("plan-project") ||
      !stub.includes(".cursor/") ||
      !stub.includes("mindplan/**") ||
      stub.includes("read `mindplan/agent/playbook.md`")
    );
  })()
) {
  failures++;
  console.log("FAIL agents-stub must point offline fallback at .cursor/ (not mindplan/** reads)");
} else if (!fs.existsSync(path.join(initRoot, ".cursorignore"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install .cursorignore");
} else if (
  (() => {
    const ignore = fs.readFileSync(path.join(initRoot, ".cursorignore"), "utf-8");
    return !ignore.includes("mindplan/**");
  })()
) {
  failures++;
  console.log("FAIL .cursorignore must ignore mindplan/** (MCP-only territory)");
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
} else if (
  fs.existsSync(path.join(initRoot, "mindplan", "agent", "skills", "review-work", "SKILL.md")) ||
  fs.existsSync(path.join(initRoot, "mindplan", "agent", "skills", "code-review", "SKILL.md"))
) {
  failures++;
  console.log("FAIL mindplan-mcp init must not install review-work or code-review skills");
} else if (
  !fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-define-entities", "SKILL.md")) ||
  !fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-plan-project", "SKILL.md"))
) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install Cursor skills under .cursor/skills/");
} else if (
  fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-review-work", "SKILL.md")) ||
  fs.existsSync(path.join(initRoot, ".cursor", "skills", "mindplan-code-review", "SKILL.md"))
) {
  failures++;
  console.log("FAIL mindplan-mcp init must not install Cursor review-work or code-review skills");
} else if (!fs.existsSync(path.join(initRoot, ".cursor", "rules", "mindplan.mdc"))) {
  failures++;
  console.log("FAIL mindplan-mcp init did not install .cursor/rules/mindplan.mdc");
} else if (
  (() => {
    const rule = fs.readFileSync(path.join(initRoot, ".cursor", "rules", "mindplan.mdc"), "utf-8");
    const stub = fs.readFileSync(path.join(toolRoot, "templates", "agent", "agents-stub.md"), "utf-8");
    return !rule.includes("alwaysApply: true") || !rule.endsWith(stub);
  })()
) {
  failures++;
  console.log("FAIL .cursor/rules/mindplan.mdc must be alwaysApply frontmatter plus the stub body");
} else if (
  (() => {
    const stub = fs.readFileSync(path.join(toolRoot, "templates", "agent", "agents-stub.md"), "utf-8");
    const playbook = fs.readFileSync(path.join(toolRoot, "templates", "agent", "playbook.md"), "utf-8");
    return (
      fs.readFileSync(path.join(initRoot, "AGENTS.md"), "utf-8") !== stub ||
      fs.readFileSync(path.join(initRoot, "mindplan", "agent", "playbook.md"), "utf-8") !== playbook
    );
  })()
) {
  failures++;
  console.log("FAIL init: AGENTS.md must equal the stub and mindplan/agent/playbook.md must equal the playbook");
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

// --- init reports mirrorTwinSkips when the twin path cannot be written ---
{
  const skipRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-skip-twin-"));
  const ent = path.join(skipRoot, "mindplan", "foundations", "f-skip-twin");
  fs.mkdirSync(ent, { recursive: true });
  fs.writeFileSync(
    path.join(skipRoot, "mindplan", "config.json"),
    JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
  );
  const now = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(ent, "f-skip-twin.mdx"),
    `---
id: f-skip-twin
type: Foundation
title: "Skip twin"
description: "Infra — unwritable next path"
state: stable
shipped_at: ${now}
created_at: ${now}
updated_at: ${now}
implements:
  - src/foundations/f-skip-twin/
role: infra
---

# Skip twin

## Shared Substrate Spec

Shared substrate for skip twin.

## Impact

Adapted so the already-shipped contract still holds.

## Atomic Ops

- [x] Done

`
  );
  // Occupy the next-slot path with a directory so writeMirrorTwin cannot write a file.
  fs.mkdirSync(path.join(ent, "f-skip-twin.next.mdx"), { recursive: true });
  const skipInit = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: skipRoot,
    env: { ...process.env, MINDPLAN_ROOT: skipRoot },
    encoding: "utf-8",
  });
  const skipOut = `${skipInit.stdout}${skipInit.stderr}`;
  if (skipInit.status !== 0 || !skipOut.includes("Skipped mirror twin for f-skip-twin")) {
    failures++;
    console.log(
      `FAIL init should report mirrorTwinSkips (status=${skipInit.status}): ${skipOut}`
    );
  } else console.log("ok   init reports skipped mirror twin writes");
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

// Rename legacy current.mdx / next.mdx to <id>.mdx / <id>.next.mdx
{
  const renameRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-rename-"));
  const ixDir = path.join(renameRoot, "mindplan", "interactions", "i-old");
  const journeyDir = path.join(renameRoot, "mindplan", "journeys", "j-old");
  fs.mkdirSync(ixDir, { recursive: true });
  fs.mkdirSync(journeyDir, { recursive: true });
  fs.writeFileSync(path.join(ixDir, "current.mdx"), "---\nid: i-old\n---\n\n# Old\n", "utf-8");
  fs.writeFileSync(path.join(ixDir, "next.mdx"), "---\nid: i-old\n---\n\n# Next\n", "utf-8");
  fs.writeFileSync(path.join(journeyDir, "current.mdx"), "---\nid: j-old\n---\n\n# Journey\n", "utf-8");
  const renameInit = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: renameRoot,
    env: { ...process.env, MINDPLAN_ROOT: renameRoot },
    encoding: "utf-8",
  });
  const live = path.join(ixDir, "i-old.mdx");
  const evolved = path.join(ixDir, "i-old.next.mdx");
  const journey = path.join(journeyDir, "j-old.mdx");
  if (renameInit.status !== 0) {
    failures++;
    console.log(`FAIL init rename exit ${renameInit.status}: ${renameInit.stderr || renameInit.stdout}`);
  } else if (
    !fs.existsSync(live) ||
    !fs.existsSync(evolved) ||
    !fs.existsSync(journey) ||
    fs.existsSync(path.join(ixDir, "current.mdx")) ||
    fs.existsSync(path.join(ixDir, "next.mdx")) ||
    !renameInit.stdout.includes("Renamed mindplan/interactions/i-old/current.mdx → mindplan/interactions/i-old/i-old.mdx") ||
    !renameInit.stdout.includes("Renamed mindplan/interactions/i-old/next.mdx → mindplan/interactions/i-old/i-old.next.mdx")
  ) {
    failures++;
    console.log(`FAIL init did not rename legacy territory files:\n${renameInit.stdout}`);
  } else if (fs.readFileSync(live, "utf-8") !== "---\nid: i-old\n---\n\n# Old\n") {
    failures++;
    console.log("FAIL renamed live file body changed");
  } else {
    const again = spawnSync(process.execPath, [serverEntry, "init"], {
      cwd: renameRoot,
      env: { ...process.env, MINDPLAN_ROOT: renameRoot },
      encoding: "utf-8",
    });
    if (again.status !== 0 || again.stdout.includes("Renamed ")) {
      failures++;
      console.log(`FAIL second init should rename nothing: ${again.stdout}`);
    } else console.log("ok   init renames legacy current.mdx and next.mdx");
  }

  const clashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-rename-clash-"));
  const clashDir = path.join(clashRoot, "mindplan", "foundations", "f-old");
  fs.mkdirSync(clashDir, { recursive: true });
  fs.writeFileSync(path.join(clashDir, "current.mdx"), "legacy\n", "utf-8");
  fs.writeFileSync(path.join(clashDir, "f-old.mdx"), "named\n", "utf-8");
  const clash = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: clashRoot,
    env: { ...process.env, MINDPLAN_ROOT: clashRoot },
    encoding: "utf-8",
  });
  if (clash.status !== 0) {
    failures++;
    console.log(`FAIL init clash exit ${clash.status}: ${clash.stderr || clash.stdout}`);
  } else if (
    fs.existsSync(path.join(clashDir, "current.mdx")) ||
    fs.readFileSync(path.join(clashDir, "f-old.mdx"), "utf-8") !== "named\n" ||
    !clash.stdout.includes("Removed mindplan/foundations/f-old/current.mdx (kept mindplan/foundations/f-old/f-old.mdx)")
  ) {
    failures++;
    console.log(`FAIL init should drop legacy file and keep the id-named file:\n${clash.stdout}`);
  } else console.log("ok   init drops legacy file when the id-named file exists");

  const bugNextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-rename-bug-"));
  const bugDir = path.join(bugNextRoot, "mindplan", "bugs", "bug-old");
  fs.mkdirSync(bugDir, { recursive: true });
  fs.writeFileSync(path.join(bugDir, "next.mdx"), "nope\n", "utf-8");
  const bugNext = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: bugNextRoot,
    env: { ...process.env, MINDPLAN_ROOT: bugNextRoot },
    encoding: "utf-8",
  });
  if (
    bugNext.status === 0 ||
    !(bugNext.stderr || "").includes("mindplan/bugs/bug-old/next.mdx") ||
    !(bugNext.stderr || "").includes("by hand")
  ) {
    failures++;
    console.log(`FAIL init should ask to fix next.mdx on a bug by hand: ${bugNext.stderr || bugNext.stdout}`);
  } else if (!fs.existsSync(path.join(bugDir, "next.mdx"))) {
    failures++;
    console.log("FAIL failed init must leave the unrenamed next.mdx in place");
  } else console.log("ok   init asks to fix next.mdx under bugs by hand");

  const preflightRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-preflight-"));
  const keepDir = path.join(preflightRoot, "mindplan", "foundations", "f-keep");
  const namedBugDir = path.join(preflightRoot, "mindplan", "bugs", "bug-named");
  fs.mkdirSync(keepDir, { recursive: true });
  fs.mkdirSync(namedBugDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, "current.mdx"), "keep\n", "utf-8");
  fs.writeFileSync(path.join(namedBugDir, "bug-named.next.mdx"), "evolve\n", "utf-8");
  const preflight = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: preflightRoot,
    env: { ...process.env, MINDPLAN_ROOT: preflightRoot },
    encoding: "utf-8",
  });
  if (
    preflight.status === 0 ||
    !(preflight.stderr || "").includes("mindplan/bugs/bug-named/bug-named.next.mdx") ||
    !(preflight.stderr || "").includes("by hand") ||
    !fs.existsSync(path.join(keepDir, "current.mdx")) ||
    fs.existsSync(path.join(keepDir, "f-keep.mdx")) ||
    !fs.existsSync(path.join(namedBugDir, "bug-named.next.mdx")) ||
    (preflight.stdout || "").includes("Renamed ")
  ) {
    failures++;
    console.log(`FAIL init should stop before renaming when a bug has an id-named evolution file:\n${preflight.stdout}\n${preflight.stderr}`);
  } else console.log("ok   init stops before renaming when a journey or bug has an id-named evolution file");

  const partialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-partial-"));
  const okDir = path.join(partialRoot, "mindplan", "foundations", "a-ok");
  const badDir = path.join(partialRoot, "mindplan", "foundations", "b-bad");
  fs.mkdirSync(okDir, { recursive: true });
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(okDir, "current.mdx"), "ok\n", "utf-8");
  fs.writeFileSync(path.join(badDir, "current.mdx"), "bad\n", "utf-8");
  fs.mkdirSync(path.join(badDir, "b-bad.mdx"));
  const partial = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: partialRoot,
    env: { ...process.env, MINDPLAN_ROOT: partialRoot },
    encoding: "utf-8",
  });
  if (
    partial.status === 0 ||
    !(partial.stdout || "").includes("Renamed mindplan/foundations/a-ok/current.mdx → mindplan/foundations/a-ok/a-ok.mdx") ||
    !(partial.stderr || "").includes("mindplan/foundations/b-bad/current.mdx") ||
    !(partial.stderr || "").includes("by hand") ||
    !fs.existsSync(path.join(okDir, "a-ok.mdx")) ||
    !fs.existsSync(path.join(badDir, "current.mdx"))
  ) {
    failures++;
    console.log(`FAIL init should print renames already applied when a later rename fails:\n${partial.stdout}\n${partial.stderr}`);
  } else console.log("ok   init prints renames already applied when a later rename fails");

  const currentIdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-current-id-"));
  const currentIdDir = path.join(currentIdRoot, "mindplan", "foundations", "current");
  fs.mkdirSync(currentIdDir, { recursive: true });
  fs.writeFileSync(path.join(currentIdDir, "current.mdx"), "same file\n", "utf-8");
  const currentId = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: currentIdRoot,
    env: { ...process.env, MINDPLAN_ROOT: currentIdRoot },
    encoding: "utf-8",
  });
  if (
    currentId.status !== 0 ||
    !fs.existsSync(path.join(currentIdDir, "current.mdx")) ||
    fs.readFileSync(path.join(currentIdDir, "current.mdx"), "utf-8") !== "same file\n" ||
    (currentId.stdout || "").includes("Renamed mindplan/foundations/current/")
  ) {
    failures++;
    console.log(`FAIL init should leave current.mdx in place when the id is current:\n${currentId.stdout}\n${currentId.stderr}`);
  } else console.log("ok   init leaves current.mdx in place when the id is current");

  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-current-case-"));
  const caseDir = path.join(caseRoot, "mindplan", "foundations", "Current");
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, "current.mdx"), "case file\n", "utf-8");
  const caseInit = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: caseRoot,
    env: { ...process.env, MINDPLAN_ROOT: caseRoot },
    encoding: "utf-8",
  });
  const caseBody = fs.existsSync(path.join(caseDir, "current.mdx"))
    ? fs.readFileSync(path.join(caseDir, "current.mdx"), "utf-8")
    : fs.existsSync(path.join(caseDir, "Current.mdx"))
      ? fs.readFileSync(path.join(caseDir, "Current.mdx"), "utf-8")
      : "";
  if (caseInit.status !== 0 || caseBody !== "case file\n" || (caseInit.stderr || "").includes("Removed ")) {
    failures++;
    console.log(`FAIL case-only current id should keep the file:\n${caseInit.stdout}\n${caseInit.stderr}`);
  } else console.log("ok   init does not delete the file when the id differs only by case");

  const nextClashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-init-next-clash-"));
  const nextClashDir = path.join(nextClashRoot, "mindplan", "foundations", "f-next");
  fs.mkdirSync(nextClashDir, { recursive: true });
  fs.writeFileSync(path.join(nextClashDir, "f-next.mdx"), "live\n", "utf-8");
  fs.writeFileSync(path.join(nextClashDir, "next.mdx"), "legacy-next\n", "utf-8");
  fs.writeFileSync(path.join(nextClashDir, "f-next.next.mdx"), "named-next\n", "utf-8");
  const nextClash = spawnSync(process.execPath, [serverEntry, "init"], {
    cwd: nextClashRoot,
    env: { ...process.env, MINDPLAN_ROOT: nextClashRoot },
    encoding: "utf-8",
  });
  if (
    nextClash.status !== 0 ||
    fs.existsSync(path.join(nextClashDir, "next.mdx")) ||
    fs.readFileSync(path.join(nextClashDir, "f-next.next.mdx"), "utf-8") !== "named-next\n" ||
    !(nextClash.stdout || "").includes("Removed mindplan/foundations/f-next/next.mdx (kept mindplan/foundations/f-next/f-next.next.mdx)")
  ) {
    failures++;
    console.log(`FAIL init should drop legacy next.mdx when the id-named evolution exists:\n${nextClash.stdout}\n${nextClash.stderr}`);
  } else console.log("ok   init drops legacy next.mdx when the id-named evolution exists");

  const checkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-check-legacy-"));
  const checkDir = path.join(checkRoot, "mindplan", "bugs", "bug-both");
  fs.mkdirSync(checkDir, { recursive: true });
  fs.writeFileSync(path.join(checkDir, "bug-both.mdx"), "---\nid: bug-both\ntype: Bug\ntitle: \"B\"\ndescription: \"kept\"\nstate: open\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n\n# B\n", "utf-8");
  fs.writeFileSync(path.join(checkDir, "current.mdx"), "---\nid: bug-both\ntype: Bug\ntitle: \"B\"\ndescription: \"drop\"\nstate: open\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n\n# B\n", "utf-8");
  const checkClash = spawnSync(process.execPath, [serverEntry, "check"], {
    cwd: checkRoot,
    env: { ...process.env, MINDPLAN_ROOT: checkRoot },
    encoding: "utf-8",
  });
  if (
    fs.existsSync(path.join(checkDir, "current.mdx")) ||
    !(checkClash.stderr || "").includes("Removed mindplan/bugs/bug-both/current.mdx (kept mindplan/bugs/bug-both/bug-both.mdx)")
  ) {
    failures++;
    console.log(`FAIL check should print the legacy file it removed:\n${checkClash.stdout}\n${checkClash.stderr}`);
  } else console.log("ok   check prints a legacy file removed while loading the graph");
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

    // An older install left the full playbook in AGENTS.md; -f must replace it with the stub.
    const templatePlaybook = fs.readFileSync(path.join(toolRoot, "templates", "agent", "playbook.md"), "utf-8");
    const templateStub = fs.readFileSync(path.join(toolRoot, "templates", "agent", "agents-stub.md"), "utf-8");
    fs.writeFileSync(path.join(forceRoot, "AGENTS.md"), "# MindPlan Agent Playbook (old full copy)\n", "utf-8");
    const customBrief = "# Project\n\n## Description\n\nCustom product.\n\n## Rules\n\n- Keep me\n";
    const briefPath = path.join(forceRoot, "mindplan", "project.md");
    fs.writeFileSync(briefPath, customBrief, "utf-8");

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
      if (restored !== templatePlaybook) {
        failures++;
        console.log("FAIL init -f must restore playbook from package templates");
      } else {
        console.log("ok   init -f overwrites mutated playbook from templates");
      }
      if (fs.readFileSync(path.join(forceRoot, "AGENTS.md"), "utf-8") !== templateStub) {
        failures++;
        console.log("FAIL init -f must replace an old full-playbook AGENTS.md with the stub");
      } else {
        console.log("ok   init -f replaces old AGENTS.md with the stub");
      }
      if (fs.readFileSync(briefPath, "utf-8") !== customBrief) {
        failures++;
        console.log("FAIL init -f must not overwrite mindplan/project.md");
      } else {
        console.log("ok   init -f leaves project brief untouched");
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

// --- ordered revision status + real impact section ---
await expectOk("create f-ord", "create_node", {
  id: "f-ord",
  type: "Foundation",
  title: "Ordered substrate",
  description: "Infra — batch status substrate",
  role: "infra",
});
await expectOk("create i-ord", "create_node", {
  id: "i-ord",
  type: "Interaction",
  title: "Ordered behavior",
  description: "Depends on f-ord",
});
await expectOk("create if-ord", "create_node", {
  id: "if-ord",
  type: "Interface",
  title: "Ordered surface",
  description: "Mounts i-ord",
});
await expectOk("link i-ord journey", "link_nodes", {
  source_id: "i-ord",
  target_id: "j-ordering",
  edge_type: "belongs_to",
});
await expectOk("link i-ord foundation", "link_nodes", {
  source_id: "i-ord",
  target_id: "f-ord",
  edge_type: "depends_on",
});
await expectOk("link if-ord exposes", "link_nodes", {
  source_id: "if-ord",
  target_id: "i-ord",
  edge_type: "exposes",
});
await expectOk("link if-ord depends", "link_nodes", {
  source_id: "if-ord",
  target_id: "f-ord",
  edge_type: "depends_on",
});
for (const [kind, id] of [
  ["foundations", "f-ord"],
  ["interactions", "i-ord"],
  ["interfaces", "if-ord"],
]) {
  fillMinimumTerritoryShape(territoryPath(kind, id));
  const impl = path.join(root, "src", kind, id);
  fs.mkdirSync(impl, { recursive: true });
  fs.writeFileSync(path.join(impl, "index.ts"), "export const ok = true;\n");
  await expectOk(`set implements ${id}`, "set_implementation_files", {
    node_id: id,
    files: [`src/${kind}/${id}/`],
  });
}
const fOrdPath = territoryPath("foundations", "f-ord");
fs.appendFileSync(fOrdPath, "\n## Impact\n\n_None._\n");
await expectBlockedContaining(
  "empty impact blocks ready",
  "update_node_status",
  { node_id: "f-ord", new_status: "ready" },
  'section "## Impact" is empty or a stub'
);
fs.writeFileSync(
  fOrdPath,
  fs.readFileSync(fOrdPath, "utf-8").replace(
    "## Impact\n\n_None._\n",
    "## Impact\n\nAdapted the schema export so the shipped substrate contract still holds.\n"
  )
);
for (const kind of ["foundations", "interfaces"]) {
  const id = kind === "foundations" ? "f-ord" : "if-ord";
  const p = territoryPath(kind, id);
  fs.writeFileSync(p, fs.readFileSync(p, "utf-8").replaceAll("[ ]", "[x]"));
}
const batchReady = JSON.parse(
  await expectOk("ordered ready", "update_node_status", {
    revisions: [
      { node_id: "if-ord", new_status: "ready" },
      { node_id: "i-ord", new_status: "ready" },
      { node_id: "f-ord", new_status: "ready" },
    ],
  })
);
const readyIds = (batchReady.applied ?? []).map((row) => row.node_id).join(",");
if (readyIds !== "f-ord,i-ord,if-ord") {
  failures++;
  console.log(`FAIL ordered ready sequence: ${readyIds}`);
} else console.log("ok   revisions apply foundations then interactions then interfaces");
await expectOk("ordered in-progress", "update_node_status", {
  revisions: [
    { node_id: "if-ord", new_status: "in-progress" },
    { node_id: "i-ord", new_status: "in-progress" },
    { node_id: "f-ord", new_status: "in-progress" },
  ],
});
await expectOk("ordered in-review", "update_node_status", {
  revisions: [
    { node_id: "i-ord", new_status: "in-review" },
    { node_id: "if-ord", new_status: "in-review" },
    { node_id: "f-ord", new_status: "in-review" },
  ],
});
await expectBlockedContaining(
  "ordered ship stops on completion and keeps foundation",
  "update_node_status",
  {
    revisions: [
      { node_id: "if-ord", new_status: "ship" },
      { node_id: "i-ord", new_status: "ship" },
      { node_id: "f-ord", new_status: "ship" },
    ],
  },
  'Ordered status stopped on "i-ord" after applying: f-ord (stable)'
);
graph = JSON.parse(await expectOk("graph after ordered stop", "get_mindplan_graph", {}));
const fOrd = graph.nodes.find((n) => n.id === "f-ord");
const iOrd = graph.nodes.find((n) => n.id === "i-ord");
const ifOrd = graph.nodes.find((n) => n.id === "if-ord");
if (fOrd?.state !== "stable") {
  failures++;
  console.log(`FAIL f-ord should be stable, got ${fOrd?.state}`);
} else console.log("ok   foundation stayed shipped after ordered stop");
if (iOrd?.state !== "in-review") {
  failures++;
  console.log(`FAIL i-ord should stay in-review, got ${iOrd?.state}`);
} else console.log("ok   blocked interaction was not shipped");
if (ifOrd?.state !== "in-review") {
  failures++;
  console.log(`FAIL if-ord should stay in-review, got ${ifOrd?.state}`);
} else console.log("ok   later interface was not attempted");

await expectOk("open_next f-ord", "open_next", { node_id: "f-ord" });
const fOrdNext = nextTerritoryPath("foundations", "f-ord");
const inheritedLabels = [...fs.readFileSync(fOrdNext, "utf-8").matchAll(/^- \[[ xX]\] (.+)$/gm)].map(
  (match) => match[1]
);
await expectOk("inherited complete next checklist", "patch_node_territory", {
  node_id: "f-ord",
  slot: "next",
  toggle_checkboxes: inheritedLabels.map((contains) => ({ contains, checked: true })),
});
{
  const relabeled = fs.readFileSync(fOrdNext, "utf-8").replace(inheritedLabels[0], `${inheritedLabels[0]} reopened`);
  fs.writeFileSync(fOrdNext, relabeled);
}
await expectOk("fully checked building checklist is allowed regardless of labels", "patch_node_territory", {
  node_id: "f-ord",
  slot: "next",
  toggle_checkboxes: [{ contains: "reopened", checked: true }],
});

await expectOk("create f-cr", "create_node", {
  id: "f-cr",
  type: "Foundation",
  title: "Carriage return shape",
  description: "Infra — section split on lone CR",
  role: "infra",
});
const fCrPath = territoryPath("foundations", "f-cr");
fillMinimumTerritoryShape(fCrPath);
{
  const impl = path.join(root, "src", "foundations", "f-cr");
  fs.mkdirSync(impl, { recursive: true });
  fs.writeFileSync(path.join(impl, "index.ts"), "export const ok = true;\n");
}
await expectOk("set implements f-cr", "set_implementation_files", {
  node_id: "f-cr",
  files: ["src/foundations/f-cr/"],
});
{
  const raw = fs.readFileSync(fCrPath, "utf-8").replace(/\r\n/g, "\n");
  const close = raw.indexOf("\n---\n", 4);
  const head = raw.slice(0, close + "\n---\n".length);
  const body = raw.slice(close + "\n---\n".length).replace(/\n/g, "\r");
  fs.writeFileSync(fCrPath, `${head}${body}\r## Impact\r\r_None._\r`);
}
await expectBlockedContaining(
  "lone CR still exposes an empty impact section",
  "update_node_status",
  { node_id: "f-cr", new_status: "ready" },
  'section "## Impact" is empty or a stub'
);
{
  const fixed = fs.readFileSync(fCrPath, "utf-8").replace(
    "_None._",
    "Adapted the section split so a carriage return still reveals the shipped shape contract."
  );
  fs.writeFileSync(fCrPath, fixed);
}
await expectOk("lone CR with real impact can ready", "update_node_status", {
  node_id: "f-cr",
  new_status: "ready",
});

// --- open_next on a CRLF body keeps line terminators and checkboxes (no reset) ---
{
  const fDbCurrent = territoryPath("foundations", "f-db");
  const fDbNext = nextTerritoryPath("foundations", "f-db");
  const lf = fs.readFileSync(fDbCurrent, "utf-8").replace(/\r\n/g, "\n");
  fs.writeFileSync(fDbCurrent, lf.replace(/\n/g, "\r\n"));
  // Host bypass of the store: drop the twin so open_next seeds from the CRLF live file.
  if (fs.existsSync(fDbNext)) fs.unlinkSync(fDbNext);
  const checkedBefore = (fs.readFileSync(fDbCurrent, "utf-8").match(/^\s*[-*+]\s+\[[xX]\]/gm) ?? []).length;
  await expectOk("open_next f-db (CRLF body)", "open_next", { node_id: "f-db" });
  const nextRaw = fs.readFileSync(fDbNext, "utf-8");
  const checkedAfter = (nextRaw.match(/^\s*[-*+]\s+\[[xX]\]/gm) ?? []).length;
  if (checkedBefore === 0) {
    failures++;
    console.log("FAIL CRLF open_next fixture has no checked items");
  } else if (/\r(?!\n)/.test(nextRaw)) {
    failures++;
    console.log("FAIL open_next on CRLF body left a lone CR in next.mdx");
  } else if (checkedAfter !== checkedBefore) {
    failures++;
    console.log(`FAIL open_next must not reset checkboxes: before ${checkedBefore} after ${checkedAfter}`);
  } else if (!nextRaw.includes("\r\n") || !nextRaw.includes("state: draft")) {
    failures++;
    console.log("FAIL open_next on CRLF body should keep CRLF and flip to draft");
  } else console.log("ok   open_next on CRLF body keeps CRLF and checkboxes");
  await expectOk("discard_next f-db (CRLF body)", "discard_next", { node_id: "f-db" });
  fs.writeFileSync(fDbCurrent, lf);
  // Heal twin after host rewrite of live (mirrors init/check path).
  const healed = fs.readFileSync(fDbCurrent, "utf-8").replace(/^state:\s*.*$/m, "state: mirror");
  fs.writeFileSync(fDbNext, healed);
}

{
  const legacyDir = path.join(root, "mindplan", "interactions", "i-legacy");
  const legacyFoundation = path.join(root, "mindplan", "foundations", "f-legacy");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(legacyFoundation, { recursive: true });
  const legacyIx = `---
id: i-legacy
type: Interaction
title: "Legacy"
description: "Kept on current.mdx"
state: draft
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
---

# Legacy

## Purpose

Legacy interaction body.
`;
  fs.writeFileSync(path.join(legacyDir, "current.mdx"), legacyIx, "utf-8");
  fs.writeFileSync(
    path.join(legacyFoundation, "current.mdx"),
    `---
id: f-legacy
type: Foundation
title: "Legacy foundation"
description: "Infra — legacy file"
state: stable
role: infra
shipped_at: 2026-01-01T00:00:00.000Z
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
---

# Legacy foundation

## Purpose

Infra — legacy foundation kept on current.mdx.

## Shared Substrate Spec

Legacy substrate.

## Acceptance Criteria

- Still loads

## Atomic Ops

- [x] Loaded
`,
    "utf-8"
  );
  const graph = JSON.parse(await expectOk("read graph with legacy files", "get_mindplan_graph", {}));
  const legacyNode = graph.nodes.find((n) => n.id === "i-legacy");
  const legacyFound = graph.nodes.find((n) => n.id === "f-legacy");
  if (!legacyNode || legacyNode.description !== "Kept on current.mdx" || !legacyFound) {
    failures++;
    console.log("FAIL legacy current.mdx was not loaded");
  } else {
    const ctx = JSON.parse(await expectOk("context for legacy interaction", "get_node_context", { node_id: "i-legacy" }));
    if (ctx.current_path !== "mindplan/interactions/i-legacy/current.mdx") {
      failures++;
      console.log(`FAIL legacy current_path: ${ctx.current_path}`);
    } else {
      await expectOk("patch legacy interaction", "patch_node_territory", {
        node_id: "i-legacy",
        description: "Still current.mdx",
      });
      const patched = fs.readFileSync(path.join(legacyDir, "current.mdx"), "utf-8");
      if (!patched.includes("Still current.mdx") || fs.existsSync(path.join(legacyDir, "i-legacy.mdx"))) {
        failures++;
        console.log("FAIL patch wrote a new id-named file instead of current.mdx");
      } else {
        await expectOk("open_next on legacy foundation", "open_next", { node_id: "f-legacy" });
        if (
          !fs.existsSync(path.join(legacyFoundation, "next.mdx")) ||
          fs.existsSync(path.join(legacyFoundation, "f-legacy.next.mdx"))
        ) {
          failures++;
          console.log("FAIL open_next on current.mdx should create next.mdx");
        } else {
          console.log("ok   legacy current.mdx and next.mdx still load and write");
          const nextPath = path.join(legacyFoundation, "next.mdx");
          const nextRaw = fs.readFileSync(nextPath, "utf-8").replace(/\[[ ]\]/g, "[x]") + "\nPROMOTED_LEGACY\n";
          fs.writeFileSync(nextPath, nextRaw, "utf-8");
          const legacySrc = path.join(root, "src", "foundations", "f-legacy");
          fs.mkdirSync(legacySrc, { recursive: true });
          fs.writeFileSync(path.join(legacySrc, "store.ts"), "export {}\n", "utf-8");
          await expectOk("set implements f-legacy next", "set_implementation_files", {
            node_id: "f-legacy",
            files: ["src/foundations/f-legacy/"],
          });
          await expectOk("legacy next ready", "update_node_status", { node_id: "f-legacy", new_status: "ready" });
          await expectOk("legacy next in-progress", "update_node_status", { node_id: "f-legacy", new_status: "in-progress" });
          await expectOk("legacy next in-review", "update_node_status", { node_id: "f-legacy", new_status: "in-review" });
          await expectOk("legacy next ship", "update_node_status", { node_id: "f-legacy", new_status: "ship" });
          const promoted = fs.readFileSync(path.join(legacyFoundation, "current.mdx"), "utf-8");
          const nextAfterShip = fs.existsSync(nextPath)
            ? fs.readFileSync(nextPath, "utf-8")
            : "";
          if (!promoted.includes("PROMOTED_LEGACY") || !nextAfterShip.includes("state: mirror")) {
            failures++;
            console.log("FAIL promote should write current.mdx and restore mirror next.mdx");
          } else console.log("ok   promote restores legacy next.mdx as mirror");
          await expectOk("open_next again on legacy foundation", "open_next", { node_id: "f-legacy" });
          await expectOk("discard legacy next.mdx", "discard_next", { node_id: "f-legacy" });
          if (
            !fs.existsSync(nextPath) ||
            !fs.readFileSync(nextPath, "utf-8").includes("state: mirror") ||
            !fs.existsSync(path.join(legacyFoundation, "current.mdx"))
          ) {
            failures++;
            console.log("FAIL discard_next should restore mirror next.mdx and keep current.mdx");
          }
        }
      }
    }
  }

  const clashDir = path.join(root, "mindplan", "bugs", "bug-clash");
  fs.mkdirSync(clashDir, { recursive: true });
  const clashBody = `---
id: bug-clash
type: Bug
title: "Clash"
description: "Both names"
state: open
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
---

# Clash
`;
  const kept = clashBody.replace('description: "Both names"', 'description: "Kept id-named file"');
  const dropped = clashBody.replace('description: "Both names"', 'description: "Dropped legacy file"');
  fs.writeFileSync(path.join(clashDir, "current.mdx"), dropped, "utf-8");
  fs.writeFileSync(path.join(clashDir, "bug-clash.mdx"), kept, "utf-8");
  const clash = await call("get_mindplan_graph", {});
  const clashGraph = clash.error ? null : JSON.parse(clash.text);
  const clashNode = clashGraph?.nodes.find((n) => n.id === "bug-clash");
  if (
    clash.error ||
    !clashNode ||
    clashNode.description !== "Kept id-named file" ||
    !clashGraph.removed_legacy_files?.includes("mindplan/bugs/bug-clash/current.mdx") ||
    fs.existsSync(path.join(clashDir, "current.mdx")) ||
    !fs.existsSync(path.join(clashDir, "bug-clash.mdx"))
  ) {
    failures++;
    console.log(`FAIL both names should keep the id-named file and delete current.mdx: ${clash.text}`);
  } else console.log("ok   both names keep the id-named file and delete the legacy file");
  fs.rmSync(clashDir, { recursive: true, force: true });

  const patchDir = path.join(root, "mindplan", "bugs", "bug-patch");
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, "bug-patch.mdx"), kept.replaceAll("bug-clash", "bug-patch").replace('description: "Kept id-named file"', 'description: "patch me"'), "utf-8");
  fs.writeFileSync(path.join(patchDir, "current.mdx"), dropped.replaceAll("bug-clash", "bug-patch"), "utf-8");
  const patchClash = await call("patch_node_territory", { node_id: "bug-patch", description: "patched via id file" });
  const patchBody = patchClash.error ? null : JSON.parse(patchClash.text);
  if (
    patchClash.error ||
    !patchBody.changed_files?.includes("mindplan/bugs/bug-patch/current.mdx") ||
    !patchBody.removed_legacy_files?.includes("mindplan/bugs/bug-patch/current.mdx") ||
    fs.existsSync(path.join(patchDir, "current.mdx")) ||
    !fs.readFileSync(path.join(patchDir, "bug-patch.mdx"), "utf-8").includes("patched via id file")
  ) {
    failures++;
    console.log(`FAIL patch should report the deleted legacy file: ${patchClash.text}`);
  } else console.log("ok   changed_files includes a legacy file deleted during the mutation");
  fs.rmSync(patchDir, { recursive: true, force: true });

  const nextClashDir = path.join(root, "mindplan", "foundations", "f-nextclash");
  fs.mkdirSync(nextClashDir, { recursive: true });
  const nextLive = `---
id: f-nextclash
type: Foundation
title: "Next clash"
description: "Infra — live"
state: stable
role: infra
shipped_at: 2026-01-01T00:00:00.000Z
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
---

# Next clash
`;
  const nextNamed = `---
id: f-nextclash
type: Foundation
title: "Next clash"
description: "Kept next file"
state: draft
updated_at: 2026-01-01T00:00:00.000Z
role: infra
---

# Next
`;
  const nextLegacy = nextNamed.replace('description: "Kept next file"', 'description: "Dropped next file"');
  fs.writeFileSync(path.join(nextClashDir, "f-nextclash.mdx"), nextLive, "utf-8");
  fs.writeFileSync(path.join(nextClashDir, "f-nextclash.next.mdx"), nextNamed, "utf-8");
  fs.writeFileSync(path.join(nextClashDir, "next.mdx"), nextLegacy, "utf-8");
  const nextClashGraphCall = await call("get_mindplan_graph", {});
  const nextClashGraph = nextClashGraphCall.error ? null : JSON.parse(nextClashGraphCall.text);
  const nextClashNode = nextClashGraph?.nodes.find((n) => n.id === "f-nextclash");
  if (
    nextClashGraphCall.error ||
    nextClashNode?.next?.description !== "Kept next file" ||
    fs.existsSync(path.join(nextClashDir, "next.mdx")) ||
    !nextClashGraph.removed_legacy_files?.includes("mindplan/foundations/f-nextclash/next.mdx")
  ) {
    failures++;
    console.log(`FAIL both evolution names should keep the id-named file: ${nextClashGraphCall.text}`);
  } else console.log("ok   both evolution names keep the id-named file and delete next.mdx");
  fs.rmSync(nextClashDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
