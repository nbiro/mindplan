/**
 * CLI Interface — argv parsing, help, stdout/stderr, exit codes for init / check / view.
 * Dispatches to Interaction entrypoints; does not own installers or integrity math.
 */

import {
  INIT_CI,
  INIT_HOSTS,
  LegacyTerritoryMigrationError,
  resolvePackageRoot,
  runInit,
  type InitCi,
  type InitHost,
  type LegacyTerritoryRename,
} from "../../interactions/i-init-project/init.js";
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

function parseInitArgs(argv: string[]): {
  force: boolean;
  hosts: InitHost[];
  ci?: InitCi;
  error?: string;
} {
  let force = false;
  let hosts: InitHost[] = ["cursor"];
  let ci: InitCi | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-f" || arg === "--force") {
      force = true;
    } else if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? argv[++i] : arg.slice("--host=".length);
      if (value === "all") {
        hosts = [...INIT_HOSTS];
      } else if ((INIT_HOSTS as readonly string[]).includes(value)) {
        hosts = [value as InitHost];
      } else {
        return {
          force: false,
          hosts,
          error: `Blocked: unknown init host "${value ?? ""}". Use --host cursor|claude|all.`,
        };
      }
    } else if (arg === "--ci" || arg.startsWith("--ci=")) {
      const value = arg === "--ci" ? argv[++i] : arg.slice("--ci=".length);
      if (!(INIT_CI as readonly string[]).includes(value)) {
        return {
          force: false,
          hosts,
          error: `Blocked: unknown init ci "${value ?? ""}". Use --ci github.`,
        };
      }
      ci = value as InitCi;
    } else if (arg === "--layout" || arg.startsWith("--layout=")) {
      return {
        force: false,
        hosts,
        error:
          'Blocked: --layout is removed. Run `mindplan-mcp init` to migrate implementation_packages to { sources, exclude }.',
      };
    } else {
      return {
        force: false,
        hosts,
        error: `Blocked: unknown init option "${arg}". Use -f|--force, --host cursor|claude|all, or --ci github.`,
      };
    }
  }
  return { force, hosts, ci };
}

function printRemovedLegacyFiles(removed: { from: string; to: string }[]): void {
  for (const entry of removed) {
    console.error(`Removed ${entry.from} (kept ${entry.to})`);
  }
}

function printTerritoryFilenames(renames: LegacyTerritoryRename[]): void {
  for (const renamed of renames) {
    if (renamed.action === "removed") {
      console.log(`Removed ${renamed.from} (kept ${renamed.to})`);
    } else {
      console.log(`Renamed ${renamed.from} → ${renamed.to}`);
    }
  }
}

function printInitReport(report: ReturnType<typeof runInit>): void {
  if (report.created) {
    console.log(`Initialized MindPlan at ${report.root}`);
  } else {
    console.log(`MindPlan already initialized at ${report.root}`);
  }

  printTerritoryFilenames(report.territoryFilenames);

  const printInstall = (label: string, result: { installed: boolean; path: string }) => {
    console.log(
      result.installed ? `Installed ${label} at ${result.path}` : `${label} already present at ${result.path}`
    );
  };

  const cfg = report.projectConfig;
  const sources = JSON.stringify(cfg.config.sources);
  if (cfg.migrated) {
    console.log(
      `Migrated project config at ${cfg.path} → sources: ${sources}, exclude: ${JSON.stringify(cfg.config.exclude)}` +
        (cfg.seeded_implements
          ? ` (seeded implements on ${cfg.seeded_implements} node(s)`
          : "") +
        (cfg.seeded_roles ? `, roles on ${cfg.seeded_roles}` : "") +
        (cfg.seeded_implements || cfg.seeded_roles ? ")" : "")
    );
  } else if (cfg.installed) {
    console.log(
      `Installed project config at ${cfg.path} (sources: ${sources})`
    );
  } else {
    console.log(
      `Project config already present at ${cfg.path} (sources: ${sources})`
    );
  }
  printInstall("project brief", report.projectBrief);
  printInstall("agent playbook", report.playbook);
  printInstall("define-entities skill", report.skill);
  printInstall("plan-project skill", report.planSkill);
  printInstall("MCP example", report.mcpExample);
  printInstall("agent integrations", report.integrations);
  printInstall("AGENTS.md", report.agentsMd);
  printInstall(".gitignore entry for .mindplan-cache/", report.searchCacheIgnore);
  if (report.cursor) {
    printInstall(".cursorignore", report.cursor.ignore);
    for (const cursorSkill of report.cursor.skills) {
      printInstall("Cursor skill", cursorSkill);
    }
    printInstall("Cursor rule", report.cursor.rule);
    printInstall(".cursor/permissions.json", report.cursor.permissions);
  }
  if (report.claude) {
    printInstall("CLAUDE.md", report.claude.claudeMd);
    for (const claudeSkill of report.claude.skills) {
      printInstall("Claude skill", claudeSkill);
    }
  }
  if (report.ci) {
    printInstall("merge-gate workflow", report.ci);
    console.log(
      "Make its \"mindplan merge gate\" job a required status check on the default branch (Settings → Branches), so a PR with work still in review cannot merge."
    );
  }
  const version = report.version;
  if (version.from === version.to) {
    console.log(`Stamped mindplan/version.json at ${version.to}`);
  } else {
    console.log(
      `Stamped mindplan/version.json ${version.from ?? "(none)"} → ${version.to}` +
        (version.refreshed ? " and refreshed the package-owned agent files" : "")
    );
  }
  for (const twin of report.mirrorTwins) {
    console.log(`Wrote mirror twin ${twin.path} (${twin.node_id})`);
  }
  for (const skip of report.mirrorTwinSkips) {
    console.log(`Skipped mirror twin for ${skip.node_id}: ${skip.reason}`);
  }

  if (!report.agentsMd.installed) {
    console.log(
      "Tip: your existing AGENTS.md was kept. Add the MindPlan stub (see the host rule or templates/agent/agents-stub.md): orient with orient_for_work first, and follow the MindPlan MCP server instructions."
    );
  }

  console.log(
    "Declare owned files with set_implementation_files. Coverage is governed by mindplan/config.json sources/exclude."
  );
  console.log("Next: register the MindPlan MCP server — see mindplan/agent/integrations/");
}

function printHelp(): void {
  console.log(`Usage:
  mindplan-mcp              Start the MCP server (stdio)
  mindplan-mcp init         Scaffold mindplan/, config, agent playbook, skills, integrations, and host copies (--host).
                            Also renames legacy current.mdx / next.mdx to <id>.mdx / <id>.next.mdx.
                            Stamps mindplan/version.json; rerun after upgrading mindplan-mcp.
  mindplan-mcp view         Print a Mermaid/DOT projection of the territory graph
  mindplan-mcp export       Alias for view
  mindplan-mcp check        Offline integrity: graph + file ownership (default CI mode)
  mindplan-mcp help         Show this message

Init options:
  --host cursor|claude|all  Host copies to install: Cursor (.cursor/, .cursorignore), Claude Code
                            (CLAUDE.md, .claude/skills/), or both (default: cursor).
  --ci github               Also install .github/workflows/mindplan-merge-gate.yml at the
                            repository top, which runs check --merge in this project on pull
                            requests to the default branch (kept when present unless --force).
                            Make it a required status check.
  -f, --force               Overwrite existing agent assets (playbook, skills, host copies,
                            AGENTS.md, CLAUDE.md, .cursorignore, permissions, etc.) from package templates.
                            Also migrates legacy implementation_packages → { sources, exclude }.
                            Without --force, the package-owned files (playbook, skills, integrations,
                            MCP example, host skill copies, Cursor rule) are still rewritten when
                            mindplan/version.json is missing or older than this package.

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
    try {
      const parsed = parseInitArgs(argv.slice(3));
      if (parsed.error) {
        console.error(parsed.error);
        process.exit(1);
      }
      const packageRoot = resolvePackageRoot(import.meta.url);
      const report = runInit({
        force: parsed.force,
        hosts: parsed.hosts,
        ci: parsed.ci,
        packageRoot,
      });
      printInitReport(report);
      printRemovedLegacyFiles(report.removedLegacyFiles);
    } catch (err) {
      if (err instanceof LegacyTerritoryMigrationError) {
        printTerritoryFilenames(err.applied);
      }
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
