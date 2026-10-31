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
        "Call when standing rules change. The next action calls get_rules again. " +
        "Writes the ## Rules section of mindplan/project.md via the territory store. " +
        "Leaves ## Description unchanged. Do not hand-edit project.md.",
      inputSchema: {
        rules: z
          .string()
          .describe("Replace the ## Rules section body. Empty string clears it."),
      },
    },
    ({ rules }) => patchProjectRules({ rules })
  ),
  defineTool(
    "patch_config",
    {
      kind: "write",
      title: "Patch project config",
      description:
        "Call when source roots, exclude paths, decision-gate settings, hotspot thresholds, or search settings change. " +
        "Writes mindplan/config.json sources, exclude, decisions, hotspots, and/or search via the territory store. " +
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
      },
    },
    ({ sources, exclude, decisions, hotspots, search }) =>
      patchConfig({ sources, exclude, decisions, hotspots, search })
  ),
];
