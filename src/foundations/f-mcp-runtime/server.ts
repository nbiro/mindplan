#!/usr/bin/env node
/**
 * MindPlan MCP runtime — thin process boot only.
 * Mode select: no argv → MCP stdio; else CLI via if-cli.
 * Tool registration: if-mcp-tools. Handlers live in Interactions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ensureDirectories } from "../f-territory-store/store.js";
import { packageVersion } from "../f-territory-store/version.js";
import { registerMindPlanTools } from "../../interfaces/if-mcp-tools/register.js";
import { runCli } from "../../interfaces/if-cli/cli.js";

/**
 * Short pointer only — dialect and project brief load via get_project / get_rules.
 * Always present; never embeds playbook or mindplan/project.md bodies.
 */
export const SERVER_INSTRUCTIONS =
  "Before answering any questions or writing any code for this project, call get_project and read the response. " +
  "Follow the playbook (systems dialect) and the project description and rules it returns. " +
  "Project rules are mandatory: before each action, call get_rules then orient_for_work. " +
  "Before any new-feature code change, update or create the matching nodes using the plan-project skill: " +
  "it covers every graph write (create_node, open_next, discard_next, link_nodes, unlink_nodes, patch_node_territory, " +
  "patch_node_rules, patch_project_description, patch_project_rules, patch_config, and attachments).";

/**
 * The package version reported on `initialize`, read from this package's own package.json
 * (works from a consumer's node_modules). Never throws: an unreadable file yields 0.0.0 and a stderr note.
 */
export function readPackageVersion(): string {
  return packageVersion();
}

async function runMcpServer(): Promise<void> {
  ensureDirectories();
  const server = new McpServer(
    {
      name: "mindplan",
      version: readPackageVersion(),
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
