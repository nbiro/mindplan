/**
 * MCP tool definitions owned by i-setup-project: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
} from "../../foundations/f-tool-kit/tool.js";
import {
  setupProject,
} from "./handlers.js";

/** The MCP tools i-setup-project owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "setup_project",
    {
      kind: "write",
      drift: false,
      gate: false,
      title: "Set up MindPlan in this project",
      description:
        "Call when get_project's version or a Blocked: Version names setup_project, or the user asks to set up MindPlan. " +
        "Creates the mindplan/ graph and writes no other file unless asked; returns { created, changed_files, ci?, hook?, pointer, guide }: the MINDPLAN.md text and the follow-up steps (an existing graph is left as is). " +
        "Pass ci: \"github\" for the merge-gate workflow, install_hook: true for the Claude Code hook that keeps host file writes off mindplan/ (hook.offer says when it is missing). Blocked on a graph that needs upgrade_project. " +
        "Details: get_spec({ topic: \"setup_project\" }).",
      inputSchema: {
        ci: z
          .enum(["github"])
          .optional()
          .describe("Also write the GitHub merge-gate workflow, which runs check --merge on pull requests to the default branch."),
        install_hook: z
          .boolean()
          .optional()
          .describe("Also merge a Claude Code PreToolUse hook into .claude/settings.json that denies host Edit/Write on mindplan/** (reads stay free) and names the MindPlan tool to use."),
      },
    },
    ({ ci, install_hook }) => setupProject({ ci, install_hook })
  ),
];
