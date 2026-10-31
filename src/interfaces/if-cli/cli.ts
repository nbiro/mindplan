/**
 * CLI Interface — argv parsing, help, stdout/stderr, exit codes for check / view. Setting up and
 * upgrading a project are MCP tools (setup_project, upgrade_project), not commands.
 * Dispatches to Interaction entrypoints; does not own integrity math.
 */

import {
  renderCheckOutput,
  runIntegrityCheck,
  type MergeLevel,
} from "../../interactions/i-check-integrity/check.js";
import { runViewExport } from "../../interactions/i-export-map/handlers.js";

function parseViewArgs(argv: string[]): {
  format: "mermaid" | "dot";
  focus?: string;
  include_retired: boolean;
  output?: string;
} {
  let format: "mermaid" | "dot" = "mermaid";
  let focus: string | undefined;
  let include_retired = false;
  let output: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format" || arg === "-f") {
      const value = argv[++i];
      if (value !== "mermaid" && value !== "dot") {
        throw new Error(`Invalid --format "${value ?? ""}". Use mermaid or dot.`);
      }
      format = value;
    } else if (arg === "--focus") {
      focus = argv[++i];
      if (!focus) throw new Error("--focus requires a node id.");
    } else if (arg === "--include-retired") {
      include_retired = true;
    } else if (arg === "--output" || arg === "-o") {
      output = argv[++i];
      if (!output) throw new Error("--output requires a file path.");
    } else if (arg === "export") {
      // alias accepted as subcommand synonym — ignore
    } else {
      throw new Error(`Unknown view option: ${arg}`);
    }
  }

  return { format, focus, include_retired, output };
}

function runViewCli(argv: string[]): void {
  const opts = parseViewArgs(argv);
  const result = runViewExport(opts);
  if (result.written_to) {
    console.error(
      `Wrote ${result.format} view (${result.node_count} nodes, ${result.edge_count} edges) to ${result.written_to}`
    );
  } else {
    process.stdout.write(result.diagram);
  }
  printRemovedLegacyFiles(result.removed_legacy_files);
}

function parseCheckArgs(argv: string[]): { base?: string; merge?: MergeLevel } {
  let base: string | undefined;
  let merge: MergeLevel | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error("Blocked: --base requires a git ref.");
      base = value;
    } else if (arg === "--merge" || arg.startsWith("--merge=")) {
      const value = arg === "--merge" ? undefined : arg.slice("--merge=".length);
      if (value !== undefined && value !== "strict") {
        throw new Error(`Blocked: unknown merge level "${value}". Use --merge or --merge=strict.`);
      }
      const level: MergeLevel = value === "strict" ? "strict" : true;
      if (merge !== undefined && merge !== level) {
        throw new Error("Blocked: --merge and --merge=strict were both passed. Pass one merge level.");
      }
      merge = level;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("HELP");
    } else {
      throw new Error(`Blocked: unknown check option "${arg}".`);
    }
  }
  return { base, merge };
}

function runCheckCli(argv: string[]): void {
  try {
    const opts = parseCheckArgs(argv);
    const result = runIntegrityCheck({ base: opts.base, merge: opts.merge });
    printRemovedLegacyFiles(result.removedLegacyFiles);
    const output = renderCheckOutput(result);
    if (result.ok) {
      console.log(output);
      return;
    }
    console.error(output);
    process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "HELP") {
      console.log(`Usage:
  mindplan-mcp check                  Graph load + file ownership (default; CI mode)
  mindplan-mcp check --base <ref>     Also enforce dirty-src ownership vs base
  mindplan-mcp check --merge          Merge gate: also Block work still in review
  mindplan-mcp check --merge=strict   Also Block in-progress work whose claimed files changed

Options:
  --base <ref>      Opt-in dirty-src vs this git ref; the strict merge gate's base
  --merge           Block in-review nodes and Bugs (run on PRs to the default branch)
  --merge=strict    Also Block in-progress nodes whose claimed files changed against
                    --base (default: the main/master merge base; an explicit --base
                    also runs dirty-src)
`);
      return;
    }
    console.error(message.startsWith("Blocked:") ? message : `Error: ${message}`);
    process.exit(1);
  }
}

function printRemovedLegacyFiles(removed: { from: string; to: string }[]): void {
  for (const entry of removed) {
    console.error(`Removed ${entry.from} (kept ${entry.to})`);
  }
}

function printHelp(): void {
  console.log(`Usage:
  mindplan-mcp              Start the MCP server (stdio)
  mindplan-mcp view         Print a Mermaid/DOT projection of the territory graph
  mindplan-mcp export       Alias for view
  mindplan-mcp check        Offline integrity: graph + file ownership (default CI mode)
  mindplan-mcp help         Show this message

Set up or upgrade a project:
  Register the MindPlan MCP server with your agent, then ask it to set up MindPlan.
  The agent calls setup_project (no graph yet) or upgrade_project (graph behind the server);
  every other tool says which one when it is needed.

View options:
  --format, -f mermaid|dot  Diagram format (default: mermaid)
  --focus <node-id>         Focus node + 1-hop neighborhood only
  --include-retired         Include deprecated/cancelled nodes and closed bugs
  --output, -o <file>       Write diagram to a file instead of stdout

Check options:
  --base <ref>              Opt-in dirty-src ownership vs this git ref (not used by CI);
                            also the base of --merge=strict
  --merge                   Merge gate: Block in-review nodes and Bugs (a PR to the default
                            branch must ship them first, or move them back to in-progress)
  --merge=strict            Also Block in-progress nodes whose claimed files changed against
                            the base (default: the main/master merge base)

Environment:
  MINDPLAN_ROOT   Project root containing mindplan/ (default: cwd)`);
}

/**
 * Parse and dispatch CLI commands. When argv has no command (MCP mode),
 * returns without starting the server — caller decides MCP boot.
 * @returns true if a CLI command was handled (including unknown command exit).
 */
export function runCli(argv: string[] = process.argv): boolean {
  const cmd = argv[2];
  if (cmd === "init") {
    console.error(
      "mindplan-mcp init is gone: set up and upgrade a project from your agent through the MindPlan MCP server. " +
        "Register the server, then ask the agent to set up MindPlan (setup_project) or upgrade the graph (upgrade_project)."
    );
    process.exit(1);
  }

  if (cmd === "view" || cmd === "export") {
    try {
      runViewCli(argv.slice(3));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message.startsWith("Blocked:") ? message : `Error: ${message}`);
      process.exit(1);
    }
    return true;
  }

  if (cmd === "check") {
    runCheckCli(argv.slice(3));
    return true;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return true;
  }

  if (cmd) {
    console.error(`Unknown command: ${cmd}`);
    console.error("Run mindplan-mcp help for usage.");
    process.exit(1);
  }

  return false;
}
