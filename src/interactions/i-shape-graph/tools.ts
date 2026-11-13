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
  MAX_BATCH_EDGES,
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
        "Creates a Capability, Interaction, Interface, Foundation (role required), or Bug with its <id>.mdx scaffold; claim files later with set_implementation_files. " +
        "Returns shape: the sections its first transition checks, each present, missing, or stub. " +
        'Details: get_spec({ topic: "create_node" }).',
      inputSchema: {
        verbose: VERBOSE,
        id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
        type: z.enum(NODE_TYPES).describe("Capability | Interaction | Interface | Foundation | Bug"),
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
        "Call when two existing nodes should be connected; pass edges to add several in one call (all or none: one Blocked edge writes nothing, one rules block for all). " +
        "Adds a DAG edge. Legal: Interaction -belongs_to-> Capability; Interaction|Interface -depends_on-> Foundation; Foundation -depends_on-> Foundation; " +
        "Interface -exposes-> Interaction; Foundation -mounts-> Interface; Interaction -leads_to-> Interaction; Bug -affects-> Interaction|Interface|Foundation. " +
        "On a shipped node with an open revision the edge goes to it as a delta (change picks the revision when several are open); " +
        "with change and no open revision of it, the edge is planned under that change (live graph unchanged; applied when open_next opens the node with that change; it orients the source itself). " +
        "change on a never-shipped node of another change is Blocked. " +
        READINESS_HINT +
        ' Details: get_spec({ topic: "link_nodes" }).',
      inputSchema: {
        verbose: VERBOSE,
        source_id: NODE_ID.optional().describe("The id of the edge source node (one edge; or pass edges)."),
        target_id: NODE_ID.optional().describe("The id of the edge target node (one edge; or pass edges)."),
        edge_type: z
          .enum(EDGE_TYPES)
          .optional()
          .describe("belongs_to | depends_on | exposes | leads_to | affects | mounts"),
        edges: z
          .array(
            z.object({
              source_id: NODE_ID,
              target_id: NODE_ID,
              edge_type: z.enum(EDGE_TYPES),
            })
          )
          .min(1)
          .max(MAX_BATCH_EDGES)
          .optional()
          .describe(
            "Several edges in one call, in place of source_id, target_id, and edge_type. Each lands where a single call would put it; each is checked against the graph the earlier ones leave; one Blocked edge writes nothing."
          ),
        change: CHANGE_ID.optional().describe(
          "The source's open revision to write the edge to; when the source is shipped and has no open revision of it, plan the edge under this change id. Applies to every edge of a batch."
        ),
      },
    },

      ({ source_id, target_id, edge_type, edges, change, verbose }) =>
        linkNodes({ source_id, target_id, edge_type, edges, change, verbose })
  ),
  defineTool(
    "unlink_nodes",
    {
      kind: "destructive",
      title: "Unlink nodes",
      description:
        "Call when an existing edge should go away. " +
        "Removes the edge(s) from source to target; with an open revision it is a delta (change picks the revision), with change and no revision of it only that change's planned edges go. " +
        READINESS_HINT +
        ' Details: get_spec({ topic: "unlink_nodes" }).',
      inputSchema: {
        verbose: VERBOSE,
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
        change: CHANGE_ID.optional().describe(
          "The source's open revision to remove the edge from; with no open revision of it, remove the edges planned under this change instead."
        ),
      },
    },

      ({ source_id, target_id, change, verbose }) => unlinkNodes({ source_id, target_id, change, verbose })
  ),
];
