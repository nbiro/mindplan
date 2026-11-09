/**
 * MCP tool definitions owned by i-edit-brief: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
} from "../../foundations/f-tool-kit/tool.js";
import {
  patchConfig,
  patchProjectDescription,
  patchProjectRules,
} from "./handlers.js";

/** The MCP tools i-edit-brief owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "patch_project_description",
    {
      kind: "write",
      title: "Patch project description",
      description:
        "Call when the product summary changes. The next session start calls get_project again. " +
        "Writes the ## Description section of mindplan/project.md via the territory store. " +
        "Leaves ## Rules unchanged. Do not hand-edit project.md.",
      inputSchema: {
        description: z
          .string()
          .describe("Replace the ## Description section body. Empty string clears it."),
      },
    },
    ({ description }) => patchProjectDescription({ description })
  ),
  defineTool(
    "patch_project_rules",
    {
      kind: "write",
      title: "Patch project rules",
      description:
        "Call when a standing rule for all work changes; a rule about one node's work belongs in patch_node_rules instead. " +
        "Writes the ## Rules section of mindplan/project.md (## Description unchanged; do not hand-edit it): add / remove change single rules, rules replaces the whole text. " +
        "Rules reach a session once, through get_project, get_rules, or the project_rules push in orient replies; write tools are Blocked: Rules until they have. Returns a confirmation ({ rules_version, count, added, removed, skipped? }), not the rules; get_rules returns the text. " +
        "Details: get_spec({ topic: \"patch_project_rules\" }).",
      inputSchema: {
        rules: z
          .string()
          .optional()
          .describe("Replace the whole ## Rules section body. Empty string clears it. Not combined with add / remove."),
        add: z
          .array(z.string())
          .optional()
          .describe("Rules to append, each as one bullet. A rule already present is skipped."),
        remove: z
          .array(z.string())
          .optional()
          .describe("Rules to drop, by their text (the full rule, or a fragment that matches exactly one). No match or several is Blocked. Applied before add."),
      },
    },
    ({ rules, add, remove }) => patchProjectRules({ rules, add, remove })
  ),
  defineTool(
    "patch_config",
    {
      kind: "write",
      title: "Patch project config",
      description:
        "Call when source roots, exclude paths, decision-gate settings, hotspot thresholds, the fan-out threshold, search, reply size, the test command, or when rules' command checks run change. " +
        "Writes mindplan/config.json sources, exclude, decisions, hotspots, fan_out, fan_in, search, replies, tests, and/or rule_checks via the territory store. " +
        "Do not hand-edit config.json.",
      inputSchema: {
        sources: z
          .array(z.string())
          .optional()
          .describe("Glob list for the ownership universe (replaces sources when set)."),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Glob list excluded from the universe (replaces exclude when set)."),
        // Strict: an unknown (mistyped) key is rejected instead of stripped into a silent no-op.
        decisions: z
          .strictObject({
            blast_radius: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("A revision with more dependents than this is decision-worthy (default 5)."),
            schema_files: z
              .array(z.string().min(1))
              .optional()
              .describe("Globs of migration and schema files; claiming a new one is decision-worthy."),
          })
          .optional()
          .describe("Decision-gate settings. A field not passed keeps its stored value."),
        hotspots: z
          .strictObject({
            half_life_days: z
              .number()
              .positive()
              .optional()
              .describe("Days for a node's recent ship rate to fade by half (default 30)."),
            outlier_ratio: z
              .number()
              .positive()
              .optional()
              .describe("A node shipping this many times as often as the graph's median node is a hotspot (default 3)."),
            min_rate: z
              .number()
              .positive()
              .optional()
              .describe("The lowest recent ship rate that can be a hotspot (default 2)."),
          })
          .optional()
          .describe("Hotspot settings, used by run_check warnings and the open_next warning. A field not passed keeps its stored value."),
        fan_out: z
          .strictObject({
            warn_at: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("A pre-ship node depending on nodes in this many other unshipped changes gets a fan-out: warning (default 3)."),
          })
          .optional()
          .describe("Fan-out settings, used by run_check warnings. A field not passed keeps its stored value."),
        fan_in: z
          .strictObject({
            exempt_roles: z
              .array(z.enum(["assembler", "infra", "design-system", "adapter"]))
              .optional()
              .describe('Foundation roles the fan-in: warning skips (default ["assembler", "design-system"]); [] warns for every role.'),
          })
          .optional()
          .describe("Fan-in settings: a pre-ship Foundation with more direct dependents than decisions.blast_radius gets a fan-in: warning unless its role is exempt or it holds a keep_whole decision. A field not passed keeps its stored value."),
        search: z
          .strictObject({
            enabled: z
              .boolean()
              .optional()
              .describe("false turns semantic ranking off (keyword ranking always runs). Default true."),
            model: z
              .string()
              .min(1)
              .optional()
              .describe('Embedding model id (default "Xenova/bge-small-en-v1.5"); changing it rebuilds the search cache.'),
          })
          .optional()
          .describe("Search settings. A field not passed keeps its stored value."),
        replies: z
          .strictObject({
            budget_bytes: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Cap on one reply's JSON size (default 8192; 0 turns it off). Lists past it come back cut with a next_page cursor; rule text is never cut."),
            legacy: z
              .boolean()
              .optional()
              .describe("true restores the 0.22 reply shapes: the full drift list and rule text on every reply. Default false."),
          })
          .optional()
          .describe("Reply settings. A field not passed keeps its stored value."),
        tests: z
          .strictObject({
            command: z
              .string()
              .min(1)
              .optional()
              .describe('How run_check({ run_tests: true }) runs linked tests: a command with {files}, e.g. "npm run test:files -- {files}".'),
          })
          .optional()
          .describe("Test settings. A field not passed keeps its stored value."),
        rule_checks: z
          .strictObject({
            commands: z
              .enum(["off", "local", "always"])
              .optional()
              .describe('When run_check runs rules\' command checks: "off" never (default), "local" except in CI (env CI set), "always" also in CI.'),
          })
          .optional()
          .describe("Rule-check settings. A field not passed keeps its stored value."),
      },
    },
    ({ sources, exclude, decisions, hotspots, fan_out, fan_in, search, replies, tests, rule_checks }) =>
      patchConfig({ sources, exclude, decisions, hotspots, fan_out, fan_in, search, replies, tests, rule_checks })
  ),
];
