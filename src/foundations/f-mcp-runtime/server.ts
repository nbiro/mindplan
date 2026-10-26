#!/usr/bin/env node
/**
 * MindPlan MCP runtime — thin process boot only.
 * Mode select: no argv → MCP stdio; else CLI via if-cli.
 * Tool registration: if-mcp-tools. Handlers live in Interactions.
 * Starts the search warm-up (f-graph-search) in the background once the transport is up.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  drainRemovedLegacyFiles,
  ensureDirectories,
  loadGraph,
  projectRoot,
  territoryBodyReader,
} from "../f-territory-store/store.js";
import { warmSearchIndex } from "../f-graph-search/search.js";
import { enableOrientationGate } from "../f-orientation-ledger/ledger.js";
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

/**
 * stdout is the MCP stdio channel: route every console method that would write there to stderr,
 * so a dependency's log line (the embedding model, a warning) can never corrupt a message.
 */
export function guardStdout(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

async function runMcpServer(): Promise<void> {
  guardStdout();
  // One server process is one agent session: writes on a node wait for its orientation.
  enableOrientationGate();
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
  // Background: load the search model, then index the graph. Tool calls never wait on it. A legacy
  // file the warm-up's graph load removes is reported on stderr here, so it never lands in an
  // unrelated tool call's changed_files.
  const loadForSearch = () => {
    const graph = loadGraph();
    for (const entry of drainRemovedLegacyFiles()) {
      console.error(`MindPlan: removed ${entry.from} (kept ${entry.to})`);
    }
    return graph;
  };
  void warmSearchIndex(projectRoot(), loadForSearch, territoryBodyReader());
}

if (process.argv[2]) {
  runCli();
} else {
  runMcpServer().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
