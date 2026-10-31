/**
 * MCP tool definitions owned by i-revise-node: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
  VERBOSE,
  NODE_ID,
  CHANGE_ID,
  CHANGE_REF,
} from "../../foundations/f-tool-kit/tool.js";
import {
  discardNext,
  openNext,
} from "./handlers.js";

/** The MCP tools i-revise-node owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "open_next",
    {
      kind: "write",
      title: "Open next evolution",
      description:
        "Call when a shipped node's contract changes, before editing that contract. " +
        "Writes <id>.next.mdx from the live file in state draft (a shipped node has no next file until then). " +
        "Optional title/description overrides. The next file gets a fresh list of unticked default Atomic Ops to rewrite (a shipped node keeps none). The live node keeps serving. " +
        "Ship from next in-review to promote it over the live file; discard_next to abandon it. Both delete the next file. " +
        "Pass change to tie this revision to the others of one change (update_node_status scope change, get_blast_radius change, run_check change act on the group). " +
        "A neighbor label is inherited as the revision's change unless change names another, which clears it (replaced_change). " +
        "Edges planned on the node under the revision's change are added to the next slot (applied_planned). " +
        "On a hotspot (a node shipping far more often than the graph's median lately; config hotspots) the result also carries warnings and decision_prompt: prefer a new node that depends_on it, or record why revising it is right.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe(
          "Id of the shipped Foundation, Interaction, or Interface to evolve."
        ),
        title: z.string().min(1).optional().describe("Optional new title for the next slot."),
        description: z.string().optional().describe("Optional new description for the next slot."),
        change: CHANGE_ID.optional().describe("Optional change id (a slug) grouping this revision with others."),
        change_ref: CHANGE_REF,
      },
    },
    
      ({ node_id, title, description, change, change_ref, verbose }) =>
        openNext({ node_id, title, description, change, change_ref, verbose })
  ),
  defineTool(
    "discard_next",
    {
      kind: "destructive",
      title: "Discard next evolution",
      description:
        "Call when an open evolution should be abandoned. " +
        "Abandons an in-flight evolution: deletes <id>.next.mdx and next-attachments/. The live <id>.mdx is unchanged. " +
        "When it was its change's last open revision, the change's neighbor labels are cleared (cleared_neighbors).",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Id of the node whose open evolution to discard."),
      },
    },
    ({ node_id, verbose }) => discardNext({ node_id, verbose })
  ),
];
