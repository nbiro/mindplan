/**
 * Fix review findings: rewrite open next / in-review territories to package paths.
 * Run: node scripts/fix-review-territory.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/index.js")],
  env: { ...process.env, MINDPLAN_ROOT: root },
  cwd: root,
});
const client = new Client({ name: "fix-territory", version: "0.1.0" });
await client.connect(transport);

async function call(tool, args = {}) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function retreatToInProgress(node_id) {
  const g = await call("get_mindplan_graph", {});
  const n = g.nodes.find((x) => x.id === node_id);
  const state = n?.next?.state ?? n?.state;
  if (state === "in-review") {
    await call("update_node_status", { node_id, new_status: "in-progress" });
  }
}

async function patchAndReview(node_id, body, description) {
  await retreatToInProgress(node_id);
  await call("patch_node_territory", {
    node_id,
    ...(description ? { description } : {}),
    body,
  });
  await call("update_node_status", { node_id, new_status: "in-review" });
  console.log("ok", node_id);
}

const foundationBody = (id, title, bullets) => `# ${title}

## Shared Substrate Spec

Implemented in \`src/foundations/${id}/\`:

${bullets.map((b) => `- ${b}`).join("\n")}

## Checklist

- [x] Spec written
- [x] Implementation complete in \`src/foundations/${id}/\`
- [x] Verified in target environment (\`npm test\`)

## Attachments

_Schemas and diagrams go in \`attachments/\`._
`;

await patchAndReview(
  "f-domain-model",
  foundationBody("f-domain-model", "Domain model", [
    "`types.ts` — taxonomy, state machines, edge types, next-slot types, graph version",
  ]),
  "Taxonomy and graph types in src/foundations/f-domain-model/"
);

await patchAndReview(
  "f-compiler-rules",
  foundationBody("f-compiler-rules", "Compiler rules engine", [
    "`rules.ts` — Blocked: guardrails, status transitions, journey/stability recompute, open_next validation",
  ]),
  "Compiler rules in src/foundations/f-compiler-rules/"
);

await patchAndReview(
  "f-territory-store",
  foundationBody("f-territory-store", "Territory filesystem store", [
    "`store.ts` — discover/load graph, frontmatter edges, scaffold, next promote/discard, territory patch",
    "Consumer init/install helpers live in `src/workflows/wf-project-init/init.ts` (not this Foundation)",
  ]),
  "Territory FS store in src/foundations/f-territory-store/ (init split to wf-project-init)"
);

await patchAndReview(
  "f-mcp-runtime",
  foundationBody("f-mcp-runtime", "MCP stdio runtime", [
    "`server.ts` — MCP tool registration shell, CLI (`init`/`view`), package-root resolution for templates",
    "Thin entry: `src/index.ts` boots this module",
  ]),
  "MCP/CLI shell in src/foundations/f-mcp-runtime/; resolves package root via templates/agent walk-up"
);

await patchAndReview(
  "f-graph-search",
  foundationBody("f-graph-search", "Graph search", [
    "`search.ts` — token ranking + 1-hop neighborhood",
    "Retired nodes (`deprecated`, closed Bugs) are excluded from ranking by default (same policy as map export)",
  ]),
  "Graph search in src/foundations/f-graph-search/; excludes retired nodes from orientation ranking"
);

await patchAndReview(
  "f-view-projection",
  foundationBody("f-view-projection", "View projection", [
    "`view.ts` — Mermaid/DOT projection and `mindplan/map.md` persistence",
  ]),
  "View projection in src/foundations/f-view-projection/"
);

await patchAndReview(
  "wf-mutate-graph",
  `# Mutate graph

## Execution Logic

Write-path MCP tools registered in \`f-mcp-runtime/server.ts\`; ownership list in \`src/workflows/wf-mutate-graph/tools.ts\`:
\`create_node\`, \`link_nodes\`, \`unlink_nodes\`, \`update_node_status\`, \`patch_node_territory\`, \`open_next\`, \`discard_next\`.

## Checklist

- [x] Requirements defined
- [x] Tools wired under package ownership (\`src/workflows/wf-mutate-graph/\`)
- [x] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`,
  "Write-path graph tools; package at src/workflows/wf-mutate-graph/"
);

await patchAndReview(
  "wf-test-harness",
  `# Test harness

## Execution Logic

Regression tests live in \`src/workflows/wf-test-harness/\`:

- \`view.test.mjs\` — Mermaid/DOT unit tests
- \`search.test.mjs\` — ranking excludes retired nodes
- \`smoke.mjs\` — MCP stdio end-to-end + \`mindplan-mcp init\` template install

\`npm test\` runs build then these scripts.

## Checklist

- [x] Requirements defined
- [x] Harness under \`src/workflows/wf-test-harness/\`
- [x] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`,
  "Smoke/view/search tests in src/workflows/wf-test-harness/"
);

await patchAndReview(
  "wf-impl-packages",
  `# Prescribe implementation packages

## Execution Logic

1. Foundations under \`src/foundations/<id>/\`
2. Workflows under \`src/workflows/<id>/\`
3. Thin \`src/index.ts\` boots \`f-mcp-runtime\`
4. \`npm test\` points at \`wf-test-harness\`
5. Suffix Workflows deprecated; orientation excludes retired nodes

## Checklist

- [x] Foundations moved (domain, rules, store, search, view, mcp-runtime)
- [x] Workflows moved (query, mutate, export, project-init, test-harness)
- [x] Thin entry + imports wire; \`npm test\` green
- [x] Stale suffix Workflows deprecated; map screams clean ids

## Attachments

_Wireframes and notes go in \`attachments/\`._
`
);

await patchAndReview(
  "wf-query-graph",
  `# Orient on the plan

## Execution Logic

Read tools registered in \`f-mcp-runtime\`; ownership in \`src/workflows/wf-query-graph/tools.ts\`. Ranking substrate: \`f-graph-search\`.

## Checklist

- [x] Requirements defined
- [x] Tools live under \`src/workflows/wf-query-graph/\`
- [x] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`
);

await patchAndReview(
  "wf-export-views",
  `# See the map

## Execution Logic

\`export_mindplan_view\` + map refresh; ownership in \`src/workflows/wf-export-views/tools.ts\`. Projection substrate: \`f-view-projection\`.

## Checklist

- [x] Requirements defined
- [x] Tools live under \`src/workflows/wf-export-views/\`
- [x] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`
);

await patchAndReview(
  "wf-project-init",
  `# Init a consumer project

## Execution Logic

\`mindplan-mcp init\` uses \`src/workflows/wf-project-init/init.ts\` (playbook, skill, integrations, AGENTS.md, .cursorignore). Package root resolved by walking up to \`templates/agent\`.

## Checklist

- [x] Requirements defined
- [x] Init helpers moved out of territory store into this package
- [x] Tests passing

## Attachments

_Wireframes and notes go in \`attachments/\`._
`
);

// Tidy obsolete affected-files workflow (cannot deprecate from pre-ship)
await retreatToInProgress("wf-workflow-affected-files");
await call("patch_node_territory", {
  node_id: "wf-workflow-affected-files",
  title: "OBSOLETE — use get_node_implementation",
  description:
    "Superseded by prescribed packages + get_node_implementation. Do not ship. Left unassigned; cannot deprecate until shipped.",
  body: `# OBSOLETE — use get_node_implementation

This Workflow predates the stable-id / prescribed-package model. Per-file \`get_workflow_files\` was removed from the MCP surface.

**Do not ship.** Prefer \`get_node_implementation\` and the MindPlan graph.

## Checklist

- [x] Root cause identified (feature removed from SPEC)
- [x] No further implementation
- [x] Left unassigned pending retirement path for pre-ship nodes

## Attachments

_None._
`,
});
await call("update_node_status", {
  node_id: "wf-workflow-affected-files",
  new_status: "ready",
});
console.log("ok wf-workflow-affected-files tidied");

const found = await call("find_related_nodes", { query: "query graph orient" });
console.log("orient focus:", found.focus, "matches:", found.matches?.map((m) => `${m.id}:${m.state}`));

await client.close();
console.log("territory fixes done");
