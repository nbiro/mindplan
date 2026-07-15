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

import { NODE_TYPES, initialStateForType, isProductionState, type MindPlanNode } from "./types.js";
import {
  ensureDirectories,
  initProject,
  installAgentPlaybook,
  installAgentIntegrations,
  installDefineEntitiesSkill,
  installMcpExample,
  installRootAgentsMd,
  ATTACHMENTS_DIR,
  CONTEXT_FILENAME,
  entityRelativePath,
  loadGraph,
  nodeExists,
  listAttachments,
  readMarkdown,
  scaffoldEntity,
  patchFrontmatter,
  addEdgeToFrontmatter,
  removeEdgesFromFrontmatter,
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
  validateNewVersion,
  findPredecessor,
  transitiveDependents,
  dependentsOf,
} from "./rules.js";
import { DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT, findRelatedNodes } from "./search.js";

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

const NODE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "ids must be kebab_case/slug style: lowercase letters, digits, - and _");

server.registerTool(
  "get_mindplan_graph",
  {
    title: "Get MindPlan graph",
    description:
      "Returns the full MindPlan graph — nodes and edges assembled from context.mdx frontmatter.",
    inputSchema: {},
  },
  guarded(() => ok(loadGraph()))
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
  "get_node_context",
  {
    title: "Get node context",
    description:
      "Returns context.mdx (title, description, body), plus attachment paths and filenames.",
    inputSchema: {
      node_id: NODE_ID.describe("The id of the node whose context.mdx to read."),
    },
  },
  guarded(({ node_id }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);
    const rel = entityRelativePath(node);
    return ok({
      folder: rel,
      context_path: `${rel}/${CONTEXT_FILENAME}`,
      attachments_path: `${rel}/${ATTACHMENTS_DIR}`,
      attachments: listAttachments(node),
      title: node.title,
      description: node.description,
      context: readMarkdown(node),
    });
  })
);

server.registerTool(
  "create_node",
  {
    title: "Create node",
    description:
      "Creates a Journey, Foundation, Workflow, or Bug: scaffolds territory folder + context.mdx frontmatter.",
    inputSchema: {
      id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
      type: z.enum(NODE_TYPES).describe("Journey | Foundation | Workflow | Bug"),
      title: z.string().min(1).describe("Human-readable title (written to context.mdx frontmatter)."),
      description: z.string().describe("Short description (written to context.mdx frontmatter)."),
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
    return ok({
      created: node,
      folder: rel,
      context: `${rel}/${CONTEXT_FILENAME}`,
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
      "Version lineage (supersedes) is managed via create_node_version.",
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

    if (
      graph.edges.some(
        (e) => e.source === source_id && e.target === target_id && e.type === edge_type
      )
    ) {
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

    graph.edges.push({ source: source_id, target: target_id, type: edge_type });
    addEdgeToFrontmatter(source, edge_type, target_id);

    for (const link of dependentsLinked) {
      graph.edges.push({ source: link.source, target: link.target, type: link.type });
      addEdgeToFrontmatter(findNode(graph, link.source), link.type, link.target);
    }

    const changedJourneys = recomputeJourneyStates(graph);
    const changedStability = recomputeStability(graph);
    syncNodes([...changedJourneys, ...changedStability]);
    return ok({
      linked: { source: source_id, target: target_id, type: edge_type },
      dependents_linked: dependentsLinked,
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    });
  })
);

server.registerTool(
  "create_node_version",
  {
    title: "Create node version",
    description:
      "Creates a new draft version of a shipped Workflow or Foundation. Links supersedes -> previous, " +
      "inherits belongs_to and depends_on from the predecessor, and duplicates each direct incoming depends_on " +
      "edge so dependents also depend on the new version (old edge preserved). Predecessor keeps serving until this version ships.",
    inputSchema: {
      previous_id: NODE_ID.describe("Id of the shipped Workflow or Foundation to supersede."),
      id: NODE_ID.describe("Unique slug id for the new version node."),
      title: z.string().min(1).describe("Human-readable title for the new version."),
      description: z.string().describe("Short description for the new version."),
    },
  },
  guarded(({ previous_id, id, title, description }) => {
    const graph = loadGraph();
    const previous = findNode(graph, previous_id);
    if (nodeExists(id)) {
      throw blocked(`node "${id}" already exists.`);
    }
    validateNewVersion(graph, previous);

    const now = new Date().toISOString();
    const node: MindPlanNode = {
      id,
      type: previous.type,
      title,
      description,
      state: "draft",
      created_at: now,
      updated_at: now,
      supersedes: [previous_id],
    };
    if (previous.belongs_to?.length) node.belongs_to = [...previous.belongs_to];
    if (previous.depends_on?.length) node.depends_on = [...previous.depends_on];

    const incomingDependents = dependentsOf(graph, previous_id);
    for (const dependent of incomingDependents) {
      assertAcyclicDependsOn(graph, dependent.id, id);
    }

    ensureDirectories();
    scaffoldEntity(node, { title, description });
    addEdgeToFrontmatter(node, "supersedes", previous_id);
    if (node.belongs_to) {
      for (const j of node.belongs_to) addEdgeToFrontmatter(node, "belongs_to", j);
    }
    if (node.depends_on) {
      for (const d of node.depends_on) addEdgeToFrontmatter(node, "depends_on", d);
    }

    const dependentsRelinked: { source: string; target: string; type: "depends_on" }[] = [];
    for (const dependent of incomingDependents) {
      const exists = graph.edges.some(
        (e) =>
          e.source === dependent.id && e.target === id && e.type === "depends_on"
      );
      if (exists) continue;
      graph.edges.push({ source: dependent.id, target: id, type: "depends_on" });
      addEdgeToFrontmatter(dependent, "depends_on", id);
      dependentsRelinked.push({ source: dependent.id, target: id, type: "depends_on" });
    }

    const rel = entityRelativePath(node);
    return ok({
      created: node,
      predecessor: {
        id: previous_id,
        state: previous.state,
        note: "will auto-deprecate when this version ships",
      },
      inherited_edges: {
        belongs_to: node.belongs_to ?? [],
        depends_on: node.depends_on ?? [],
      },
      dependents_relinked: dependentsRelinked,
      folder: rel,
      context: `${rel}/${CONTEXT_FILENAME}`,
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
    const entries = transitiveDependents(graph, node_id);
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
    findNode(graph, source_id);
    findNode(graph, target_id);
    const before = graph.edges.length;
    graph.edges = graph.edges.filter(
      (e) => !(e.source === source_id && e.target === target_id)
    );
    const removed = before - graph.edges.length;
    if (removed === 0) {
      throw blocked(`no edge exists between "${source_id}" and "${target_id}".`);
    }
    removeEdgesFromFrontmatter(findNode(graph, source_id), target_id);
    const changedJourneys = recomputeJourneyStates(graph);
    const changedStability = recomputeStability(graph);
    syncNodes([...changedJourneys, ...changedStability]);
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
      "Journey and production stable/unstable are computed automatically.",
    inputSchema: {
      node_id: NODE_ID.describe("The id of the node to transition."),
      new_status: z
        .string()
        .describe(
          "Foundation/Workflow: draft | ready | in-progress | in-review | ship | deprecated. " +
            "Bug: open | triaged | fixing | in-review | resolved | wontfix. " +
            "From stable/unstable: deprecated only."
        ),
    },
  },
  guarded(({ node_id, new_status }) => {
    const graph = loadGraph();
    const node = findNode(graph, node_id);

    const resolved = resolveStatusChange(graph, node, new_status);

    const previous = node.state;
    const now = new Date().toISOString();
    if (resolved.ship) {
      node.shipped_at = now;
    }
    node.state = resolved.state;
    node.updated_at = now;

    let predecessorDeprecated: {
      id: string;
      previous_state: string;
      new_state: "deprecated";
    } | null = null;

    const nodesToSync: MindPlanNode[] = [node];

    if (resolved.ship) {
      const predecessor = findPredecessor(graph, node_id);
      if (predecessor && isProductionState(predecessor.state)) {
        const predPrevious = predecessor.state;
        predecessor.state = "deprecated";
        predecessor.updated_at = now;
        predecessorDeprecated = {
          id: predecessor.id,
          previous_state: predPrevious,
          new_state: "deprecated",
        };
        nodesToSync.push(predecessor);
      }
    }

    const changedStability = recomputeStability(graph);
    const changedJourneys = recomputeJourneyStates(graph);
    for (const n of nodesToSync) patchFrontmatter(n);
    syncNodes([...changedStability, ...changedJourneys]);

    return ok({
      node_id,
      previous_state: previous,
      new_state: node.state,
      shipped_at: node.shipped_at,
      predecessor_deprecated: predecessorDeprecated,
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

    if (!agentsMd.installed) {
      console.log("Tip: add a reference to mindplan/agent/playbook.md in your existing AGENTS.md.");
    }

    console.log("Next: register the MindPlan MCP server — see mindplan/agent/integrations/");
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`Usage:
  mindplan-mcp              Start the MCP server (stdio)
  mindplan-mcp init         Scaffold mindplan/, agent playbook, skills, and integrations
  mindplan-mcp help         Show this message

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
