/**
 * CLI Interface — argv parsing, help, stdout/stderr, exit codes for init / check / view.
 * Dispatches to Interaction entrypoints; does not own installers or integrity math.
 */

import {
  resolvePackageRoot,
  runInit,
  type InitLayout,
} from "../../interactions/i-init-project/init.js";
import { runIntegrityCheck } from "../../interactions/i-check-integrity/check.js";
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
}

function parseCheckArgs(argv: string[]): { base?: string } {
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error("Blocked: --base requires a git ref.");
      base = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("HELP");
    } else {
      throw new Error(`Blocked: unknown check option "${arg}".`);
    }
  }
  return { base };
}

function runCheckCli(argv: string[]): void {
  try {
    const opts = parseCheckArgs(argv);
    const result = runIntegrityCheck({ base: opts.base });
    if (result.ok) {
      console.log("mindplan-mcp check: ok");
      return;
    }
    for (const line of result.failures) {
      console.error(line);
    }
    process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "HELP") {
      console.log(`Usage:
  mindplan-mcp check                  Graph load + packages (default; CI mode)
  mindplan-mcp check --base <ref>     Also enforce dirty-src ownership vs base

Options:
  --base <ref>   Opt-in dirty-src vs this git ref (not used by CI)
`);
      return;
    }
    console.error(message.startsWith("Blocked:") ? message : `Error: ${message}`);
    process.exit(1);
  }
}

function parseInitArgs(argv: string[]): {
  layout: InitLayout;
  forceLayout: boolean;
  force: boolean;
  error?: string;
} {
  let layout: InitLayout = "prescribed";
  let forceLayout = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--layout") {
      const value = argv[++i];
      if (value !== "free" && value !== "prescribed") {
        return {
          layout: "prescribed",
          forceLayout: false,
          force: false,
          error: `Blocked: --layout must be "free" or "prescribed" (got ${value ?? "(missing)"}).`,
        };
      }
      layout = value;
      forceLayout = true;
    } else if (arg.startsWith("--layout=")) {
      const value = arg.slice("--layout=".length);
      if (value !== "free" && value !== "prescribed") {
        return {
          layout: "prescribed",
          forceLayout: false,
          force: false,
          error: `Blocked: --layout must be "free" or "prescribed" (got ${value}).`,
        };
      }
      layout = value;
      forceLayout = true;
    } else if (arg === "-f" || arg === "--force") {
      force = true;
    } else {
      return {
        layout: "prescribed",
        forceLayout: false,
        force: false,
        error: `Blocked: unknown init option "${arg}". Use --layout free|prescribed and/or -f|--force.`,
      };
    }
  }
  return { layout, forceLayout, force };
}

function printInitReport(
  report: ReturnType<typeof runInit>
): void {
  if (report.created) {
    console.log(`Initialized MindPlan at ${report.root}`);
  } else {
    console.log(`MindPlan already initialized at ${report.root}`);
  }

  const printInstall = (label: string, result: { installed: boolean; path: string }) => {
    console.log(
      result.installed ? `Installed ${label} at ${result.path}` : `${label} already present at ${result.path}`
    );
  };

  if (report.projectConfig.installed) {
    console.log(
      `Installed project config at ${report.projectConfig.path} (implementation_packages: ${report.projectConfig.config.implementation_packages})`
    );
  } else {
    console.log(
      `Project config already present at ${report.projectConfig.path} (implementation_packages: ${report.projectConfig.config.implementation_packages})`
    );
  }
  printInstall("agent playbook", report.playbook);
  printInstall("define-entities skill", report.skill);
  printInstall("plan-project skill", report.planSkill);
  printInstall("review-work skill", report.reviewSkill);
  printInstall("code-review skill", report.codeReviewSkill);
  printInstall("MCP example", report.mcpExample);
  printInstall("agent integrations", report.integrations);
  printInstall("AGENTS.md", report.agentsMd);
  printInstall(".cursorignore", report.cursorIgnore);
  for (const cursorSkill of report.cursorSkills) {
    printInstall("Cursor skill", cursorSkill);
  }
  printInstall("Cursor rule", report.cursorRule);
  printInstall(".cursor/permissions.json", report.cursorPermissions);

  if (!report.agentsMd.installed) {
    console.log("Tip: add a reference to mindplan/agent/playbook.md in your existing AGENTS.md.");
  }

  if (report.reviewSkill.installed && !report.playbook.installed) {
    console.log(
      "Tip: refresh mindplan/agent/playbook.md (and root AGENTS.md if you use it) from the package templates — Plan Review (`draft → ready`) is now mandatory; the on-disk playbook may still describe the old self-advance path."
    );
  }

  if (report.projectConfig.config.implementation_packages === "off") {
    console.log(
      "Layout-free mode: create_node will not scaffold src/foundations|interactions|interfaces packages; check skips package/dirty-src ownership."
    );
  }

  console.log("Next: register the MindPlan MCP server — see mindplan/agent/integrations/");
}

function printHelp(): void {
  console.log(`Usage:
  mindplan-mcp              Start the MCP server (stdio)
  mindplan-mcp init         Scaffold mindplan/, config, agent playbook, skills, integrations, and .cursorignore
  mindplan-mcp view         Print a Mermaid/DOT projection of the territory graph
  mindplan-mcp export       Alias for view
  mindplan-mcp check        Offline integrity: graph + packages (default CI mode)
  mindplan-mcp help         Show this message

Init options:
  --layout free|prescribed  Write mindplan/config.json (free = off packages; prescribed = required).
                            With --layout, always overwrites existing config. Without --layout,
                            creates config only if missing (default prescribed / required).
  -f, --force               Overwrite existing agent assets (playbook, skills, Cursor copies,
                            AGENTS.md, .cursorignore, permissions, etc.) from package templates.
                            Does not change layout config unless --layout is also passed.

View options:
  --format, -f mermaid|dot  Diagram format (default: mermaid)
  --focus <node-id>         Focus node + 1-hop neighborhood only
  --include-retired         Include deprecated/cancelled nodes and closed bugs
  --output, -o <file>       Write diagram to a file instead of stdout

Check options:
  --base <ref>              Opt-in dirty-src ownership vs this git ref (not used by CI)

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
    try {
      const parsed = parseInitArgs(argv.slice(3));
      if (parsed.error) {
        console.error(parsed.error);
        process.exit(1);
      }
      const packageRoot = resolvePackageRoot(import.meta.url);
      const report = runInit({
        force: parsed.force,
        layout: parsed.layout,
        forceLayout: parsed.forceLayout,
        packageRoot,
      });
      printInitReport(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message.startsWith("Blocked:") ? message : `Error: ${message}`);
      process.exit(1);
    }
    return true;
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
