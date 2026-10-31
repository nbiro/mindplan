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
        "Call when get_project's version or a Blocked: Version names setup_project (the repo has no mindplan/ graph), or the user asks to set up MindPlan. " +
        "Creates the graph (mindplan/ tree, default config.json, empty project.md, version stamp) and returns " +
        "{ created, changed_files, ci?, pointer, guide }: pointer is the text for MINDPLAN.md, guide the steps that follow (wire CLAUDE.md / AGENTS.md, ignores, move rules into the brief with the user's approval, the description, run_check). " +
        "It writes no other file of yours; on a graph that already exists it writes nothing and returns the guide again. " +
        "Pass ci: \"github\" once the user wants the merge-gate workflow (.github/workflows/mindplan-merge-gate.yml; an existing one is kept). " +
        "Blocked on a graph that needs upgrade_project, or on one newer than this server.",
      inputSchema: {
        ci: z
          .enum(["github"])
          .optional()
          .describe("Also write the GitHub merge-gate workflow, which runs check --merge on pull requests to the default branch."),
      },
    },
    ({ ci }) => setupProject({ ci })
  ),
];
