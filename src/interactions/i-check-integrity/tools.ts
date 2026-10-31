/**
 * MCP tool definitions owned by i-check-integrity: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
  CHANGE_ID,
} from "../../foundations/f-tool-kit/tool.js";
import {
  runCheckHandler,
} from "./check.js";

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
        "Returns { ok, output, failures, warnings, info }: output is exactly what the CLI prints (`mindplan-mcp check: ok`, or one Blocked: line per failure with the fix for each illegal import, then Warning: and Info: lines). " +
        "Warnings flag draft nodes missing required sections (shape:), stale territory text, next-slot imports (one release before they Block), split route families, revisions in review with no linked tests, hotspots (hotspot: a shipped node shipping far more often than the project's median lately, ranked by fan-in, with its recent change groups), and leftover mirror twins from releases before 0.8.0 (upgrade_project removes them), and never fail the check; info lists paths a plan names before building them (planned:), one line per node. " +
        "A graph that needs setup_project or upgrade_project fails with Blocked: Version. " +
        "An unclaimed source file is Blocked: Coverage with its probable owner and the claim call. " +
        "Pass change to also run the in-review gate on every member of that change: its open revisions and its neighbors (shipped nodes it edits in place; decision warnings for revisions only), with an additivity: info line and change.additivity (new nodes, reopened shipped nodes with their fan-in, neighbors). " +
        "Pass merge before telling the user a PR is ready to merge: it Blocks every node still in review (ship its change, or move it back to in-progress), and with \"strict\" also in-progress nodes whose claimed files changed against base; results carry merge grouped by change. " +
        "Moves to in-review and ship run this check on the node's files themselves.",
      inputSchema: {
        base: z
          .string()
          .optional()
          .describe("Opt-in: also enforce dirty-src ownership against this git ref (not used by CI)."),
        change: CHANGE_ID.optional().describe(
          "Also check every member of this change (imports, ownership, stale text) and list its members, each with kind revision | neighbor."
        ),
        merge: z
          .union([z.literal(true), z.literal("strict")])
          .optional()
          .describe(
            "Merge gate: true Blocks in-review nodes and Bugs; \"strict\" also Blocks in-progress nodes whose claimed files changed against base (default: the main/master merge base)."
          ),
      },
    },
    ({ base, change, merge }) => runCheckHandler({ base, change, merge })
  ),
];
