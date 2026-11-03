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
        "Opens a revision of the node under change (required): revisions/<change>/<id>.mdx, a draft copy of the live file with a fresh list of unticked default Atomic Ops. The live node keeps serving. " +
        "A node may hold several open revisions, one per change; each is judged against live plus itself only. " +
        "Optional title/description overrides. Ship it with update_node_status (pass change when the node has several), or discard_next to abandon it. " +
        "Shipping one revision rebases its siblings onto the new live: untouched text carries over, a section both edited becomes a conflict (resolve_conflict). " +
        "Edges planned on the node under the change are added to the revision (applied_planned). " +
        "Blocked when the change is already open on the node or the node is not shipped. " +
        "On a hotspot (a node shipping far more often than the graph's median lately; config hotspots) the result also carries warnings and decision_prompt: prefer a new node that depends_on it, or record why revising it is right. " +
        "The result lists the node's open revisions ({ change, state }).",
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
        "Deletes revisions/<change>/ (the revision file, its attachments, and its decisions). The live <id>.mdx and the node's other revisions are unchanged. " +
        "Pass change when the node has several open revisions. " +
        "When it was its change's last open revision, the change's planned edges are dropped (cleared_planned).",
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
        "Call when a revision holds a conflict after a sibling revision shipped (update_node_status lists rebased conflicts; in-review is Blocked until none remain). " +
        "Name exactly one conflict: section (a level-2 heading such as \"## Spec\"), field (title, description, or role), or claim (a claimed path another node now owns). " +
        'take "revision" keeps the revision\'s value, "live" takes the shipped value (a claim: drops the add), "text" writes text instead (sections and scalars only). ' +
        "Pass change when the node has several open revisions. The result lists the conflicts left.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Id of the node whose revision holds the conflict."),
        change: CHANGE_ARG,
        section: z.string().min(1).optional().describe('A section conflict: its heading, e.g. "## Spec".'),
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
        "Call when run_check({ after_merge: true }) reports a revision whose base no longer matches live (live changed on another branch, e.g. a sibling revision shipped there and the branches merged). " +
        "Carries the open revision onto current live with the rule a ship applies to its siblings: a section or field the revision did not touch takes live's text, one both edited becomes a conflict (resolve_conflict), deltas already live drop, claim conflicts are recomputed, and a ready / in-review revision whose text changed goes back to draft (readiness_reset). " +
        "Pass change when the node has several open revisions. A revision already based on live is left as it is (rebased: false). " +
        "Result: { node_id, change, rebased, conflicts, readiness_reset?, changed_files }.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Id of the node whose open revision to rebase."),
        change: CHANGE_ARG,
      },
    },
    ({ node_id, change, verbose }) => rebaseRevision({ node_id, change, verbose })
  ),
];
