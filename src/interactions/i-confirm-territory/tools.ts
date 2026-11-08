/**
 * MCP tool definitions owned by i-confirm-territory: names, when-to-call descriptions, input
 * schemas, and handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import { defineTool, type ToolDef, NODE_ID } from "../../foundations/f-tool-kit/tool.js";
import { confirmTerritory } from "./handlers.js";

/** The MCP tools i-confirm-territory owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "confirm_territory",
    {
      kind: "write",
      title: "Confirm a node's text still holds",
      description:
        "Call when the merge gate Blocks a shipped node whose claimed files changed but whose territory did not, and its text still describes the code " +
        "(a removed script, a bumped constant): records who confirmed it, why, and each file's content hash in the node's confirmed.json, so the gate passes it without a made-up prose edit. " +
        "Editing a confirmed file again Blocks again. A changed contract needs open_next and ship instead; stale text needs patch_node_territory. " +
        "Only a shipped node with no open revision. " +
        'Details: get_spec({ topic: "confirm_territory" }).',
      inputSchema: {
        node_id: NODE_ID.describe("Shipped Foundation, Interaction, or Interface with no open revision."),
        files: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Project-relative files to confirm, each claimed by the node (default: its claimed files changed against the default branch, as the merge gate counts them)."
          ),
        note: z.string().describe("One line: why the node's text still describes the changed files."),
      },
    },
    ({ node_id, files, note }) => confirmTerritory({ node_id, files, note })
  ),
];
