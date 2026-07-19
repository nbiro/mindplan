/**
 * One-shot Phase A graph rewrite against the rebuilt MCP server (dist/index.js).
 * Cursor's MCP session may still be on a stale build — this bypasses that.
 *
 * Run from repo root: node scripts/migrate-scream-graph.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverEntry = path.join(root, "dist/index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
  cwd: root,
});
const client = new Client({ name: "migrate-scream", version: "0.1.0" });
await client.connect(transport);

async function call(tool, args = {}) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) {
    throw new Error(`${tool} failed: ${text}`);
  }
  console.log(`ok  ${tool}`, args.id || args.node_id || args.source_id || "", args.edge_type || args.new_status || "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callAllowBlocked(tool, args = {}) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) {
    console.log(`skip ${tool}: ${text}`);
    return null;
  }
  console.log(`ok  ${tool}`, args.node_id || args.id || "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 1. Discard in-flight next on project-init-v2
await callAllowBlocked("discard_next", { node_id: "wf-project-init-v2" });

// 2. New foundations
await callAllowBlocked("create_node", {
  id: "f-graph-search",
  type: "Foundation",
  title: "Graph search",
  description: "Token ranking and 1-hop neighborhood expansion for orientation tools.",
});
await callAllowBlocked("create_node", {
  id: "f-view-projection",
  type: "Foundation",
  title: "View projection",
  description: "Mermaid/DOT typed-DAG projection and mindplan/map.md persistence.",
});
await callAllowBlocked("link_nodes", {
  source_id: "f-graph-search",
  target_id: "f-domain-model",
  edge_type: "depends_on",
});
await callAllowBlocked("link_nodes", {
  source_id: "f-view-projection",
  target_id: "f-domain-model",
  edge_type: "depends_on",
});

// 3. Clean workflows
const workflows = [
  {
    id: "wf-query-graph",
    title: "Orient on the plan",
    description:
      "Read orientation tools: find_related_nodes, get_mindplan_graph, get_node_context, get_blast_radius, orient_for_work, get_node_implementation.",
  },
  {
    id: "wf-export-views",
    title: "See the map",
    description: "Mermaid/DOT export plus automatic mindplan/map.md refresh after graph mutations.",
  },
  {
    id: "wf-project-init",
    title: "Init a consumer project",
    description:
      "Scaffold consumer mindplan/ plus agent playbook, define-entities skill, MCP example, integrations, and AGENTS.md.",
  },
  {
    id: "wf-framework-docs",
    title: "Framework documentation",
    description:
      "README, SPEC, and playbook: MindPlan as the living product plan agents work from.",
  },
  {
    id: "wf-impl-packages",
    title: "Prescribe implementation packages",
    description:
      "Move runtime code into src/foundations/<id>/ and src/workflows/<id>/ so architecture screams from the filesystem.",
  },
];

for (const wf of workflows) {
  await callAllowBlocked("create_node", {
    id: wf.id,
    type: "Workflow",
    title: wf.title,
    description: wf.description,
  });
}

// 4. Links
const links = [
  // query
  ["wf-query-graph", "j-territory-sdlc", "belongs_to"],
  ["wf-query-graph", "f-mcp-runtime", "depends_on"],
  ["wf-query-graph", "f-graph-search", "depends_on"],
  // export
  ["wf-export-views", "j-territory-sdlc", "belongs_to"],
  ["wf-export-views", "f-mcp-runtime", "depends_on"],
  ["wf-export-views", "f-territory-store", "depends_on"],
  ["wf-export-views", "f-view-projection", "depends_on"],
  // project-init
  ["wf-project-init", "j-agent-onboarding", "belongs_to"],
  ["wf-project-init", "f-territory-store", "depends_on"],
  // framework-docs (dual journey)
  ["wf-framework-docs", "j-territory-sdlc", "belongs_to"],
  ["wf-framework-docs", "j-agent-onboarding", "belongs_to"],
  ["wf-framework-docs", "f-domain-model", "depends_on"],
  // impl-packages
  ["wf-impl-packages", "j-territory-sdlc", "belongs_to"],
  ["wf-impl-packages", "f-territory-store", "depends_on"],
  ["wf-impl-packages", "f-mcp-runtime", "depends_on"],
];

for (const [source_id, target_id, edge_type] of links) {
  await callAllowBlocked("link_nodes", { source_id, target_id, edge_type });
}

// 5. Journey scream patches
await call("patch_node_territory", {
  node_id: "j-agent-onboarding",
  title: "Adopt MindPlan",
  description:
    "Adopt MindPlan in a consumer project and wire it into coding agents via init, playbooks, and integrations.",
  body: `# Adopt MindPlan

Adopt MindPlan in a consumer project and wire it into coding agents via init, playbooks, and integrations.

## Overview

Consumer projects install MindPlan territory, an always-on agent playbook, the define-entities skill, and per-agent MCP setup guides.

## Linked Workflows

- \`wf-project-init\` — scaffold mindplan/ + agent assets
- \`wf-agent-integrations\` — per-agent MCP setup guides
- \`wf-npm-publish\` — publish mindplan-mcp to npm
- \`wf-framework-docs\` — README / SPEC / playbook (shared with Plan software)

## Attachments

_Place supporting files in \`attachments/\` alongside this file._
`,
});

await call("patch_node_territory", {
  node_id: "j-territory-sdlc",
  title: "Plan software",
  description:
    "Plan and execute software work through MindPlan territory, compiler gates, and MCP graph tools.",
  body: `# Plan software

Plan and execute software work through MindPlan territory, compiler gates, and MCP graph tools.

## Overview

Agents and humans plan software by querying and mutating a GitOps territory graph. Orientation starts with \`orient_for_work\` / \`find_related_nodes\`; all writes go through the MCP compiler; Mermaid/DOT views and blast radius keep dependencies visible before change.

## Linked Workflows

- \`wf-query-graph\` — orient on the plan
- \`wf-mutate-graph\` — change the plan
- \`wf-export-views\` — see the map
- \`wf-test-harness\` — smoke and view regression tests
- \`wf-impl-packages\` — prescribe src/foundations and src/workflows packages
- \`wf-framework-docs\` — framework documentation (shared with Adopt MindPlan)

## Attachments

_Place supporting files in \`attachments/\` alongside this file._
`,
});

// Foundation territory for new nodes
await call("patch_node_territory", {
  node_id: "f-graph-search",
  body: `# Graph search

Token ranking and 1-hop neighborhood expansion for orientation tools.

## Shared Substrate Spec

Implemented in \`src/foundations/f-graph-search/\`:

- \`findRelatedNodes\`, \`rankNodes\`, \`expandNeighborhood\`
- Consumed by \`wf-query-graph\` orientation tools

## Checklist

- [ ] Spec written
- [ ] Implementation moved into foundation package
- [ ] Verified in target environment

## Attachments

_Schemas and diagrams go in \`attachments/\`._
`,
});

await call("patch_node_territory", {
  node_id: "f-view-projection",
  body: `# View projection

Mermaid/DOT typed-DAG projection and mindplan/map.md persistence.

## Shared Substrate Spec

Implemented in \`src/foundations/f-view-projection/\`:

- \`exportMindPlanView\`, \`persistMindPlanMap\`, \`graphToMermaid\` / \`graphToDot\`
- Consumed by \`wf-export-views\` and mutation map refresh

## Checklist

- [ ] Spec written
- [ ] Implementation moved into foundation package
- [ ] Verified in target environment

## Attachments

_Schemas and diagrams go in \`attachments/\`._
`,
});

await call("patch_node_territory", {
  node_id: "wf-impl-packages",
  body: `# Prescribe implementation packages

Move runtime code into \`src/foundations/<id>/\` and \`src/workflows/<id>/\` so architecture screams from the filesystem.

## Execution Logic

1. Place Foundation modules under \`src/foundations/<id>/\`
2. Place Workflow tool modules and harness under \`src/workflows/<id>/\`
3. Keep a thin \`src/index.ts\` entry that boots \`f-mcp-runtime\`
4. Point \`npm test\` at \`wf-test-harness\`
5. Rebuild dist and reload MCP

## Checklist

- [ ] Foundations moved (domain, rules, store, search, view, mcp-runtime)
- [ ] Workflows moved (query, mutate, export, project-init, test-harness)
- [ ] Thin entry + imports wire; \`npm test\` green
- [ ] Stale suffix Workflows deprecated; map screams clean ids

## Attachments

_Wireframes and notes go in \`attachments/\`._
`,
});

// Enrich other new workflows briefly
await call("patch_node_territory", {
  node_id: "wf-query-graph",
  body: `# Orient on the plan

Read orientation tools for agents.

## Execution Logic

Register and serve: \`find_related_nodes\`, \`get_mindplan_graph\`, \`get_node_context\`, \`get_blast_radius\`, \`orient_for_work\`, \`get_node_implementation\`. Ranking lives in \`f-graph-search\`.

## Checklist

- [ ] Requirements defined
- [ ] Tools live under \`src/workflows/wf-query-graph/\`
- [ ] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`,
});

await call("patch_node_territory", {
  node_id: "wf-export-views",
  body: `# See the map

Mermaid/DOT export plus automatic mindplan/map.md refresh.

## Execution Logic

\`export_mindplan_view\` tool plus \`persistMindPlanMap\` after mutations. Projection math lives in \`f-view-projection\`.

## Checklist

- [ ] Requirements defined
- [ ] Tools live under \`src/workflows/wf-export-views/\`
- [ ] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`,
});

await call("patch_node_territory", {
  node_id: "wf-project-init",
  body: `# Init a consumer project

Scaffold consumer mindplan/ plus agent assets.

## Execution Logic

\`mindplan-mcp init\` installs territory dirs, playbook, define-entities skill, MCP example, integrations, AGENTS.md, and .cursorignore. Implementation in \`src/workflows/wf-project-init/\`.

## Checklist

- [ ] Requirements defined
- [ ] Init helpers moved out of territory store into this package
- [ ] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`,
});

await call("patch_node_territory", {
  node_id: "wf-framework-docs",
  body: `# Framework documentation

README, SPEC, and playbook: MindPlan as the living product plan agents work from.

## Execution Logic

Docs live at repo root and under \`templates/agent/\` / \`mindplan/agent/\`. Package folder is a pointer; no runtime TS.

## Checklist

- [ ] Requirements defined
- [ ] Docs reflect stable-id / next.mdx model and package layout
- [ ] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`,
});

// 6. Retire obsolete — retreat affected-files if needed, then deprecate
const graph = await call("get_mindplan_graph", {});
const affected = graph.nodes.find((n) => n.id === "wf-workflow-affected-files");
if (affected) {
  if (affected.state === "in-review") {
    await callAllowBlocked("update_node_status", {
      node_id: "wf-workflow-affected-files",
      new_status: "in-progress",
    });
  }
  // from in-progress/ready/draft we may not go directly to deprecated — check rules
  // Production only: stable/unstable -> deprecated. Pre-ship: need another path.
  // For draft/ready/in-progress/in-review, deprecate might be illegal.
  // Plan said deprecate — if blocked, leave and note.
  await callAllowBlocked("update_node_status", {
    node_id: "wf-workflow-affected-files",
    new_status: "deprecated",
  });
}

for (const id of [
  "wf-query-graph-v2",
  "wf-export-views-v2",
  "wf-project-init-v2",
  "wf-framework-docs-v3",
]) {
  await callAllowBlocked("update_node_status", { node_id: id, new_status: "deprecated" });
}

const view = await call("export_mindplan_view", { format: "mermaid" });
console.log("\n--- map preview (first 2k) ---\n");
console.log(String(view.diagram ?? view).slice(0, 2000));

const tools = await client.listTools();
console.log(
  "\nServer tools:",
  tools.tools.map((t) => t.name).sort().join(", ")
);

await client.close();
console.log("\nPhase A migration complete.");
