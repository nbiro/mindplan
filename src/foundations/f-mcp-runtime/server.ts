#!/usr/bin/env node
/**
 * MindPlan MCP runtime — thin process boot only.
 * Mode select: no argv → MCP stdio; else CLI via if-cli.
 * Tool registration: if-mcp-tools. Handlers live in Interactions.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ensureDirectories } from "../f-territory-store/store.js";
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

/** Version reported on `initialize` when package.json cannot be read. */
const FALLBACK_VERSION = "0.0.0";

/**
 * Reads `version` from this package's own package.json, resolved relative to the compiled
 * module (dist/foundations/f-mcp-runtime/server.js -> ../../../package.json), so it works from
 * a consumer's node_modules. Never throws: an unreadable file yields the fallback and a stderr note.
 */
export function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = path.resolve(here, "..", "..", "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : FALLBACK_VERSION;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`MindPlan: could not read package.json version (${reason}); reporting ${FALLBACK_VERSION}`);
    return FALLBACK_VERSION;
  }
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
