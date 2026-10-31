/**
 * MCP tool definitions owned by i-export-map: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  VIEW_FORMATS,
} from "../../foundations/f-view-projection/view.js";
import {
  defineTool,
  type ToolDef,
  NODE_ID,
} from "../../foundations/f-tool-kit/tool.js";
import {
  EXPORT_RESULT_BUDGET,
  exportMindPlanViewHandler,
} from "./handlers.js";

/** The MCP tools i-export-map owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "export_mindplan_view",
    {
      kind: "read",
      title: "Export MindPlan view",
      description:
        "Call when a human wants a map for a PR or a doc. " +
        "Exports a deterministic typed-DAG projection as Mermaid or DOT. " +
        "Omit focus for the full filtered map; pass focus for that node plus its 1-hop neighborhood. " +
        "By default hides deprecated/cancelled nodes and closed bugs. Prefer find_related_nodes for agent orientation JSON. " +
        `A diagram over ${EXPORT_RESULT_BUDGET} characters is Blocked unless you pass focus or output (a repo-relative file path, outside mindplan/).`,
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
        decisions: z
          .boolean()
          .optional()
          .describe("Label each node that has active decisions with their count. Default false."),
        output: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Repo-relative file path to write the diagram to (outside mindplan/). The result then carries written_to and no diagram."
          ),
      },
    },
    ({ format, focus, include_retired, decisions, output }) =>
      exportMindPlanViewHandler({ format, focus, include_retired, decisions, output })
  ),
];
