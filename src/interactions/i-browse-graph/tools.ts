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
import {
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
        "Call when you need every node and edge. Prefer orient_for_work for one piece of work. " +
        "Returns one page of the MindPlan graph assembled from <id>.mdx frontmatter: nodes sorted by id, " +
        "the edges whose source is in the page, total_nodes, total_edges, and next_offset while nodes remain. " +
        `A graph of up to ${GRAPH_PAGE_DEFAULT} nodes fits one page; walk offset = next_offset for the rest.`,
      inputSchema: {
        offset: z.number().int().min(0).optional().describe("First node index (default 0)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(GRAPH_PAGE_MAX)
          .optional()
          .describe(`Nodes per page (default ${GRAPH_PAGE_DEFAULT}, max ${GRAPH_PAGE_MAX}).`),
      },
    },
    ({ offset, limit }) => getMindPlanGraph({ offset, limit })
  ),
  defineTool(
    "list_areas",
    {
      kind: "read",
      title: "List areas",
      description:
        "Call when you are unsure where work lands, before orient_for_work. " +
        "Returns every Journey (area) as one row of a compact table: { columns, rows, count } with " +
        "[id, title, description (60 characters), interactions, interfaces, foundations, open_bugs]. " +
        "Pick a row and pass its id as area to orient_for_work or find_related_nodes; for a question that cuts across areas, search without area.",
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
        "Call before reshaping a design someone else chose, or to read the reasoning trail of a node or change. " +
        "Returns { decisions, count }: one node's own decisions, every decision recorded under a change, or the whole graph's, " +
        "each with its node, status (active or superseded), and superseded_by. Superseded entries only with include_superseded.",
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
