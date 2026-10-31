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
        "When an open evolution exists, build-pipeline transitions apply to the next slot; " +
        "ship promotes next over current and deletes the next file; every ship drops the node's Atomic Ops (the shipped node shows its current state, git keeps the ledger). " +
        "Pass revisions to advance a set in one call: Foundations, then Interactions, then Interfaces, then Bugs; stops on the first Blocked and leaves earlier nodes transitioned. " +
        "Pass scope + new_status to walk every open update (or a node and its dependents, or one change's revisions) to a target in one call, validated before the first write; dry_run lists every transition. " +
        "A scoped walk to ship that would skip a node's in-review stop is Blocked unless skip_review: true, which walks it through in-review (gate included) and reports skipped_review. " +
        "Moves to in-review and ship run the check's import and ownership rules on the node's files and return Blocked: on a violation; stale-text warnings ride along. " +
        "A move to in-review of a decision-worthy revision (a shipped Foundation's contract, a new migration or schema file, a wide blast radius, or a depends_on change) with no decision recorded is Blocked: Decision with the record_decision call. " +
        "A Blocked: Orientation names every unoriented node of the call at once (a scope change walk names orient_for_work({ change })). " +
        "A batch returns one line per node. " +
        "When a ship or cancel leaves a change with no open revisions, its neighbor labels are cleared (cleared_neighbors); " +
        "scope change walks revisions only, and a walk of it to ship clears its labels. " +
        "Journey and production stable/unstable are computed automatically.",
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
              "From stable/unstable: deprecated only (or open_next then build/ship next). " +
              "Pre-ship abandon: cancelled from draft|ready|in-progress|in-review. " +
              "Required with node_id. Omit when using revisions."
          ),
        scope: z
          .enum(STATUS_SCOPES)
          .optional()
          .describe(
            "Walk many nodes in one call to the new_status target: all_open_updates (every shipped node with an open next, and every pre-ship node being built: in-progress or in-review; draft and ready plans are never walked) " +
              "or node_and_dependents (node_id plus its open dependents), or change (every open revision with that change id, draft and ready included). " +
              "The server orders Foundations, Interactions, Interfaces, " +
              "walks each node through the pipeline, and validates the whole walk before writing anything. Target: ready | in-progress | in-review | ship."
          ),
        change: CHANGE_ID.optional().describe('The change id walked by scope "change".'),
        skip_review: z
          .boolean()
          .optional()
          .describe(
            "Scoped walk to ship only: allow moving nodes that are not in-review yet. Each still passes the in-review gate; the result lists skipped_review."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Validate and return the plan and the first Blocked reason without writing anything."
          ),
        revisions: z
          .array(
            z.object({
              node_id: NODE_ID.describe("Node to transition."),
              new_status: z.string().describe("Target status for this node."),
            })
          )
          .min(1)
          .optional()
          .describe(
            "One revision. Server orders Foundations, Interactions, Interfaces, then Bugs, and stops on the first Blocked. Mutually exclusive with node_id and new_status."
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
        'Requires confirm exactly equal to "unship:<node_id>"; do not invent the confirm token. Blocked while an open evolution exists or shipped dependents exist. Deletes any next file and clears a neighbor label (cleared_change) and added_claims.',
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
