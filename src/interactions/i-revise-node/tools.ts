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
  CHANGE_ARG,
  CHANGE_REF,
} from "../../foundations/f-tool-kit/tool.js";
import {
  discardNext,
  openNext,
  rebaseRevision,
  resolveConflict,
} from "./handlers.js";

/** The MCP tools i-revise-node owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "open_next",
    {
      kind: "write",
      title: "Open a revision",
      description:
        "Call when a shipped node's contract changes, before editing that contract. " +
        "Opens a draft revision under change (required) while the live node keeps serving; a node may hold several, one per change. Optional title/description overrides. " +
        "Ship it with update_node_status (pass change when several are open) or abandon it with discard_next; shipping one rebases its siblings (conflicts go to resolve_conflict). " +
        "Blocked when the node is not shipped or already has that change open. " +
        "On a hotspot the result carries decision_prompt: prefer a new node that depends_on it, or record why revising it is right. " +
        'Details: get_spec({ topic: "open_next" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe(
          "Id of the shipped Foundation, Interaction, or Interface to revise."
        ),
        title: z.string().min(1).optional().describe("Optional new title for the revision."),
        description: z.string().optional().describe("Optional new description for the revision."),
        // Optional in the schema so a missing change gets the handler's Blocked, which names the fix.
        change: CHANGE_ID.optional().describe("The change id (a slug) this revision belongs to. Required: without it the call is Blocked."),
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
      title: "Discard a revision",
      description:
        "Call when an open revision should be abandoned. " +
        "Deletes the revision with its attachments and decisions; live and other revisions stay. Pass change when several are open. " +
        'Details: get_spec({ topic: "discard_next" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Id of the node whose open revision to discard."),
        change: CHANGE_ARG,
      },
    },
    ({ node_id, change, verbose }) => discardNext({ node_id, change, verbose })
  ),
  defineTool(
    "resolve_conflict",
    {
      kind: "write",
      title: "Resolve a revision conflict",
      description:
        "Call when a revision holds a conflict after a sibling revision shipped (in-review is Blocked until none remain). " +
        'Name one conflict: section (e.g. "## Spec"), field (title, description, role), or claim (a path); take "revision", "live", or "text" (with text; sections and fields only). ' +
        "Pass change when several revisions are open. Returns the conflicts left. " +
        'Details: get_spec({ topic: "resolve_conflict" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Id of the node whose revision holds the conflict."),
        change: CHANGE_ARG,
        section: z.string().min(1).optional().describe('A section conflict: its heading, e.g. "## Spec", or "_preamble" for the text above the first heading.'),
        field: z.enum(["title", "description", "role"]).optional().describe("A scalar conflict: the field."),
        claim: z.string().min(1).optional().describe("A claim conflict: the claimed path."),
        take: z.enum(["revision", "live", "text"]).describe("Which side wins, or text to write instead."),
        text: z.string().optional().describe('With take "text": the section body or scalar value to write.'),
      },
    },
    ({ node_id, change, section, field, claim, take, text, verbose }) =>
      resolveConflict({ node_id, change, section, field, claim, take, text, verbose })
  ),
  defineTool(
    "rebase_revision",
    {
      kind: "write",
      title: "Rebase a revision onto live",
      description:
        "Call when run_check({ after_merge: true }) reports a revision whose base no longer matches live. " +
        "Carries the open revision onto current live as a ship rebases siblings: untouched text takes live's, text both edited becomes a conflict (resolve_conflict), and a ready / in-review revision whose text changed returns to draft (readiness_reset). " +
        "Pass change when several are open; a revision already on live returns rebased: false. " +
        'Details: get_spec({ topic: "rebase_revision" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Id of the node whose open revision to rebase."),
        change: CHANGE_ARG,
      },
    },
    ({ node_id, change, verbose }) => rebaseRevision({ node_id, change, verbose })
  ),
];
