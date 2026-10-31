/**
 * MCP tool definitions owned by i-shape-graph: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  EDGE_TYPES,
  NODE_TYPES,
  FOUNDATION_ROLES,
} from "../../foundations/f-domain-model/types.js";
import {
  defineTool,
  type ToolDef,
  VERBOSE,
  NODE_ID,
  CHANGE_ID,
  CHANGE_REF,
  ALIASES,
  READINESS_HINT,
} from "../../foundations/f-tool-kit/tool.js";
import {
  createNode,
  linkNodes,
  unlinkNodes,
} from "./handlers.js";

/** The MCP tools i-shape-graph owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "create_node",
    {
      kind: "write",
      title: "Create node",
      description:
        "Call when reuse found no node, before any new-feature code. " +
        "Creates a Journey, Interaction, Interface, Foundation, or Bug: scaffolds territory folder + <id>.mdx frontmatter. " +
        "Foundations require role. Declare owned files later with set_implementation_files (no package scaffold). " +
        "Returns shape for a Foundation, Interaction, Interface, or Bug: the sections its first transition checks, each present, missing, or stub (the scaffold), so you write them before moving it.",
      inputSchema: {
        verbose: VERBOSE,
        id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
        type: z.enum(NODE_TYPES).describe("Journey | Interaction | Interface | Foundation | Bug"),
        title: z.string().min(1).describe("Human-readable title (written to <id>.mdx frontmatter)."),
        description: z.string().describe("Short description (written to <id>.mdx frontmatter)."),
        role: z
          .enum(FOUNDATION_ROLES)
          .optional()
          .describe("Required for Foundation: assembler | infra | design-system | adapter."),
        change: CHANGE_ID.optional().describe(
          "Optional change id (a slug) that ties this new Foundation, Interaction, or Interface to other revisions of one change."
        ),
        change_ref: CHANGE_REF,
        aliases: ALIASES,
      },
    },

      ({ id, type, title, description, role, change, change_ref, aliases, verbose }) =>
        createNode({ id, type, title, description, role, change, change_ref, aliases, verbose })
  ),
  defineTool(
    "link_nodes",
    {
      kind: "write",
      title: "Link nodes",
      description:
        "Call when two existing nodes should be connected. " +
        "Adds an edge to the DAG. Legal shapes: Interaction -belongs_to-> Journey, " +
        "Interaction|Interface -depends_on-> Foundation, Foundation -depends_on-> Foundation, " +
        "Interface -exposes-> Interaction, Foundation -mounts-> Interface (a composition root that imports Interfaces), Interaction -leads_to-> Interaction, " +
        "Bug -affects-> Interaction|Interface|Foundation. " +
        "While a node has <id>.next.mdx, belongs_to/depends_on/exposes/leads_to writes go to the next slot (proposed edges applied on ship). " +
        "Pass change on a shipped node with no open revision of that change to plan the edge instead: it is checked like a link (shape, cycles), recorded under the change on the live file without open_next, " +
        "listed by run_check and get_blast_radius for the change, applied to the next slot when open_next opens the node with that change, and dropped if the change closes first. The live graph does not change. " +
        READINESS_HINT,
      inputSchema: {
        verbose: VERBOSE,
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
        edge_type: z
          .enum(EDGE_TYPES)
          .describe("belongs_to | depends_on | exposes | leads_to | affects | mounts"),
        change: CHANGE_ID.optional().describe(
          "Plan the edge under this change id when the source is shipped and has no open revision of it."
        ),
      },
    },

      ({ source_id, target_id, edge_type, change, verbose }) =>
        linkNodes({ source_id, target_id, edge_type, change, verbose })
  ),
  defineTool(
    "unlink_nodes",
    {
      kind: "destructive",
      title: "Unlink nodes",
      description:
        "Call when an existing edge should go away. " +
        "Removes edge(s) between two nodes from the source node's frontmatter. " +
        "With change, removes only the edges planned under that change from source to target. " +
        READINESS_HINT,
      inputSchema: {
        verbose: VERBOSE,
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
        change: CHANGE_ID.optional().describe("Remove the edges planned under this change instead of real edges."),
      },
    },

      ({ source_id, target_id, change, verbose }) => unlinkNodes({ source_id, target_id, change, verbose })
  ),
];
