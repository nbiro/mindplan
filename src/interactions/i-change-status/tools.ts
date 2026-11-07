/**
 * MCP tool definitions owned by i-change-status: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
  VERBOSE,
  NODE_ID,
  CHANGE_ID,
} from "../../foundations/f-tool-kit/tool.js";
import {
  STATUS_SCOPES,
  forceUnship,
  updateNodeStatus,
} from "./handlers.js";

/** The MCP tools i-change-status owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "update_node_status",
    {
      kind: "write",
      title: "Update node status",
      description:
        "Call when a node should move along the build or bug pipeline, including ship or resolved at handoff. " +
        "Build: draft -> ready -> in-progress -> in-review -> ship (stable/unstable computed). Bug: open -> triaged -> fixing -> in-review -> resolved | wontfix. " +
        "Three forms: node_id + new_status (one node; on a shipped node it moves one open revision, pass change when it has several); " +
        "revisions: [...] (a batch, each item tried in order; when only some moved the result has partial: true and blocked_count, so check it); " +
        "scope + new_status (all_open_updates, node_and_dependents, or change; validated before the first write; dry_run previews). " +
        'To ship a change in one call: update_node_status({ scope: "change", change, new_status: "ship" }); nodes: [...] limits it to those members. ' +
        "A scoped walk is all-or-nothing unless skip_blocked: true; walking to ship past a node's in-review stop needs skip_review: true. Other scopes leave a node with several open revisions in needs_change_walk. " +
        "Ship writes the revision over live and rebases its siblings; a revision with conflicts is Blocked at in-review and ship until resolve_conflict clears them. " +
        "Moves to in-review and ship run the check's import and ownership rules; a decision-worthy revision with no decision recorded is Blocked: Decision (record_decision). " +
        'Details: get_spec({ topic: "update_node_status" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.optional().describe(
          "The id of the single node to transition. Mutually exclusive with revisions."
        ),
        new_status: z
          .string()
          .optional()
          .describe(
            "Foundation/Interaction/Interface: draft | ready | in-progress | in-review | ship | cancelled | deprecated. " +
              "Bug: open | triaged | fixing | in-review | resolved | wontfix. " +
              "From stable/unstable: deprecated only (or open_next then build/ship the revision). " +
              "Pre-ship abandon: cancelled from draft|ready|in-progress|in-review. " +
              "Required with node_id. Omit when using revisions."
          ),
        scope: z
          .enum(STATUS_SCOPES)
          .optional()
          .describe(
            "Walk many nodes in one call to the new_status target: all_open_updates (every shipped node with an open revision, and every pre-ship node being built: in-progress or in-review; draft and ready plans are never walked) " +
              "or node_and_dependents (node_id plus its open dependents), or change (every open revision with that change id, draft and ready included). " +
              "The server orders Foundations, Interactions, Interfaces, " +
              "walks each node through the pipeline, and validates the whole walk before writing anything. Target: ready | in-progress | in-review | ship."
          ),
        change: CHANGE_ID.optional().describe(
          'The change id walked by scope "change"; with node_id + new_status, which open revision of the node moves (optional when it has at most one).'
        ),
        nodes: z
          .array(NODE_ID)
          .min(1)
          .optional()
          .describe(
            'Scope "change" only: walk just these members of the change (each must be a member); the others stay where they are. Works with dry_run, skip_review, skip_blocked.'
          ),
        skip_review: z
          .boolean()
          .optional()
          .describe(
            "Scoped walk to ship only: allow moving nodes that are not in-review yet. Each still passes the in-review gate; the result lists skipped_review."
          ),
        skip_blocked: z
          .boolean()
          .optional()
          .describe(
            "Scoped walk only: walk every node whose whole walk passes, leave each blocked node where it is (no partial steps), and list them in blocked ({ node_id, step, reason }). Blocked when no node can move."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Validate and return the plan and the first Blocked reason without writing anything (with skip_blocked: the walkable plan and every blocked node)."
          ),
        revisions: z
          .array(
            z.object({
              node_id: NODE_ID.describe("Node to transition."),
              new_status: z.string().describe("Target status for this node."),
              change: CHANGE_ID.optional().describe(
                "Which open revision of a shipped node moves; optional when it has at most one. One node may appear once per change."
              ),
            })
          )
          .min(1)
          .optional()
          .describe(
            "One revision. Server orders Foundations, Interactions, Interfaces, then Bugs, and tries every item (a Blocked item stays put, the rest move). Mutually exclusive with node_id and new_status."
          ),
      },
    },
    (args) => updateNodeStatus(args)
  ),
  defineTool(
    "force_unship",
    {
      kind: "destructive",
      title: "Force unship (mistaken ship recovery)",
      description:
        "Call only after the user confirms a mistaken ship; recovery only. " +
        "Returns a shipped Foundation/Interaction/Interface to a pre-ship state (default ready). " +
        'Requires confirm exactly "unship:<node_id>"; do not invent it. Blocked while the node has an open revision or shipped dependents. ' +
        'Details: get_spec({ topic: "force_unship" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe(
          "Stable/unstable Foundation, Interaction, or Interface to unship."
        ),
        confirm: z
          .string()
          .describe('Exact token after user confirmation: "unship:<node_id>". Do not invent this.'),
        new_status: z
          .enum(["draft", "ready", "in-progress", "in-review"])
          .optional()
          .describe("Pre-ship target state (default ready)."),
      },
    },
    
      ({ node_id, confirm, new_status, verbose }) =>
        forceUnship({ node_id, confirm, new_status, verbose })
  ),
];
