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
  CHANGE_ID,
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
        "on the node the choice shapes. Appends a structured entry to that node's ## Decisions section: on its next slot while a revision is open, else live. " +
        "Records are never rewritten: to change a decision, record a new one with supersedes (the old one stays listable as superseded). " +
        "A decision-worthy revision (a shipped Foundation's contract, a new migration or schema file, a wide blast radius, a depends_on change) " +
        "is Blocked at in-review until a decision is recorded under its change id or on the node. Never resets readiness.",
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
          .describe("Id of an active decision on this node, its Journey, or its Foundations that this one replaces."),
        change: CHANGE_ID.optional().describe(
          "Change id to record it under (default: the node's open revision's change, or a neighbor's label). On a shipped node with no open next it also labels the node a neighbor of that change."
        ),
        id: z
          .string()
          .regex(DECISION_ID_PATTERN, 'decision ids are "d-" followed by a slug')
          .optional()
          .describe("Stable id, e.g. d-capacity-on-booking. Generated from the decision when omitted."),
      },
    },
    
      ({ node_id, decision, alternatives, why, consequences, supersedes, change, id, keep_whole, verbose }) =>
        recordDecision({ node_id, decision, alternatives, why, consequences, supersedes, change, id, keep_whole, verbose })
  ),
];
