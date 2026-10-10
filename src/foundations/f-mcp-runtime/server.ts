#!/usr/bin/env node
/**
 * MindPlan MCP runtime — thin process boot only.
 * Mode select: no argv → MCP stdio; else CLI via if-cli.
 * Tool registration: if-mcp-tools. Handlers live in Interactions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ensureDirectories } from "../f-territory-store/store.js";
import { registerMindPlanTools } from "../../interfaces/if-mcp-tools/register.js";
import { runCli } from "../../interfaces/if-cli/cli.js";

/**
 * Short pointer only — dialect and project brief load via get_project.
 * Always present; never embeds playbook or mindplan/project.md bodies.
 */
export const SERVER_INSTRUCTIONS =
  "Before answering any questions or writing any code for this project, call get_project and read the response. " +
  "Follow the playbook (systems dialect) and the project description and rules it returns. " +
  "Then call orient_for_work before substantial work.";

async function runMcpServer(): Promise<void> {
  ensureDirectories();
  const server = new McpServer(
    {
      name: "mindplan",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerMindPlanTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MindPlan MCP server running on stdio");
}

if (process.argv[2]) {
  runCli();
} else {
  runMcpServer().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
