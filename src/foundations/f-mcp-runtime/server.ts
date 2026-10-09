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
 * The systems dialect, served as MCP server instructions.
 * Walks up from this module to the package root that ships templates/agent/playbook.md.
 * Never throws: a missing or unreadable file means boot continues without instructions.
 */
function loadServerInstructions(): string | undefined {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "templates", "agent", "playbook.md");
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf-8");
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    console.error("MindPlan: templates/agent/playbook.md not found; starting without server instructions");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`MindPlan: could not read playbook for server instructions (${message}); starting without them`);
  }
  return undefined;
}

async function runMcpServer(): Promise<void> {
  ensureDirectories();
  const instructions = loadServerInstructions();
  const server = new McpServer(
    {
      name: "mindplan",
      version: "0.1.0",
    },
    instructions ? { instructions } : undefined
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
