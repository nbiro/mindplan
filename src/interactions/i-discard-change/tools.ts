/**
 * MCP tool definitions owned by i-discard-change: names, when-to-call descriptions, input schemas,
 * and handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { defineTool, type ToolDef, CHANGE_ID } from "../../foundations/f-tool-kit/tool.js";
import { discardChange } from "./handlers.js";

/** The MCP tools i-discard-change owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "discard_change",
    {
      kind: "destructive",
      title: "Discard a whole change",
      description:
        "Call when a planned or half-built change is dropped as a whole (one revision is discard_next; one planned edge is unlink_nodes). " +
        "Deletes the change's open revisions, its never-shipped nodes with their decisions and attachments, and its planned edges; " +
        "a member that already shipped, live text, and decisions beside a live file stay. Blocked, writing nothing, while a node that stays points at one that goes. " +
        "orient_for_work({ change }) first shows what goes. " +
        'Details: get_spec({ topic: "discard_change" }).',
      inputSchema: {
        change: CHANGE_ID.describe("The change id to discard."),
      },
    },
    ({ change }) => discardChange({ change })
  ),
];
