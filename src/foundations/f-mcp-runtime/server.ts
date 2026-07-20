#!/usr/bin/env node
/**
 * MindPlan MCP server — f-mcp-runtime shell.
 * Tool ownership (screaming packages):
 *   wf-query-graph   — read/orient tools (../../workflows/wf-query-graph/tools.ts)
 *   wf-mutate-graph  — write tools (../../workflows/wf-mutate-graph/tools.ts)
 *   wf-export-views  — export_mindplan_view (../../workflows/wf-export-views/tools.ts)
 *   wf-project-init  — CLI init (../../workflows/wf-project-init/init.ts)
 * Substrate: f-domain-model, f-compiler-rules, f-territory-store, f-graph-search, f-view-projection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { NODE_TYPES, initialStateForType, isNextPipelineState, type MindPlanNode } from "../f-domain-model/types.js";
import {
  ensureDirectories,
  ATTACHMENTS_DIR,
  CURRENT_FILENAME,
  NEXT_FILENAME,
  NEXT_ATTACHMENTS_DIR,
  entityRelativePath,
  loadGraph,
  nodeExists,
  listAttachments,
  getNodeImplementation,
  implementationRelativePath,
  readMarkdown,
  scaffoldEntity,
  patchFrontmatter,
  addEdgeToFrontmatter,
  removeEdgesFromFrontmatter,
  splitContext,
  nodeToRecord,
  patchNodeTerritory,
  openNextSlot,
  discardNextSlot,
  promoteNextSlot,
  edgeWriteSlot,
  nextAttachmentsDir,
  type TerritorySlot,
} from "../f-territory-store/store.js";
import {
  initProject,
  installAgentPlaybook,
  installAgentIntegrations,
  installCursorIgnore,
  installCursorPermissions,
  installDefineEntitiesSkill,
  installPlanProjectSkill,
  installMcpExample,
  installRootAgentsMd,
} from "../../workflows/wf-project-init/init.js";
import {
  blocked,
  findNode,
  recomputeJourneyStates,
  recomputeStability,
  resolveStatusChange,
  resolveForceUnship,
  validateLink,
  assertAcyclicDependsOn,
  missingJourneyDependents,
  validateOpenNext,
  blastRadiusDependents,
  assertWorkflowTerritoryScalarsEditable,
} from "../f-compiler-rules/rules.js";
import { DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT, findRelatedNodes } from "../f-graph-search/search.js";
import { VIEW_FORMATS, exportMindPlanView, persistMindPlanMap } from "../f-view-projection/view.js";
import { runIntegrityCheck } from "../../workflows/wf-integrity-check/check.js";

const server = new McpServer({
  name: "mindplan",
  version: "0.1.0",
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Walk up from this module until templates/agent exists (works from nested dist/foundations/...). */
function resolvePackageRoot(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "templates", "agent"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate MindPlan package root (templates/agent missing). " +
      "Run mindplan-mcp from an installed package that includes templates/."
  );
}

function guarded<A>(handler: (args: A) => ToolResult): (args: A) => ToolResult {
  return (args: A) => {
    try {
      return handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

function syncNodes(nodes: MindPlanNode[]): void {
  for (const n of nodes) patchFrontmatter(n);
}

/** Project-relative path of the auto-persisted Mermaid snapshot. */
const MAP_REL = "mindplan/map.md";

/** Repo-relative path of a node's current or next territory MDX. */
function territoryPath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  const rel = entityRelativePath(node);
  return `${rel}/${slot === "next" ? NEXT_FILENAME : CURRENT_FILENAME}`;
}

/** Deduplicate changed paths, optionally appending the map snapshot. */
function changedFiles(paths: string[], includeMap = false): string[] {
  const out = [...new Set(paths.filter(Boolean))];
  if (includeMap && !out.includes(MAP_REL)) out.push(MAP_REL);
  return out;
}

/**
 * Paths touched when discarding or promoting a next slot.
 * When `includeCopiedAttachments` is true (promote), also lists
 * `attachments/<file>` targets for each non-.gitkeep next-attachment file.
 */
function nextSlotFsChangedFiles(
  node: Pick<MindPlanNode, "id" | "type">,
  opts: { includeCopiedAttachments: boolean }
): string[] {
  const rel = entityRelativePath(node);
  const nextAttRel = `${rel}/${NEXT_ATTACHMENTS_DIR}`;
  const attRel = `${rel}/${ATTACHMENTS_DIR}`;
  const files = [`${rel}/${NEXT_FILENAME}`, nextAttRel];
  const abs = nextAttachmentsDir(node);
  if (fs.existsSync(abs)) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files.push(`${nextAttRel}/${entry.name}`);
      if (opts.includeCopiedAttachments && entry.name !== ".gitkeep") {
        files.push(`${attRel}/${entry.name}`);
      }
    }
  }
  return files;
}

/** Reload territory and refresh `mindplan/map.md` after a successful mutation. */
function refreshPersistedMap(): void {
  persistMindPlanMap(loadGraph());
}

function buildNodeContextPayload(node: MindPlanNode): Record<string, unknown> {
  const rel = entityRelativePath(node);
  const currentRaw = readMarkdown(node, "current");
  const currentSplit = splitContext(currentRaw);
  const payload: Record<string, unknown> = {
    folder: rel,
    context_path: `${rel}/${CURRENT_FILENAME}`,
    current_path: `${rel}/${CURRENT_FILENAME}`,
    attachments_path: `${rel}/${ATTACHMENTS_DIR}`,
    attachments: listAttachments(node),
    record: nodeToRecord(node),
    body: currentSplit?.body ?? "",
    title: node.title,
    description: node.description,
    raw_context: currentRaw,
    next: null,
  };
  if (node.next) {
    const nextRaw = readMarkdown(node, "next");
    const nextSplit = splitContext(nextRaw);
    payload.next_path = `${rel}/${NEXT_FILENAME}`;
    payload.next_attachments_path = `${rel}/${NEXT_ATTACHMENTS_DIR}`;
    payload.next = {
      record: {
        state: node.next.state,
        title: node.next.title,
        description: node.next.description,
        updated_at: node.next.updated_at,
        ...(node.next.belongs_to?.length ? { belongs_to: node.next.belongs_to } : {}),
        ...(node.next.depends_on?.length ? { depends_on: node.next.depends_on } : {}),
      },
      body: nextSplit?.body ?? "",
      raw: nextRaw,
    };
  }
  return payload;
}

const NODE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "ids must be kebab_case/slug style: lowercase letters, digits, - and _");

server.registerTool(
  "get_mindplan_graph",
  {
    title: "Get MindPlan graph",
    description:
      "Returns the full MindPlan graph — nodes and edges assembled from current.mdx frontmatter.",
    inputSchema: {},
  },
  guarded(() => ok(loadGraph()))
);

server.registerTool(
  "export_mindplan_view",
  {
    title: "Export MindPlan view",
    description:
      "Exports a deterministic typed-DAG projection as Mermaid or DOT for PRs and docs. " +
      "Omit focus for the full filtered map; pass focus for that node plus its 1-hop neighborhood. " +
      "By default hides deprecated/cancelled nodes and closed bugs. Prefer find_related_nodes for agent orientation JSON; " +
      "use this when the user wants a diagram / map.",
    inputSchema: {
      format: z
        .enum(VIEW_FORMATS)
        .optional()
        .describe('Diagram format: "mermaid" (default) or "dot".'),
      focus: NODE_ID.optional().describe(
        "When set, export focus + 1-hop linked neighborhood only."
      ),
      include_retired: z
        .boolean()
        .optional()
        .describe(
          "Include deprecated/cancelled nodes and closed bugs (resolved/wontfix). Default false."
        ),
    },
  },
  guarded(({ format, focus, include_retired }) => {
    const graph = loadGraph();
    if (focus) {
      findNode(graph, focus);
    }
    return ok(
      exportMindPlanView(graph, {
        format: format ?? "mermaid",
        focus,
        include_retired: include_retired ?? false,
      })
    );
  })
);

server.registerTool(
  "find_related_nodes",
  {
    title: "Find related nodes",
    description:
      "Ranks nodes by text query (id/title/description) and returns the focus node plus its 1-hop " +
      "linked neighborhood (summaries only). Prefer this over get_mindplan_graph for orientation. " +
      "Provide query and/or node_id. Use get_node_context for full territory; get_blast_radius for transitive dependents.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Free-text query to rank nodes (id, title, description). Required if node_id omitted."),
      node_id: NODE_ID.optional().describe(
        "Force focus to this node when present. Required if query is empty."
      ),
      type: z
        .enum(NODE_TYPES)
        .optional()
        .describe("Optional type filter applied before ranking."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_FIND_LIMIT)
        .optional()
        .describe(`Max ranked matches to return (default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT}).`),
    },
  },
  guarded(({ query, node_id, type, limit }) => {
    const q = (query ?? "").trim();
    if (!q && !node_id) {
      throw blocked('find_related_nodes requires a non-empty "query" and/or "node_id".');
    }
    const graph = loadGraph();
    if (node_id) {
      findNode(graph, node_id);
    }
    return ok(
      findRelatedNodes(graph, {
        query: q,
        node_id,
        type,
        limit: limit ?? DEFAULT_FIND_LIMIT,
      })
    );
  })
);

server.registerTool(
  "get_node_implementation",
  {
    title: "Get node implementation",
    description:
      "Returns the prescribed implementation package for a Workflow or Foundation " +
      "(src/workflows/<id> or src/foundations/<id>): root path, whether it exists, and top-level entries.",
    inputSchema: {
      node_id: NODE_ID.describe("Workflow or Foundation id whose implementation package to read."),
    },
  },
  guarded(({ node_id }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    return ok(getNodeImplementation(node));
  })
);

server.registerTool(
  "get_node_context",
  {
    title: "Get node context",
    description:
      "Returns authoritative record (graph slice), editable body, attachment paths, and filenames. " +
      "Includes next slot when an evolution is in progress. Prefer record+body over raw_context (deprecated).",
    inputSchema: {
      node_id: NODE_ID.describe("The id of the node whose territory to read."),
    },
  },
  guarded(({ node_id }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    return ok(buildNodeContextPayload(node));
  })
);

server.registerTool(
  "orient_for_work",
  {
    title: "Orient for work",
    description:
      "Composite orientation: find_related_nodes + get_node_context (record+body) for focus, " +
      "plus get_blast_radius when focus is a Foundation or Workflow. Prefer this to start a work session.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Free-text query to rank nodes. Required if node_id omitted."),
      node_id: NODE_ID.optional().describe("Force focus to this node when present."),
      type: z.enum(NODE_TYPES).optional().describe("Optional type filter before ranking."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_FIND_LIMIT)
        .optional()
        .describe(`Max ranked matches (default ${DEFAULT_FIND_LIMIT}).`),
    },
  },
  guarded(({ query, node_id, type, limit }) => {
    const q = (query ?? "").trim();
    if (!q && !node_id) {
      throw blocked('orient_for_work requires a non-empty "query" and/or "node_id".');
    }
    const graph = loadGraph();
    if (node_id) {
      findNode(graph, node_id);
    }
    const related = findRelatedNodes(graph, {
      query: q,
      node_id,
      type,
      limit: limit ?? DEFAULT_FIND_LIMIT,
    });
    let context: Record<string, unknown> | null = null;
    let blast_radius: Record<string, unknown> | null = null;

    if (related.focus) {
      const node = findNode(graph, related.focus);
      context = buildNodeContextPayload(node);
      if (node.type === "Foundation" || node.type === "Workflow") {
        const { affected: entries } = blastRadiusDependents(graph, node.id);
        const journeysAtRisk = new Set<string>();
        for (const { node: affected } of entries) {
          if (affected.type !== "Workflow") continue;
          for (const edge of graph.edges) {
            if (edge.source === affected.id && edge.type === "belongs_to") {
              journeysAtRisk.add(edge.target);
            }
          }
        }
        blast_radius = {
          node_id: node.id,
          affected: entries.map(({ node: n, distance }) => ({
            id: n.id,
            type: n.type,
            state: n.state,
            distance,
          })),
          journeys_at_risk: [...journeysAtRisk].sort(),
        };
      }
    }

    return ok({ ...related, context, blast_radius });
  })
);

server.registerTool(
  "patch_node_territory",
  {
    title: "Patch node territory",
    description:
      "Patches territory-owned content: body (PRD, checklists), optional title/description " +
      "(pre-ship Workflows or next slot), toggle_checkboxes. " +
      "When a shipped Foundation/Workflow has next.mdx, patches default to next. Optional slot: current|next.",
    inputSchema: {
      node_id: NODE_ID.describe("Node whose territory to patch."),
      title: z.string().min(1).optional().describe("New title (pre-ship Workflow or next slot)."),
      description: z.string().optional().describe("New description (pre-ship Workflow or next slot)."),
      body: z.string().optional().describe("Replace entire territory body below frontmatter."),
      toggle_checkboxes: z
        .array(
          z.object({
            contains: z.string().min(1).describe("Substring to match on a checkbox line."),
            checked: z.boolean().describe("true for [x], false for [ ]."),
          })
        )
        .optional()
        .describe("Toggle markdown checkboxes by matching line content."),
      slot: z
        .enum(["current", "next"])
        .optional()
        .describe("Territory slot to patch. Defaults to next when evolving a shipped node."),
    },
  },
  guarded(({ node_id, title, description, body, toggle_checkboxes, slot }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    const resolvedSlot: TerritorySlot =
      slot ??
      (node.next &&
      (node.type === "Foundation" || node.type === "Workflow") &&
      (node.state === "stable" || node.state === "unstable")
        ? "next"
        : "current");
    if (title !== undefined) {
      assertWorkflowTerritoryScalarsEditable(node, "title", resolvedSlot);
    }
    if (description !== undefined) {
      assertWorkflowTerritoryScalarsEditable(node, "description", resolvedSlot);
    }
    const result = patchNodeTerritory(node, {
      title,
      description,
      body,
      toggle_checkboxes,
      slot: resolvedSlot,
    });
    const pathWritten = territoryPath(node, result.slot);
    return ok({
      node_id,
      ...result,
      path: pathWritten,
      changed_files: changedFiles([pathWritten]),
    });
  })
);

server.registerTool(
  "create_node",
  {
    title: "Create node",
    description:
      "Creates a Journey, Foundation, Workflow, or Bug: scaffolds territory folder + current.mdx frontmatter. " +
      "Workflow/Foundation also scaffold src/workflows/<id> or src/foundations/<id> implementation packages.",
    inputSchema: {
      id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
      type: z.enum(NODE_TYPES).describe("Journey | Foundation | Workflow | Bug"),
      title: z.string().min(1).describe("Human-readable title (written to current.mdx frontmatter)."),
      description: z.string().describe("Short description (written to current.mdx frontmatter)."),
    },
  },
  guarded(({ id, type, title, description }) => {
    if (nodeExists(id)) {
      throw blocked(`node "${id}" already exists.`);
    }
    const now = new Date().toISOString();
    const node: MindPlanNode = {
      id,
      type,
      title,
      description,
      state: initialStateForType(type),
      created_at: now,
      updated_at: now,
    };
    ensureDirectories();
    scaffoldEntity(node, { title, description });
    const rel = entityRelativePath(node);
    const current = `${rel}/${CURRENT_FILENAME}`;
    const attachments = `${rel}/${ATTACHMENTS_DIR}`;
    const implementation = implementationRelativePath(node);
    refreshPersistedMap();
    const files = [current, `${attachments}/.gitkeep`];
    if (implementation) files.push(`${implementation}/.gitkeep`);
    return ok({
      created: node,
      folder: rel,
      current,
      context: current,
      attachments,
      ...(implementation ? { implementation } : {}),
      changed_files: changedFiles(files, true),
    });
  })
);

server.registerTool(
  "link_nodes",
  {
    title: "Link nodes",
    description:
      "Adds an edge to the DAG. Legal shapes: Workflow -belongs_to-> Journey (multiple per Workflow allowed), " +
      "Workflow -depends_on-> Foundation|Workflow, Foundation -depends_on-> Foundation, Bug -affects-> Workflow|Foundation. " +
      "When linking a Workflow to a Journey via belongs_to, pass link_dependent: true to auto-link transitively depended-on Workflows to the same Journey (Dependency Closure). " +
      "While a node has next.mdx, belongs_to/depends_on writes go to the next slot (proposed edges applied on ship).",
    inputSchema: {
      source_id: NODE_ID.describe("The id of the edge source node."),
      target_id: NODE_ID.describe("The id of the edge target node."),
      edge_type: z
        .enum(["depends_on", "belongs_to", "affects"])
        .describe("depends_on | belongs_to | affects"),
      link_dependent: z
        .boolean()
        .optional()
        .describe(
          "When linking a Workflow to a Journey via belongs_to, auto-link any transitively depended-on Workflow to the same Journey instead of rejecting (Dependency Closure)."
        ),
    },
  },
  guarded(({ source_id, target_id, edge_type, link_dependent }) => {
    const graph = loadGraph();
    const source = findNode(graph, source_id);
    const target = findNode(graph, target_id);
    validateLink(source, target, edge_type);

    if (edge_type === "depends_on") {
      assertAcyclicDependsOn(graph, source_id, target_id);
    }

    const writeSlot = edgeWriteSlot(source, edge_type);
    const existingOnSlot =
      writeSlot === "next" && source.next
        ? edge_type === "belongs_to"
          ? (source.next.belongs_to ?? []).includes(target_id)
          : edge_type === "depends_on"
            ? (source.next.depends_on ?? []).includes(target_id)
            : false
        : graph.edges.some(
            (e) => e.source === source_id && e.target === target_id && e.type === edge_type
          );

    if (existingOnSlot) {
      throw blocked(`edge ${source_id} -${edge_type}-> ${target_id} already exists.`);
    }

    const dependentsLinked: { source: string; target: string; type: "belongs_to" }[] = [];

    if (
      edge_type === "belongs_to" &&
      source.type === "Workflow" &&
      target.type === "Journey"
    ) {
      const missing = missingJourneyDependents(graph, source, target_id);
      if (missing.length > 0) {
        if (!link_dependent) {
          const ids = missing.map((n) => `"${n.id}"`).join(", ");
          throw blocked(
            `Dependency Closure. "${source_id}" depends on workflow(s) not linked to journey "${target_id}": ${ids}. Link them first, or retry with link_dependent: true.`
          );
        }
        for (const dep of missing) {
          dependentsLinked.push({ source: dep.id, target: target_id, type: "belongs_to" });
        }
      }
    }

    if (writeSlot === "current") {
      graph.edges.push({ source: source_id, target: target_id, type: edge_type });
    } else if (source.next) {
      if (edge_type === "belongs_to") {
        source.next.belongs_to = [...(source.next.belongs_to ?? []), target_id];
      } else if (edge_type === "depends_on") {
        source.next.depends_on = [...(source.next.depends_on ?? []), target_id];
      }
    }
    addEdgeToFrontmatter(source, edge_type, target_id);

    for (const link of dependentsLinked) {
      const dep = findNode(graph, link.source);
      graph.edges.push({ source: link.source, target: link.target, type: link.type });
      addEdgeToFrontmatter(dep, link.type, link.target);
    }

    const changedJourneys = recomputeJourneyStates(graph);
    const changedStability = recomputeStability(graph);
    syncNodes([...changedJourneys, ...changedStability]);
    refreshPersistedMap();
    const files = [
      territoryPath(source, writeSlot),
      ...dependentsLinked.map((link) => territoryPath(findNode(graph, link.source), "current")),
      ...changedJourneys.map((j) => territoryPath(j)),
      ...changedStability.map((n) => territoryPath(n)),
    ];
    return ok({
      linked: { source: source_id, target: target_id, type: edge_type },
      slot: writeSlot,
      dependents_linked: dependentsLinked,
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
      changed_files: changedFiles(files, true),
    });
  })
);

server.registerTool(
  "open_next",
  {
    title: "Open next evolution",
    description:
      "Opens next.mdx for a shipped Foundation or Workflow (stable/unstable). Copies current body and " +
      "outgoing belongs_to/depends_on into a draft next slot. The live node keeps serving under the same id. " +
      "Ship from next in-review to promote next over current; discard_next to abandon.",
    inputSchema: {
      node_id: NODE_ID.describe("Id of the shipped Workflow or Foundation to evolve."),
      title: z.string().min(1).optional().describe("Optional new title for the next slot."),
      description: z.string().optional().describe("Optional new description for the next slot."),
    },
  },
  guarded(({ node_id, title, description }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    validateOpenNext(node);
    const next = openNextSlot(node, { title, description });
    node.next = next;
    const rel = entityRelativePath(node);
    const current = `${rel}/${CURRENT_FILENAME}`;
    const next_path = `${rel}/${NEXT_FILENAME}`;
    refreshPersistedMap();
    return ok({
      node_id,
      live_state: node.state,
      next,
      folder: rel,
      current,
      next_path,
      changed_files: changedFiles([next_path, `${rel}/${NEXT_ATTACHMENTS_DIR}/.gitkeep`], true),
    });
  })
);

server.registerTool(
  "discard_next",
  {
    title: "Discard next evolution",
    description:
      "Deletes next.mdx (and next-attachments/) for a Foundation or Workflow, abandoning an in-flight evolution. " +
      "The live current.mdx is unchanged.",
    inputSchema: {
      node_id: NODE_ID.describe("Id of the node whose next slot to discard."),
    },
  },
  guarded(({ node_id }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    if (!node.next) {
      throw blocked(`node "${node_id}" has no next.mdx to discard.`);
    }
    const next_path = territoryPath(node, "next");
    const slotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: false });
    discardNextSlot(node);
    delete node.next;
    refreshPersistedMap();
    return ok({
      node_id,
      discarded: true,
      live_state: node.state,
      changed_files: changedFiles([next_path, ...slotFiles], true),
    });
  })
);

server.registerTool(
  "get_blast_radius",
  {
    title: "Get blast radius",
    description:
      "Returns all nodes that depend on the given node (transitive reverse depends_on closure), " +
      "with hop distance and journeys_at_risk for affected Workflows.",
    inputSchema: {
      node_id: NODE_ID.describe("The id of the node whose dependents to analyze."),
    },
  },
  guarded(({ node_id }) => {
    const graph = loadGraph();
    findNode(graph, node_id);
    const { affected: entries } = blastRadiusDependents(graph, node_id);
    const journeysAtRisk = new Set<string>();
    for (const { node } of entries) {
      if (node.type !== "Workflow") continue;
      for (const edge of graph.edges) {
        if (edge.source === node.id && edge.type === "belongs_to") {
          journeysAtRisk.add(edge.target);
        }
      }
    }
    return ok({
      node_id,
      affected: entries.map(({ node, distance }) => ({
        id: node.id,
        type: node.type,
        state: node.state,
        distance,
      })),
      journeys_at_risk: [...journeysAtRisk].sort(),
    });
  })
);

server.registerTool(
  "unlink_nodes",
  {
    title: "Unlink nodes",
    description: "Removes edge(s) between two nodes from the source node's frontmatter.",
    inputSchema: {
      source_id: NODE_ID.describe("The id of the edge source node."),
      target_id: NODE_ID.describe("The id of the edge target node."),
    },
  },
  guarded(({ source_id, target_id }) => {
    const graph = loadGraph();
    const source = findNode(graph, source_id);
    findNode(graph, target_id);
    const before = graph.edges.length;
    graph.edges = graph.edges.filter(
      (e) => !(e.source === source_id && e.target === target_id)
    );
    let removed = before - graph.edges.length;

    // Also remove from next proposed edges when present
    if (source.next) {
      const nextBelongs = source.next.belongs_to ?? [];
      const nextDepends = source.next.depends_on ?? [];
      if (nextBelongs.includes(target_id) || nextDepends.includes(target_id)) {
        source.next.belongs_to = nextBelongs.filter((id) => id !== target_id);
        source.next.depends_on = nextDepends.filter((id) => id !== target_id);
        if (source.next.belongs_to.length === 0) delete source.next.belongs_to;
        if (source.next.depends_on?.length === 0) delete source.next.depends_on;
        removed += 1;
      }
    }

    if (removed === 0) {
      throw blocked(`no edge exists between "${source_id}" and "${target_id}".`);
    }
    removeEdgesFromFrontmatter(source, target_id);
    const changedJourneys = recomputeJourneyStates(graph);
    const changedStability = recomputeStability(graph);
    syncNodes([...changedJourneys, ...changedStability]);
    refreshPersistedMap();
    // unlink may touch current and/or next frontmatter on the source
    const sourceFiles = [territoryPath(source, "current")];
    if (source.next) sourceFiles.push(territoryPath(source, "next"));
    const files = [
      ...sourceFiles,
      ...changedJourneys.map((j) => territoryPath(j)),
      ...changedStability.map((n) => territoryPath(n)),
    ];
    return ok({
      removed,
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
      changed_files: changedFiles(files, true),
    });
  })
);

server.registerTool(
  "update_node_status",
  {
    title: "Update node status",
    description:
      "Transitions a Foundation, Workflow, or Bug. Build pipeline: draft -> ready -> in-progress -> in-review -> ship (sets stable/unstable). " +
      "Bug pipeline: open -> triaged -> fixing -> in-review -> resolved | wontfix. " +
      "When next.mdx exists, build-pipeline transitions apply to the next slot; ship promotes next over current. " +
      "Journey and production stable/unstable are computed automatically.",
    inputSchema: {
      node_id: NODE_ID.describe("The id of the node to transition."),
      new_status: z
        .string()
        .describe(
          "Foundation/Workflow: draft | ready | in-progress | in-review | ship | cancelled | deprecated. " +
            "Bug: open | triaged | fixing | in-review | resolved | wontfix. " +
            "From stable/unstable: deprecated only (or open_next then build/ship next). " +
            "Pre-ship abandon: cancelled from draft|ready|in-progress|in-review."
        ),
    },
  },
  guarded(({ node_id, new_status }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);

    const resolved = resolveStatusChange(graph, node, new_status);

    const previous = node.next ? node.next.state : node.state;
    const now = new Date().toISOString();
    let promoted = false;
    let promoteSlotFiles: string[] = [];

    if (resolved.promote_next) {
      // Snapshot next-slot FS paths before promote deletes next.mdx / next-attachments
      promoteSlotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: true });
      promoteNextSlot(node, resolved.state, now);
      promoted = true;
      // Refresh graph edges from promoted node
      graph.edges = graph.edges.filter((e) => e.source !== node_id);
      if (node.belongs_to) {
        for (const t of node.belongs_to) {
          graph.edges.push({ source: node_id, target: t, type: "belongs_to" });
        }
      }
      if (node.depends_on) {
        for (const t of node.depends_on) {
          graph.edges.push({ source: node_id, target: t, type: "depends_on" });
        }
      }
    } else if (resolved.ship) {
      node.shipped_at = now;
      node.state = resolved.state;
      node.updated_at = now;
      patchFrontmatter(node);
    } else if (node.next && isNextPipelineState(resolved.state)) {
      node.next.state = resolved.state;
      node.next.updated_at = now;
      patchFrontmatter(
        {
          id: node.id,
          type: node.type,
          state: resolved.state,
          updated_at: now,
        },
        "next"
      );
    } else {
      node.state = resolved.state;
      node.updated_at = now;
      patchFrontmatter(node);
    }

    const changedStability = recomputeStability(graph);
    const changedJourneys = recomputeJourneyStates(graph);
    syncNodes([...changedStability, ...changedJourneys]);
    refreshPersistedMap();

    const primaryPaths: string[] = [];
    if (promoted) {
      primaryPaths.push(territoryPath(node, "current"));
      primaryPaths.push(...promoteSlotFiles);
    } else if (node.next && isNextPipelineState(resolved.state)) {
      primaryPaths.push(territoryPath(node, "next"));
    } else {
      primaryPaths.push(territoryPath(node, "current"));
    }
    const files = [
      ...primaryPaths,
      ...changedJourneys.map((j) => territoryPath(j)),
      ...changedStability.map((n) => territoryPath(n)),
    ];

    return ok({
      node_id,
      previous_state: previous,
      new_state: node.state,
      next_state: node.next?.state ?? null,
      shipped_at: node.shipped_at,
      promoted_next: promoted,
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      changed_files: changedFiles(files, true),
    });
  })
);

server.registerTool(
  "force_unship",
  {
    title: "Force unship (mistaken ship recovery)",
    description:
      "DANGEROUS recovery only. Ask the user first and wait for an explicit yes — never invent confirmation. " +
      "Reverses a mistaken Foundation/Workflow ship: clears shipped_at and sets a pre-ship state (default ready). " +
      'Requires confirm exactly equal to "unship:<node_id>". Blocked while next.mdx is open or shipped dependents exist.',
    inputSchema: {
      node_id: NODE_ID.describe("Stable/unstable Foundation or Workflow to unship."),
      confirm: z
        .string()
        .describe('Exact token after user confirmation: "unship:<node_id>". Do not invent this.'),
      new_status: z
        .enum(["draft", "ready", "in-progress", "in-review"])
        .optional()
        .describe("Pre-ship target state (default ready)."),
    },
  },
  guarded(({ node_id, confirm, new_status }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    const target = new_status ?? "ready";
    const previous = node.state;

    resolveForceUnship(graph, node, target, confirm);

    const now = new Date().toISOString();
    delete node.shipped_at;
    node.state = target;
    node.updated_at = now;
    patchFrontmatter(node, "current", { clearShippedAt: true });

    const changedStability = recomputeStability(graph);
    const changedJourneys = recomputeJourneyStates(graph);
    syncNodes([...changedStability, ...changedJourneys]);
    refreshPersistedMap();

    const files = [
      territoryPath(node),
      ...changedJourneys.map((j) => territoryPath(j)),
      ...changedStability.map((n) => territoryPath(n)),
    ];

    return ok({
      node_id,
      previous_state: previous,
      new_state: node.state,
      shipped_at: null,
      force_unship: true,
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      changed_files: changedFiles(files, true),
    });
  })
);

async function runMcpServer() {
  ensureDirectories();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MindPlan MCP server running on stdio");
}

function parseViewArgs(argv: string[]): {
  format: "mermaid" | "dot";
  focus?: string;
  include_retired: boolean;
  output?: string;
} {
  let format: "mermaid" | "dot" = "mermaid";
  let focus: string | undefined;
  let include_retired = false;
  let output: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format" || arg === "-f") {
      const value = argv[++i];
      if (value !== "mermaid" && value !== "dot") {
        throw new Error(`Invalid --format "${value ?? ""}". Use mermaid or dot.`);
      }
      format = value;
    } else if (arg === "--focus") {
      focus = argv[++i];
      if (!focus) throw new Error("--focus requires a node id.");
    } else if (arg === "--include-retired") {
      include_retired = true;
    } else if (arg === "--output" || arg === "-o") {
      output = argv[++i];
      if (!output) throw new Error("--output requires a file path.");
    } else if (arg === "export") {
      // alias accepted as subcommand synonym — ignore
    } else {
      throw new Error(`Unknown view option: ${arg}`);
    }
  }

  return { format, focus, include_retired, output };
}

function runViewCli(argv: string[]): void {
  const opts = parseViewArgs(argv);
  if (opts.focus) {
    const graph = loadGraph();
    findNode(graph, opts.focus);
  }
  const result = exportMindPlanView(loadGraph(), {
    format: opts.format,
    focus: opts.focus,
    include_retired: opts.include_retired,
  });
  if (opts.output) {
    fs.writeFileSync(opts.output, result.diagram, "utf-8");
    console.error(
      `Wrote ${result.format} view (${result.node_count} nodes, ${result.edge_count} edges) to ${opts.output}`
    );
  } else {
    process.stdout.write(result.diagram);
  }
}

function parseCheckArgs(argv: string[]): { forMain: boolean; base?: string } {
  let forMain = false;
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--for-main") {
      forMain = true;
    } else if (arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error("Blocked: --base requires a git ref.");
      base = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("HELP");
    } else {
      throw new Error(`Blocked: unknown check option "${arg}".`);
    }
  }
  return { forMain, base };
}

function runCheckCli(argv: string[]): void {
  try {
    const opts = parseCheckArgs(argv);
    const result = runIntegrityCheck({ forMain: opts.forMain, base: opts.base });
    if (result.ok) {
      console.log(
        opts.forMain
          ? "mindplan-mcp check --for-main: ok"
          : "mindplan-mcp check: ok"
      );
      return;
    }
    for (const line of result.failures) {
      console.error(line);
    }
    process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "HELP") {
      console.log(`Usage:
  mindplan-mcp check [--base <ref>]   Graph + packages + dirty src ownership
  mindplan-mcp check --for-main       Graph + packages + no mid-pipeline states

Options:
  --base <ref>   Git base for commit diff (default: merge-base with main/master)
  --for-main     Merge gate: ban in-progress/in-review (and Bug fixing/in-review)
`);
      return;
    }
    console.error(message.startsWith("Blocked:") ? message : `Error: ${message}`);
    process.exit(1);
  }
}

function runCli() {
  const cmd = process.argv[2];
  if (cmd === "init") {
    const packageRoot = resolvePackageRoot(import.meta.url);
    const { root, created } = initProject();
    const playbook = installAgentPlaybook(packageRoot);
    const skill = installDefineEntitiesSkill(packageRoot);
    const planSkill = installPlanProjectSkill(packageRoot);
    const mcpExample = installMcpExample(packageRoot);
    const integrations = installAgentIntegrations(packageRoot);
    const agentsMd = installRootAgentsMd(packageRoot);
    const cursorIgnore = installCursorIgnore(packageRoot);
    const cursorPermissions = installCursorPermissions(packageRoot);

    if (created) {
      console.log(`Initialized MindPlan at ${root}`);
    } else {
      console.log(`MindPlan already initialized at ${root}`);
    }

    const report = (label: string, result: { installed: boolean; path: string }) => {
      console.log(
        result.installed ? `Installed ${label} at ${result.path}` : `${label} already present at ${result.path}`
      );
    };

    report("agent playbook", playbook);
    report("define-entities skill", skill);
    report("plan-project skill", planSkill);
    report("MCP example", mcpExample);
    report("agent integrations", integrations);
    report("AGENTS.md", agentsMd);
    report(".cursorignore", cursorIgnore);
    report(".cursor/permissions.json", cursorPermissions);

    if (!agentsMd.installed) {
      console.log("Tip: add a reference to mindplan/agent/playbook.md in your existing AGENTS.md.");
    }

    console.log("Next: register the MindPlan MCP server — see mindplan/agent/integrations/");
    return;
  }

  if (cmd === "view" || cmd === "export") {
    try {
      runViewCli(process.argv.slice(3));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message.startsWith("Blocked:") ? message : `Error: ${message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "check") {
    runCheckCli(process.argv.slice(3));
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`Usage:
  mindplan-mcp              Start the MCP server (stdio)
  mindplan-mcp init         Scaffold mindplan/, agent playbook, skills, integrations, and .cursorignore
  mindplan-mcp view         Print a Mermaid/DOT projection of the territory graph
  mindplan-mcp export       Alias for view
  mindplan-mcp check        Offline integrity: graph, packages, dirty src (or --for-main)
  mindplan-mcp help         Show this message

View options:
  --format, -f mermaid|dot  Diagram format (default: mermaid)
  --focus <node-id>         Focus node + 1-hop neighborhood only
  --include-retired         Include deprecated/cancelled nodes and closed bugs
  --output, -o <file>       Write diagram to a file instead of stdout

Check options:
  --base <ref>              Git base for dirty-src commit diff
  --for-main                Fail if any mid-pipeline Foundation/Workflow/Bug states

Environment:
  MINDPLAN_ROOT   Project root containing mindplan/ (default: cwd)`);
    return;
  }

  if (cmd) {
    console.error(`Unknown command: ${cmd}`);
    console.error("Run mindplan-mcp help for usage.");
    process.exit(1);
  }

  runMcpServer().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

runCli();
