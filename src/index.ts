#!/usr/bin/env node
/**
 * MindPlan MCP server — an API gateway and strict compiler for the MindPlan
 * SDLC framework. Persists state to /mindplan on the local file system and
 * communicates over stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "path";
import { fileURLToPath } from "url";

import { NODE_TYPES, initialStateForType, isNextPipelineState, type MindPlanNode } from "./types.js";
import {
  ensureDirectories,
  initProject,
  installAgentPlaybook,
  installAgentIntegrations,
  installCursorIgnore,
  installDefineEntitiesSkill,
  installMcpExample,
  installRootAgentsMd,
  ATTACHMENTS_DIR,
  CURRENT_FILENAME,
  NEXT_FILENAME,
  NEXT_ATTACHMENTS_DIR,
  entityRelativePath,
  loadGraph,
  nodeExists,
  listAttachments,
  listAffectedFiles,
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
  type TerritorySlot,
} from "./store.js";
import {
  blocked,
  findNode,
  recomputeJourneyStates,
  recomputeStability,
  resolveStatusChange,
  validateLink,
  assertAcyclicDependsOn,
  missingJourneyDependents,
  validateOpenNext,
  blastRadiusDependents,
  assertWorkflowTerritoryScalarsEditable,
} from "./rules.js";
import { DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT, findRelatedNodes } from "./search.js";
import { VIEW_FORMATS, exportMindPlanView, persistMindPlanMap } from "./view.js";
import * as fs from "fs";

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
      "By default hides deprecated nodes and closed bugs. Prefer find_related_nodes for agent orientation JSON; " +
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
          "Include deprecated nodes and closed bugs (resolved/wontfix). Default false."
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
  "get_workflow_files",
  {
    title: "Get workflow files",
    description:
      "Returns the list of project files recorded in a Workflow's current.mdx (or next.mdx when evolving) " +
      "`## Affected Files` section. Agents maintain that list during implementation.",
    inputSchema: {
      node_id: NODE_ID.describe("Workflow id whose affected-files list to read."),
    },
  },
  guarded(({ node_id }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    return ok({
      node_id,
      files: listAffectedFiles(node),
    });
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
      "(pre-ship Workflows or next slot), toggle_checkboxes, append_affected_files. " +
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
      append_affected_files: z
        .array(z.string().min(1))
        .optional()
        .describe("Append project-relative paths to ## Affected Files (Workflow only)."),
      slot: z
        .enum(["current", "next"])
        .optional()
        .describe("Territory slot to patch. Defaults to next when evolving a shipped node."),
    },
  },
  guarded(({ node_id, title, description, body, toggle_checkboxes, append_affected_files, slot }) => {
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
      append_affected_files,
      slot: resolvedSlot,
    });
    return ok({ node_id, ...result });
  })
);

server.registerTool(
  "create_node",
  {
    title: "Create node",
    description:
      "Creates a Journey, Foundation, Workflow, or Bug: scaffolds territory folder + current.mdx frontmatter.",
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
    refreshPersistedMap();
    return ok({
      created: node,
      folder: rel,
      current: `${rel}/${CURRENT_FILENAME}`,
      context: `${rel}/${CURRENT_FILENAME}`,
      attachments: `${rel}/${ATTACHMENTS_DIR}`,
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
    return ok({
      linked: { source: source_id, target: target_id, type: edge_type },
      slot: writeSlot,
      dependents_linked: dependentsLinked,
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
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
    refreshPersistedMap();
    return ok({
      node_id,
      live_state: node.state,
      next,
      folder: rel,
      current: `${rel}/${CURRENT_FILENAME}`,
      next_path: `${rel}/${NEXT_FILENAME}`,
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
    discardNextSlot(node);
    delete node.next;
    refreshPersistedMap();
    return ok({ node_id, discarded: true, live_state: node.state });
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
    return ok({
      removed,
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
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
          "Foundation/Workflow: draft | ready | in-progress | in-review | ship | deprecated. " +
            "Bug: open | triaged | fixing | in-review | resolved | wontfix. " +
            "From stable/unstable: deprecated only (or open_next then build/ship next)."
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

    if (resolved.promote_next) {
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

    return ok({
      node_id,
      previous_state: previous,
      new_state: node.state,
      next_state: node.next?.state ?? null,
      shipped_at: node.shipped_at,
      promoted_next: promoted,
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
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

function runCli() {
  const cmd = process.argv[2];
  if (cmd === "init") {
    const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const { root, created } = initProject();
    const playbook = installAgentPlaybook(packageRoot);
    const skill = installDefineEntitiesSkill(packageRoot);
    const mcpExample = installMcpExample(packageRoot);
    const integrations = installAgentIntegrations(packageRoot);
    const agentsMd = installRootAgentsMd(packageRoot);
    const cursorIgnore = installCursorIgnore(packageRoot);

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
    report("MCP example", mcpExample);
    report("agent integrations", integrations);
    report("AGENTS.md", agentsMd);
    report(".cursorignore", cursorIgnore);

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

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`Usage:
  mindplan-mcp              Start the MCP server (stdio)
  mindplan-mcp init         Scaffold mindplan/, agent playbook, skills, integrations, and .cursorignore
  mindplan-mcp view         Print a Mermaid/DOT projection of the territory graph
  mindplan-mcp export       Alias for view
  mindplan-mcp help         Show this message

View options:
  --format, -f mermaid|dot  Diagram format (default: mermaid)
  --focus <node-id>         Focus node + 1-hop neighborhood only
  --include-retired         Include deprecated nodes and closed bugs
  --output, -o <file>       Write diagram to a file instead of stdout

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
