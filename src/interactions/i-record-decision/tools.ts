/**
 * MCP tool definitions owned by i-record-decision: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  DECISION_ID_PATTERN,
} from "../../foundations/f-domain-model/types.js";
import {
  defineTool,
  type ToolDef,
  VERBOSE,
  NODE_ID,
  CHANGE_ARG,
} from "../../foundations/f-tool-kit/tool.js";
import {
  recordDecision,
} from "./handlers.js";

/** The MCP tools i-record-decision owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "record_decision",
    {
      kind: "write",
      title: "Record a decision",
      description:
        "Call when you choose between viable designs (a data shape, an ordering guarantee, which system owns a fact), " +
        "on the node the choice shapes. Writes decisions/<id>.md in the node's open revision of change (or its only one), else beside live; list every other node it shapes in nodes. " +
        "Never rewritten: to change one, record a new decision with supersedes. " +
        "A decision-worthy revision is Blocked at in-review until a decision is recorded under its change. Never resets readiness. " +
        'Details: get_spec({ topic: "record_decision" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Node the decision shapes (not a Bug)."),
        decision: z.string().min(1).describe("One sentence: what was chosen."),
        alternatives: z
          .array(z.string().min(1))
          .min(1)
          .describe("What else was considered, one line each (the alternative you rejected, and why it lost)."),
        why: z.string().min(1).describe("The constraint or trade-off that decided it."),
        consequences: z.string().optional().describe("What this makes harder or forbids."),
        keep_whole: z
          .boolean()
          .optional()
          .describe("The node stays one node on purpose (e.g. auth): hotspot detection skips it until this decision is superseded."),
        supersedes: z
          .string()
          .optional()
          .describe("Id of an active decision on this node, its Capability, or its Foundations that this one replaces."),
        change: CHANGE_ARG.describe(
          "Which open revision of the node to record it in, and the change id it is tagged with (default: the node's only open revision's change; required when several are open). " +
            "A change the node has no revision of only tags the decision, written live: the node's own change id is never set, so a decision alone does not make a shipped node a member of the change."
        ),
        id: z
          .string()
          .regex(DECISION_ID_PATTERN, 'decision ids are "d-" followed by a slug')
          .optional()
          .describe("Stable id, e.g. d-capacity-on-booking. Generated from the decision when omitted."),
        nodes: z
          .array(z.string().min(1))
          .optional()
          .describe("Every node this one decision shapes (none a Bug). It clears the decision gate of their revisions under the same change, or any change when untagged."),
      },
    },

      ({ node_id, decision, alternatives, why, consequences, supersedes, change, id, keep_whole, nodes, verbose }) =>
        recordDecision({ node_id, decision, alternatives, why, consequences, supersedes, change, id, keep_whole, nodes, verbose })
  ),
];
