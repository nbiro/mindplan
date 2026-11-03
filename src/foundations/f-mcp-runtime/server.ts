#!/usr/bin/env node
/**
 * MindPlan MCP runtime — thin process boot only.
 * Mode select: no argv → MCP stdio; else CLI via if-cli.
 * Tool registration: if-mcp-tools. Handlers live in Interactions.
 * Startup is lazy: initialize is answered before any graph load, migration check, search index, or
 * model load. The search warm-up (f-graph-search) starts only once the client is initialized.
 * Crashes and early exits are logged to stderr; stdout carries JSON-RPC only.
 */

import * as fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  drainRemovedLegacyFiles,
  loadGraph,
  projectRoot,
  territoryBodyReader,
} from "../f-territory-store/store.js";
import { warmSearchIndex } from "../f-graph-search/search.js";
import { enableOrientationGate } from "../f-orientation-ledger/ledger.js";
import { packageVersion } from "../f-territory-store/version.js";
import { registerMindPlanTools } from "../../interfaces/if-mcp-tools/register.js";
import { runCli } from "../../interfaces/if-cli/cli.js";
import { markServerStarted } from "./started.js";

/**
 * Short pointer only — dialect and project brief load via get_project / get_rules.
 * Always present; never embeds playbook or mindplan/project.md bodies.
 */
export const SERVER_INSTRUCTIONS =
  "Before answering any questions or writing any code for this project, call get_project and read the response. " +
  "Follow the playbook (systems dialect) and the project description and rules it returns. " +
  "Project rules are mandatory: before each action, call get_rules then orient_for_work. " +
  "Before any new-feature code change, update or create the matching nodes using the plan-project skill (load it with get_skill): " +
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

/** Writes one line to stderr synchronously, so it lands even when the process exits next. */
function stderrLine(text: string): void {
  try {
    fs.writeSync(2, `${text}\n`);
  } catch {
    // stderr is gone; nothing is left to tell.
  }
}

/** Logs why the process stops, then exits with `code`. */
function exitWith(reason: string, code: number): never {
  stderrLine(`mindplan-mcp: exiting (${reason})`);
  process.exit(code);
}

/** Logs `mindplan-mcp: fatal: <message>` and its stack to stderr, then exits 1. */
function fatal(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
  stderrLine(`mindplan-mcp: fatal: ${message}${stack}`);
  process.exit(1);
}

/** An uncaught error anywhere (the background warm-up, a stray promise) is logged, never silent. */
function installExitHandlers(): void {
  process.on("uncaughtException", (err) => fatal(err));
  process.on("unhandledRejection", (reason) => fatal(reason));
  process.on("SIGINT", () => exitWith("SIGINT", 0));
  process.on("SIGTERM", () => exitWith("SIGTERM", 0));
}

/** Test-only crash on the initialized path: MINDPLAN_TEST_CRASH=boot throws, =rejection rejects. */
function testCrash(): void {
  const mode = process.env.MINDPLAN_TEST_CRASH;
  if (mode === "boot") throw new Error("MINDPLAN_TEST_CRASH=boot");
  if (mode === "rejection") void Promise.reject(new Error("MINDPLAN_TEST_CRASH=rejection"));
}

async function runMcpServer(): Promise<void> {
  markServerStarted();
  installExitHandlers();
  guardStdout();
  // One server process is one agent session: writes on a node wait for its orientation.
  enableOrientationGate();
  // No directory is created here: mindplan/ appears only through setup_project, so graphStatus can
  // tell a repo without a graph from one with an empty graph. Nothing before initialize reads the
  // graph either: no graph load, migration check, search index, or model load.
  const server = new McpServer(
    {
      name: "mindplan",
      version: readPackageVersion(),
    },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerMindPlanTools(server);
  // A client that leaves before initialize leaves nothing to serve.
  process.stdin.on("end", () => {
    if (server.server.getClientVersion() === undefined) exitWith("stdin closed before initialize", 0);
    stderrLine("mindplan-mcp: exiting (stdin closed)");
  });
  // Background: load the search model, then index the graph. Tool calls never wait on it. It starts
  // once the client is initialized, on a later turn of the event loop: the graph load is
  // synchronous, so starting it at connect held the initialize reply until a large graph had
  // loaded. A legacy file the warm-up's graph load removes is reported on stderr here, so it never
  // lands in an unrelated tool call's changed_files.
  let warming = false;
  server.server.oninitialized = () => {
    if (warming) return;
    warming = true;
    setImmediate(() => {
      testCrash();
      console.error("MindPlan: search warm-up started");
      const loadForSearch = () => {
        const graph = loadGraph();
        for (const entry of drainRemovedLegacyFiles()) {
          console.error(`MindPlan: removed ${entry.from} (kept ${entry.to})`);
        }
        return graph;
      };
      void warmSearchIndex(projectRoot(), loadForSearch, territoryBodyReader());
    });
  };
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MindPlan MCP server running on stdio");
}

if (process.argv[2]) {
  runCli();
} else {
  runMcpServer().catch(fatal);
}
