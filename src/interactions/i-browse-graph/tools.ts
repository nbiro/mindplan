/**
 * MCP tool definitions owned by i-browse-graph: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
  NODE_ID,
  CHANGE_ID,
} from "../../foundations/f-tool-kit/tool.js";
import { EDGE_TYPES, NODE_TYPES } from "../../foundations/f-domain-model/types.js";
import {
  GRAPH_NODE_FIELDS,
  GRAPH_NODE_STATES,
  GRAPH_PAGE_DEFAULT,
  GRAPH_PAGE_MAX,
  getMindPlanGraph,
  listAreas,
  listDecisionsHandler,
} from "./handlers.js";

/** The MCP tools i-browse-graph owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "get_mindplan_graph",
    {
      kind: "read",
      title: "Get MindPlan graph",
      description:
        "Call when you need the graph's nodes and edges, or a slice of them; prefer orient_for_work for one piece of work. " +
        `Returns one page: nodes sorted by id, the edges whose source is in the page, totals, and next_offset while nodes remain (up to ${GRAPH_PAGE_DEFAULT} nodes per page). ` +
        "Filter with state / type / change (AND across, OR within an array), project with fields, and drop or narrow edges with edges: e.g. state: [\"draft\", \"ready\"], fields: [\"id\", \"type\", \"title\", \"change\"], edges: false lists what is planned but not built." +
        " Details: get_spec({ topic: \"get_mindplan_graph\" }).",
      inputSchema: {
        offset: z.number().int().min(0).optional().describe("First node index (default 0)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(GRAPH_PAGE_MAX)
          .optional()
          .describe(`Nodes per page (default ${GRAPH_PAGE_DEFAULT}, max ${GRAPH_PAGE_MAX}).`),
        state: z
          .union([z.enum(GRAPH_NODE_STATES), z.array(z.enum(GRAPH_NODE_STATES)).min(1)])
          .optional()
          .describe('Only nodes in this state, or in any of these states (e.g. "ready", ["in-progress", "in-review"]). Matches the live state field.'),
        type: z
          .union([z.enum(NODE_TYPES), z.array(z.enum(NODE_TYPES)).min(1)])
          .optional()
          .describe("Only nodes of this type, or of any of these types."),
        change: CHANGE_ID.optional().describe(
          "Only the nodes of this change: the nodes holding an open revision of it, and pre-ship nodes whose change field it is."
        ),
        fields: z
          .array(z.string())
          .optional()
          .describe(
            `Node fields to return (id is always included), e.g. ["id", "type", "title", "change"]. Valid: ${GRAPH_NODE_FIELDS.join(", ")}.`
          ),
        edges: z
          .union([z.boolean(), z.array(z.string())])
          .optional()
          .describe(
            `true (default): every edge whose source is in the page. false: no edges and no total_edges. ` +
              `An array: only edges of those types (OR); total_edges counts them. Valid types: ${EDGE_TYPES.join(", ")}.`
          ),
      },
    },
    ({ offset, limit, state, type, change, fields, edges }) =>
      getMindPlanGraph({ offset, limit, state, type, change, fields, edges })
  ),
  defineTool(
    "list_areas",
    {
      kind: "read",
      title: "List areas",
      description:
        "Call when you are unsure where work lands. Returns every Capability as one compact table row (id, title, short description, interaction / interface / foundation counts, open_bugs); pass a row's id as area to orient_for_work or find_related_nodes. Details: get_spec({ topic: \"list_areas\" }).",
      inputSchema: {},
    },
    () => listAreas()
  ),
  defineTool(
    "list_decisions",
    {
      kind: "read",
      title: "List decisions",
      description:
        "Call before reshaping a design someone else chose, or to read the reasoning trail of a node or change. Returns { decisions, count } for one node, one change, or the whole graph, each with its node, status, and superseded_by; superseded entries only with include_superseded. Details: get_spec({ topic: \"list_decisions\" }).",
      inputSchema: {
        node_id: NODE_ID.optional().describe("List this node's own decisions."),
        change: CHANGE_ID.optional().describe("List decisions recorded under this change id."),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Also return superseded decisions. Default false."),
      },
    },
    ({ node_id, change, include_superseded }) =>
      listDecisionsHandler({ node_id, change, include_superseded })
  ),
];
