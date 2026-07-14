#!/usr/bin/env node
/**
 * MindPlan MCP server — an API gateway and strict compiler for the MindPlan
 * SDLC framework. Persists state to /.mindplan on the local file system and
 * communicates over stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { EDGE_TYPES, NODE_TYPES, initialStateForType, type MindPlanNode } from "./types.js";
import {
  ensureDirectories,
  initProject,
  ATTACHMENTS_DIR,
  CONTEXT_FILENAME,
  entityRelativePath,
  readGraph,
  listAttachments,
  readMarkdown,
  scaffoldEntity,
  syncMarkdownState,
  writeGraph,
} from "./store.js";
import {
  blocked,
  findNode,
  recomputeJourneyStates,
  recomputeStability,
  resolveStatusChange,
  validateLink,
} from "./rules.js";

const server = new McpServer({
  name: "mindplan",
  version: "1.0.0",
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
  for (const n of nodes) syncMarkdownState(n);
}

const NODE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "ids must be kebab_case/slug style: lowercase letters, digits, - and _");

server.registerTool(
  "get_mindplan_graph",
  {
    title: "Get MindPlan graph",
    description:
      "Returns the full parsed mindplan.json — every node (Journey, Foundation, Workflow, Bug) and every edge in the DAG.",
    inputSchema: {},
  },
  guarded(() => ok(readGraph()))
);

server.registerTool(
  "get_node_context",
  {
    title: "Get node context",
    description:
      "Returns the raw context.mdx for a node, plus any files in its attachments/ folder.",
    inputSchema: {
      node_id: NODE_ID.describe("The id of the node whose context.mdx to read."),
    },
  },
  guarded(({ node_id }) => {
    const graph = readGraph();
    const node = findNode(graph, node_id);
    const rel = entityRelativePath(node);
    return ok({
      folder: rel,
      context_path: `${rel}/${CONTEXT_FILENAME}`,
      attachments_path: `${rel}/${ATTACHMENTS_DIR}`,
      attachments: listAttachments(node),
      context: readMarkdown(node),
    });
  })
);

server.registerTool(
  "create_node",
  {
    title: "Create node",
    description:
      "Creates a Journey, Foundation, Workflow, or Bug: adds it to mindplan.json, scaffolds <type>s/<id>/context.mdx, and creates an attachments/ folder.",
    inputSchema: {
      id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
      type: z.enum(NODE_TYPES).describe("Journey | Foundation | Workflow | Bug"),
      title: z.string().min(1).describe("Human-readable title."),
      description: z.string().describe("Short description of the node's purpose."),
    },
  },
  guarded(({ id, type, title, description }) => {
    const graph = readGraph();
    if (graph.nodes.some((n) => n.id === id)) {
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
    graph.nodes.push(node);
    ensureDirectories();
    scaffoldEntity(node);
    writeGraph(graph);
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
      "Adds an edge to the DAG. Legal shapes: Workflow -belongs_to-> Journey, Workflow|Foundation -depends_on-> Foundation, Bug -affects-> Workflow|Foundation.",
    inputSchema: {
      source_id: NODE_ID.describe("The id of the edge source node."),
      target_id: NODE_ID.describe("The id of the edge target node."),
      edge_type: z.enum(EDGE_TYPES).describe("depends_on | belongs_to | affects"),
    },
  },
  guarded(({ source_id, target_id, edge_type }) => {
    const graph = readGraph();
    const source = findNode(graph, source_id);
    const target = findNode(graph, target_id);
    validateLink(source, target, edge_type);
    if (
      graph.edges.some(
        (e) => e.source === source_id && e.target === target_id && e.type === edge_type
      )
    ) {
      throw blocked(`edge ${source_id} -${edge_type}-> ${target_id} already exists.`);
    }
    graph.edges.push({ source: source_id, target: target_id, type: edge_type });
    const changedJourneys = recomputeJourneyStates(graph);
    const changedStability = recomputeStability(graph);
    writeGraph(graph);
    syncNodes([...changedJourneys, ...changedStability]);
    return ok({
      linked: { source: source_id, target: target_id, type: edge_type },
      journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
      stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    });
  })
);

server.registerTool(
  "unlink_nodes",
  {
    title: "Unlink nodes",
    description: "Removes edge(s) between two nodes from the edges array.",
    inputSchema: {
      source_id: NODE_ID.describe("The id of the edge source node."),
      target_id: NODE_ID.describe("The id of the edge target node."),
    },
  },
  guarded(({ source_id, target_id }) => {
    const graph = readGraph();
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
    const changedJourneys = recomputeJourneyStates(graph);
    const changedStability = recomputeStability(graph);
    writeGraph(graph);
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
    const graph = readGraph();
    const node = findNode(graph, node_id);

    const resolved = resolveStatusChange(graph, node, new_status);

    const previous = node.state;
    const now = new Date().toISOString();
    if (resolved.ship) {
      node.shipped_at = now;
    }
    node.state = resolved.state;
    node.updated_at = now;

    const changedStability = recomputeStability(graph);
    const changedJourneys = recomputeJourneyStates(graph);
    writeGraph(graph);
    syncMarkdownState(node);
    syncNodes([...changedStability, ...changedJourneys]);

    return ok({
      node_id,
      previous_state: previous,
      new_state: node.state,
      shipped_at: node.shipped_at,
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
    const { root, created } = initProject();
    if (created) {
      console.log(`Initialized MindPlan at ${root}`);
      console.log("Next: register the MCP server in .cursor/mcp.json (see README).");
    } else {
      console.log(`MindPlan already initialized at ${root}`);
    }
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`Usage:
  mindplan-mcp              Start the MCP server (stdio)
  mindplan-mcp init         Scaffold .mindplan/ in the current project
  mindplan-mcp help         Show this message

Environment:
  MINDPLAN_ROOT   Project root containing .mindplan/ (default: cwd)`);
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
