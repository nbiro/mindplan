/**
 * MCP tools Interface — registers orient, steer, and export handlers with schemas
 * and the ok/guarded envelope. Does not own domain logic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { EDGE_TYPES, NODE_TYPES } from "../../foundations/f-domain-model/types.js";
import { DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT } from "../../foundations/f-graph-search/search.js";
import { VIEW_FORMATS } from "../../foundations/f-view-projection/view.js";
import {
  findRelatedNodesHandler,
  getBlastRadius,
  getMindPlanGraph,
  getNodeContext,
  getNodeImplementationHandler,
  orientForWork,
} from "../../interactions/i-orient-plan/handlers.js";
import {
  createNode,
  discardNext,
  forceUnship,
  linkNodes,
  openNext,
  patchNodeTerritory,
  unlinkNodes,
  updateNodeStatus,
} from "../../interactions/i-steer-plan/handlers.js";
import { exportMindPlanViewHandler } from "../../interactions/i-export-map/handlers.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function guarded<A>(handler: (args: A) => unknown): (args: A) => ToolResult {
  return (args: A) => {
    try {
      return ok(handler(args));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

const NODE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "ids must be kebab_case/slug style: lowercase letters, digits, - and _");

/** Register every MindPlan MCP tool onto the given server. */
export function registerMindPlanTools(server: McpServer): void {
  server.registerTool(
    "get_mindplan_graph",
    {
      title: "Get MindPlan graph",
      description:
        "Returns the full MindPlan graph — nodes and edges assembled from current.mdx frontmatter.",
      inputSchema: {},
    },
    guarded(() => getMindPlanGraph())
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
    guarded(({ format, focus, include_retired }) =>
      exportMindPlanViewHandler({ format, focus, include_retired })
    )
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
    guarded(({ query, node_id, type, limit }) =>
      findRelatedNodesHandler({ query, node_id, type, limit })
    )
  );

  server.registerTool(
    "get_node_implementation",
    {
      title: "Get node implementation",
      description:
        "Returns implementation package info for an Interaction, Interface, or Foundation. " +
        "When implementation_packages is required: root is src/interactions/<id>, src/interfaces/<id>, or src/foundations/<id>, plus exists/entries. " +
        "When off (layout-free): root is null and exists is false — packages are not applicable; check implementation_packages before treating as missing.",
      inputSchema: {
        node_id: NODE_ID.describe(
          "Interaction, Interface, or Foundation id whose implementation package to read."
        ),
      },
    },
    guarded(({ node_id }) => getNodeImplementationHandler({ node_id }))
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
    guarded(({ node_id }) => getNodeContext({ node_id }))
  );

  server.registerTool(
    "orient_for_work",
    {
      title: "Orient for work",
      description:
        "Composite orientation: find_related_nodes + get_node_context (record+body) for focus, " +
        "plus get_blast_radius when focus is a Foundation, Interaction, or Interface. " +
        "Interaction focus also includes reachability (exposing Interfaces, containing Journeys, leads_to downstream). " +
        "Prefer this to start a work session.",
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
    guarded(({ query, node_id, type, limit }) =>
      orientForWork({ query, node_id, type, limit })
    )
  );

  server.registerTool(
    "patch_node_territory",
    {
      title: "Patch node territory",
      description:
        "Patches territory-owned content: body (PRD, checklists), optional title/description " +
        "(pre-ship Interaction/Interface or next slot), toggle_checkboxes. " +
        "When a shipped Foundation/Interaction/Interface has next.mdx, patches default to next. Optional slot: current|next.",
      inputSchema: {
        node_id: NODE_ID.describe("Node whose territory to patch."),
        title: z
          .string()
          .min(1)
          .optional()
          .describe("New title (pre-ship Interaction/Interface or next slot)."),
        description: z
          .string()
          .optional()
          .describe("New description (pre-ship Interaction/Interface or next slot)."),
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
    guarded(({ node_id, title, description, body, toggle_checkboxes, slot }) =>
      patchNodeTerritory({ node_id, title, description, body, toggle_checkboxes, slot })
    )
  );

  server.registerTool(
    "create_node",
    {
      title: "Create node",
      description:
        "Creates a Journey, Interaction, Interface, Foundation, or Bug: scaffolds territory folder + current.mdx frontmatter. " +
        "When implementation_packages is required (default), Interaction/Interface/Foundation also scaffold " +
        "src/interactions/<id>, src/interfaces/<id>, or src/foundations/<id>. " +
        "When off (layout-free), only territory is created.",
      inputSchema: {
        id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
        type: z.enum(NODE_TYPES).describe("Journey | Interaction | Interface | Foundation | Bug"),
        title: z.string().min(1).describe("Human-readable title (written to current.mdx frontmatter)."),
        description: z.string().describe("Short description (written to current.mdx frontmatter)."),
      },
    },
    guarded(({ id, type, title, description }) => createNode({ id, type, title, description }))
  );

  server.registerTool(
    "link_nodes",
    {
      title: "Link nodes",
      description:
        "Adds an edge to the DAG. Legal shapes: Interaction -belongs_to-> Journey, " +
        "Interaction|Interface -depends_on-> Foundation, Foundation -depends_on-> Foundation, " +
        "Interface -exposes-> Interaction, Interaction -leads_to-> Interaction, " +
        "Bug -affects-> Interaction|Interface|Foundation. " +
        "While a node has next.mdx, belongs_to/depends_on/exposes/leads_to writes go to the next slot (proposed edges applied on ship).",
      inputSchema: {
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
        edge_type: z
          .enum(EDGE_TYPES)
          .describe("belongs_to | depends_on | exposes | leads_to | affects"),
      },
    },
    guarded(({ source_id, target_id, edge_type }) =>
      linkNodes({ source_id, target_id, edge_type })
    )
  );

  server.registerTool(
    "open_next",
    {
      title: "Open next evolution",
      description:
        "Opens next.mdx for a shipped Foundation, Interaction, or Interface (stable/unstable). Copies current body and " +
        "outgoing belongs_to/depends_on/exposes/leads_to into a draft next slot. The live node keeps serving under the same id. " +
        "Ship from next in-review to promote next over current; discard_next to abandon.",
      inputSchema: {
        node_id: NODE_ID.describe(
          "Id of the shipped Foundation, Interaction, or Interface to evolve."
        ),
        title: z.string().min(1).optional().describe("Optional new title for the next slot."),
        description: z.string().optional().describe("Optional new description for the next slot."),
      },
    },
    guarded(({ node_id, title, description }) => openNext({ node_id, title, description }))
  );

  server.registerTool(
    "discard_next",
    {
      title: "Discard next evolution",
      description:
        "Deletes next.mdx (and next-attachments/) for a Foundation, Interaction, or Interface, abandoning an in-flight evolution. " +
        "The live current.mdx is unchanged.",
      inputSchema: {
        node_id: NODE_ID.describe("Id of the node whose next slot to discard."),
      },
    },
    guarded(({ node_id }) => discardNext({ node_id }))
  );

  server.registerTool(
    "get_blast_radius",
    {
      title: "Get blast radius",
      description:
        "Returns all nodes that depend on the given node (transitive reverse depends_on closure), " +
        "with hop distance and journeys_at_risk for affected Interactions. " +
        "When the focus is an Interaction, also returns reachability: exposing Interfaces, containing Journeys, and leads_to downstream.",
      inputSchema: {
        node_id: NODE_ID.describe("The id of the node whose dependents to analyze."),
      },
    },
    guarded(({ node_id }) => getBlastRadius({ node_id }))
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
    guarded(({ source_id, target_id }) => unlinkNodes({ source_id, target_id }))
  );

  server.registerTool(
    "update_node_status",
    {
      title: "Update node status",
      description:
        "Transitions a Foundation, Interaction, Interface, or Bug. Build pipeline: draft -> ready -> in-progress -> in-review -> ship (sets stable/unstable). " +
        "Bug pipeline: open -> triaged -> fixing -> in-review -> resolved | wontfix. " +
        "When next.mdx exists, build-pipeline transitions apply to the next slot; ship promotes next over current. " +
        "Journey and production stable/unstable are computed automatically.",
      inputSchema: {
        node_id: NODE_ID.describe("The id of the node to transition."),
        new_status: z
          .string()
          .describe(
            "Foundation/Interaction/Interface: draft | ready | in-progress | in-review | ship | cancelled | deprecated. " +
              "Bug: open | triaged | fixing | in-review | resolved | wontfix. " +
              "From stable/unstable: deprecated only (or open_next then build/ship next). " +
              "Pre-ship abandon: cancelled from draft|ready|in-progress|in-review."
          ),
      },
    },
    guarded(({ node_id, new_status }) => updateNodeStatus({ node_id, new_status }))
  );

  server.registerTool(
    "force_unship",
    {
      title: "Force unship (mistaken ship recovery)",
      description:
        "DANGEROUS recovery only. Ask the user first and wait for an explicit yes — never invent confirmation. " +
        "Reverses a mistaken Foundation/Interaction/Interface ship: clears shipped_at and sets a pre-ship state (default ready). " +
        'Requires confirm exactly equal to "unship:<node_id>". Blocked while next.mdx is open or shipped dependents exist.',
      inputSchema: {
        node_id: NODE_ID.describe(
          "Stable/unstable Foundation, Interaction, or Interface to unship."
        ),
        confirm: z
          .string()
          .describe('Exact token after user confirmation: "unship:<node_id>". Do not invent this.'),
        new_status: z
          .enum(["draft", "ready", "in-progress", "in-review"])
          .optional()
          .describe("Pre-ship target state (default ready)."),
      },
    },
    guarded(({ node_id, confirm, new_status }) =>
      forceUnship({ node_id, confirm, new_status })
    )
  );
}
