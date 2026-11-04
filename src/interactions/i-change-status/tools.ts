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
        "Transitions a Foundation, Interaction, Interface, or Bug. Build pipeline: draft -> ready -> in-progress -> in-review -> ship (sets stable/unstable). " +
        "Bug pipeline: open -> triaged -> fixing -> in-review -> resolved | wontfix. " +
        "On a shipped node, build-pipeline transitions move one open revision (pass change when it has several; with several and no change it is Blocked naming them); " +
        "ship writes that revision over live, deletes its folder, and rebases the node's other revisions onto the new live (rebased: [{ change, conflicts }]); " +
        "a revision holding conflicts is Blocked at in-review and ship until resolve_conflict clears them. " +
        "Every ship drops the node's Atomic Ops (the shipped node shows its current state, git keeps the ledger). deprecated deletes every open revision. " +
        "Pass revisions to advance a set in one call: Foundations, then Interactions, then Interfaces, then Bugs; every item is tried on the graph as the earlier ones left it, " +
        "and the result lists results: [{ node_id, change?, ok, line?, blocked? }] plus lines for the moved ones; the call is Blocked only when no item moved (listing every reason); when some items moved and others were Blocked, the result says so at the top with partial: true and blocked_count: n — check it, the call did not do everything asked. " +
        "Pass scope + new_status to walk every open update (or a node and its dependents, or one change's revisions) to a target in one call, validated before the first write; dry_run lists every transition. " +
        'A scoped change walk is the one-call way to ship a change: update_node_status({ scope: "change", change, new_status: "ship" }); add nodes: [...] to walk only those members (the others stay put, and the gates still refuse a listed node that needs an unlisted one). ' +
        "A Blocked single or batch move of a node in a change ends with the scoped change call that moves the whole change. " +
        "A scoped walk to ship that would skip a node's in-review stop is Blocked unless skip_review: true, which walks it through in-review (gate included) and reports skipped_review. " +
        "A scoped walk is all-or-nothing unless skip_blocked: true, which walks every node that passes its gates, leaves each blocked node (and any node that cannot move without it) where it is, and lists them in blocked with the step and reason. " +
        "Moves to in-review and ship run the check's import and ownership rules on the node's files and return Blocked: on a violation; stale-text warnings ride along. " +
        "A move to in-review of a decision-worthy revision (a shipped Foundation's contract, a new migration or schema file, a wide blast radius, or a depends_on change) with no decision recorded is Blocked: Decision with the record_decision call. " +
        "A Blocked: Orientation names every unoriented node of the call at once (a scope change walk names orient_for_work({ change })). " +
        "A batch returns one line per node. " +
        "When a ship or cancel leaves a change with no open revisions, its planned edges are dropped (cleared_planned); " +
        "scope change walks the change's open revisions; the other scopes move each node's only open revision, and leave a node with several in place, listed in needs_change_walk ({ node_id, changes }) to walk with scope change. " +
        "Capability and production stable/unstable are computed automatically.",
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
        "Reverses a mistaken Foundation/Interaction/Interface ship: clears shipped_at and sets a pre-ship state (default ready). " +
        'Requires confirm exactly equal to "unship:<node_id>"; do not invent the confirm token. Blocked while the node has an open revision or shipped dependents exist. Clears added_claims.',
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
