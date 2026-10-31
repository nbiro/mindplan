/**
 * MCP tool definitions owned by i-assess-impact: names, when-to-call descriptions, input schemas, and
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
  getBlastRadius,
} from "./handlers.js";

/** The MCP tools i-assess-impact owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "get_blast_radius",
    {
      kind: "read",
      title: "Get blast radius",
      description:
        "Call before changing a shipped node. " +
        "Returns nodes that depend on the given node (transitive reverse depends_on closure), " +
        "with hop distance, journeys_at_risk, and affected_files grouped by owner " +
        "({ owner_id, owner_type, via[], files[] }; via ∈ focus|dependent|exposing|importer). " +
        "Cancelled and deprecated nodes are omitted by default; set include_retired to see them " +
        "(BFS still traverses through retired nodes so live dependents keep true distances). " +
        "When the focus is an Interaction, also returns reachability. " +
        "decisions lists the active decisions held by the focus; dependent_decisions ({ count, nodes }) names the dependents that hold decisions a change would reach, and include_dependent_decisions adds their one-line entries to decisions. " +
        "tests lists the linked test files of the focus and every owner in affected_files: the suites to run. " +
        "Pass change instead of node_id for the merged radius of every member of a change (open revisions and shipped nodes with planned edges; members carry kind revision | planned), its planned_edges, and additivity ({ summary, new_nodes, revised, planned }): whether the change only adds nodes or reopens shipped ones, each with its fan-in.",
      inputSchema: {
        node_id: NODE_ID.optional().describe("The id of the node whose dependents to analyze. Or pass change."),
        change: CHANGE_ID.optional().describe("A change id: merge the blast radius of all its open revisions and planned sources."),
        include_retired: z
          .boolean()
          .optional()
          .describe("Include cancelled/deprecated nodes (default false)."),
        include_dependent_decisions: z
          .boolean()
          .optional()
          .describe("Also list the dependents' decisions in decisions (default false: only their count and nodes)."),
      },
    },
    ({ node_id, change, include_retired, include_dependent_decisions }) =>
      getBlastRadius({ node_id, change, include_retired, include_dependent_decisions })
  ),
];
