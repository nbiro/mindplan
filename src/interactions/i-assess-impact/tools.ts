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
        "Call before changing a shipped node. Returns its transitive dependents with hop distance, capabilities_at_risk, affected_files grouped by owner, the focus's decisions, and tests: the suites to run. Pass change instead of node_id for the merged radius of a change and its additivity (whether it only adds nodes or reopens shipped ones); change with node_id judges that node's open revision. include_retired and include_dependent_decisions widen the reply. Details: get_spec({ topic: \"get_blast_radius\" }).",
      inputSchema: {
        node_id: NODE_ID.optional().describe("The id of the node whose dependents to analyze. Or pass change."),
        change: CHANGE_ID.optional().describe("A change id: alone, merge the blast radius of all its open revisions and planned sources; with node_id, that node's revision of it."),
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
