/**
 * MCP tool definitions owned by i-upgrade-graph: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
} from "../../foundations/f-tool-kit/tool.js";
import {
  upgradeProject,
} from "./handlers.js";

/** The MCP tools i-upgrade-graph owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "upgrade_project",
    {
      kind: "write",
      drift: false,
      gate: false,
      title: "Upgrade the graph",
      description:
        "Call when get_project's version, a Blocked: Version, or the check names upgrade_project. " +
        "Runs every idempotent migration and stamps mindplan/version.json; returns { from_level, to_level, changed_files, hook?, migrations, leftovers, pointer_outdated, pointer, guide }: delete the leftovers and follow the guide. Commit the upgrade on its own. " +
        "Pass install_hook: true for the Claude Code hook that keeps host file writes off mindplan/ (hook.offer says when it is missing). " +
        "Blocked without a graph (call setup_project) or when the graph is newer than this server. " +
        "Details: get_spec({ topic: \"upgrade_project\" }).",
      inputSchema: {
        install_hook: z
          .boolean()
          .optional()
          .describe("Also merge a Claude Code PreToolUse hook into .claude/settings.json that denies host Read/Edit/Write/Grep/Glob on mindplan/** and names the MindPlan tool to use."),
      },
    },
    ({ install_hook }) => upgradeProject({ install_hook })
  ),
];
