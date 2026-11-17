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
import { fullDrift } from "./drift.js";
import { projectRoot } from "../../foundations/f-territory-store/store.js";

/** The MCP tools i-check-integrity owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "get_drift",
    {
      kind: "read",
      drift: false,
      title: "Get the full drift list",
      description:
        "Call when a reply's drift count says source files drift and you need every path, or before handing off. " +
        "Returns { count, paths: [{ path, class, owner_id?, state?, next_state? }], expected, reminder }: every uncommitted source file whose owner has no open update (owner_idle), that a node claims but is missing (claimed_missing), or that no node claims (unowned). " +
        "Other replies carry only drift: { count, new_since_last_reply }. Details: get_spec({ topic: \"get_drift\" }).",
      inputSchema: {},
    },
    () => fullDrift()
  ),
  defineTool(
    "run_check",
    {
      kind: "read",
      drift: false,
      gate: false,
      // Pages itself: the handler cuts the reply once, so a compact check counts as seen only what it lists.
      budget: false,
      title: "Run the integrity check",
      description:
        "Call before in-review, before ship, and before telling the user the work is done. " +
        "Runs the same check as `mindplan-mcp check` (graph load, exclusivity, coverage, presence, leftovers, import matrix); warnings never fail it. " +
        "Compact by default: { ok, counts, failures, warnings: [{ id, text }], info, acknowledged, unchanged }, listing only warnings not shown earlier in this session or acknowledged (acknowledge_warning); nodes lists those nodes' warnings again; compact: false returns the CLI output. " +
        "A graph that needs setup_project or upgrade_project fails with Blocked: Version. An unclaimed source file is Blocked: Coverage with its probable owner and the claim call, or leads with create_node when no node has a file in its folder. " +
        "Pass change to also run the in-review gate on every member of that change. " +
        "Pass merge before telling the user a PR is ready to merge: it Blocks nodes still in review, and shipped nodes with no open revision whose claimed files changed against base while their territory did not (open_next + ship, or patch_node_territory in place); \"strict\" also Blocks in-progress nodes whose claimed files changed. " +
        "Pass after_merge after merging a branch that changed the graph. " +
        "Pass run_tests (with change or nodes) to run their linked tests; passing tests close each node's verify item. " +
        "Details: get_spec({ topic: \"run_check\" }).",
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
            "After merging a branch that changed mindplan/: also Block git conflict markers, a node id in two folders, a decision id in two files, a tracked mindplan/map.md, and a missing or behind version.json; a revision whose base no longer matches live is a Warning: after-merge: (fix: rebase_revision)."
          ),
        compact: z
          .boolean()
          .optional()
          .describe("Default true: counts, info, and only new warnings with ids. false: the full output, every warning as text, and info."),
        nodes: z
          .array(NODE_ID)
          .optional()
          .describe("Limit warnings to these nodes; failures stay graph-wide, and counts.out_of_scope says how many warnings were left out. With run_tests: the nodes whose linked tests run."),
        run_tests: z
          .boolean()
          .optional()
          .describe(
            "Also run the linked tests of change's members (or of nodes) with config tests.command; a failure is Blocked: Tests. Passing tests close each node's default verify item; spec and impl close at ship."
          ),
      },
    },
    ({ base, change, merge, after_merge, compact, nodes, run_tests }) =>
      runCheckHandler({ base, change, merge, after_merge, compact: compact ?? true, nodes, run_tests })
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
        "Stores the w- ids a compact run_check lists in .mindplan-cache/acks.json of this root (no graph write); returns { acknowledged: [ids] }. A warning whose text changes gets a new id and shows again. " +
        "Details: get_spec({ topic: \"acknowledge_warning\" }).",
      inputSchema: {
        id: z.string().optional().describe("One warning id (w-<10 hex>) from a compact run_check."),
        ids: z.array(z.string()).optional().describe("Several warning ids."),
      },
    },
    ({ id, ids }) => acknowledgeWarnings(projectRoot(), { id, ids })
  ),
];
