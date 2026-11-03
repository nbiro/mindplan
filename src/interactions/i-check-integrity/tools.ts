/**
 * MCP tool definitions owned by i-check-integrity: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
  CHANGE_ID,
  NODE_ID,
} from "../../foundations/f-tool-kit/tool.js";
import {
  runCheckHandler,
} from "./check.js";
import { acknowledgeWarnings } from "./compact.js";
import { projectRoot } from "../../foundations/f-territory-store/store.js";

/** The MCP tools i-check-integrity owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "run_check",
    {
      kind: "read",
      drift: false,
      gate: false,
      title: "Run the integrity check",
      description:
        "Call before in-review, before ship, and before telling the user the work is done. " +
        "Runs the same check as `mindplan-mcp check`: graph load, exclusivity, coverage, presence (claims, and linked tests once a node is in review or shipped), leftovers, and the import matrix. " +
        "Returns compact by default: { ok, counts: { <category>: n, out_of_scope? }, failures, warnings: [{ id, text }], acknowledged, unchanged }, where warnings are only those not shown by the previous check of this root and not acknowledged (acknowledge_warning), and unchanged / acknowledged count the rest; a changed text gets a new id. " +
        "Pass compact: false for { ok, output, failures, warnings, info }: output is exactly what the CLI prints (`mindplan-mcp check: ok`, or one Blocked: line per failure with the fix for each illegal import, then Warning: and Info: lines). " +
        "Warnings flag draft nodes missing required sections (shape:), stale territory text, next-slot imports (one release before they Block), split route families, revisions in review with no linked tests, hotspots (hotspot: a shipped node shipping far more often than the project's median lately, ranked by fan-in, with its recent change groups), fan-out (fan-out: a pre-ship node whose depends_on targets sit in several other unshipped changes, so it may need to know every feature of a kind; invert it onto a Foundation contract, or record keep_whole), and leftover mirror twins from releases before 0.8.0 (upgrade_project removes them), and never fail the check; info lists paths a plan names before building them (planned:), one line per node. " +
        "A graph that needs setup_project or upgrade_project fails with Blocked: Version. " +
        "An unclaimed source file is Blocked: Coverage with its probable owner and the claim call. " +
        "Pass change to also run the in-review gate on every member of that change: its open revisions (shipped nodes with planned edges are listed, not gated), with an additivity: info line and change.additivity (new nodes, reopened shipped nodes with their fan-in). A shipped node with no open next whose claimed files changed against the base gets every stale-text signal. " +
        "Pass merge before telling the user a PR is ready to merge: it Blocks every node still in review (ship its change, or move it back to in-progress), and with \"strict\" also in-progress nodes whose claimed files changed against base; results carry merge grouped by change. " +
        "Pass after_merge after merging a branch that changed the graph: each leftover of the merge is a Blocked: after-merge: line with its fix. " +
        "Moves to in-review and ship run this check on the node's files themselves.",
      inputSchema: {
        base: z
          .string()
          .optional()
          .describe("Opt-in: also enforce dirty-src ownership against this git ref (not used by CI)."),
        change: CHANGE_ID.optional().describe(
          "Also check every member of this change (imports, ownership, stale text) and list its members, each with kind revision | planned."
        ),
        merge: z
          .union([z.literal(true), z.literal("strict")])
          .optional()
          .describe(
            "Merge gate: true Blocks in-review nodes and Bugs; \"strict\" also Blocks in-progress nodes whose claimed files changed against base (default: the main/master merge base)."
          ),
        after_merge: z
          .boolean()
          .optional()
          .describe(
            "After merging a branch that changed mindplan/: also Block git conflict markers, a node id in two folders, a decision id in two files, revisions whose base no longer matches live (fix: rebase_revision), a tracked mindplan/map.md, and a missing or behind version.json."
          ),
        compact: z
          .boolean()
          .optional()
          .describe("Default true: counts plus only new warnings with ids. false: the full output, every warning as text, and info."),
        nodes: z
          .array(NODE_ID)
          .optional()
          .describe("Limit warnings to these nodes; failures stay graph-wide, and counts.out_of_scope says how many warnings were left out."),
      },
    },
    ({ base, change, merge, after_merge, compact, nodes }) =>
      runCheckHandler({ base, change, merge, after_merge, compact: compact ?? true, nodes })
  ),
  defineTool(
    "acknowledge_warning",
    {
      kind: "write",
      drift: false,
      gate: false,
      title: "Acknowledge a check warning",
      description:
        "Call when a run_check warning is known and accepted, so compact checks stop listing it. " +
        "Stores the w- ids a compact run_check lists in .mindplan-cache/acks.json of this root; returns { acknowledged: [ids] }. " +
        "Acknowledged warnings are left out of compact results and counted as acknowledged; when a warning's text changes it gets a new id and shows again. Writes no graph node.",
      inputSchema: {
        id: z.string().optional().describe("One warning id (w-<10 hex>) from a compact run_check."),
        ids: z.array(z.string()).optional().describe("Several warning ids."),
      },
    },
    ({ id, ids }) => acknowledgeWarnings(projectRoot(), { id, ids })
  ),
];
