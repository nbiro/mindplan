/**
 * Claude Code PreToolUse hook that keeps agents' host file writes off `mindplan/**` (reads are free) — owned by
 * Foundation f-agent-hook. Installs the hook into `.claude/settings.json` (setup_project and
 * upgrade_project with `install_hook: true`), reports whether it is installed, and decides one hook
 * call for `mindplan-mcp hook pre-tool-use`. Never throws on hook input.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/** The command the hook runs; `--no-install` never downloads a package from a hook. */
export const HOOK_COMMAND = "npx --no-install mindplan-mcp hook pre-tool-use";
/** The host file tools the hook watches. */
export const HOOK_MATCHER = "Edit|MultiEdit|Write|NotebookEdit";
/** Project-relative settings file the hook goes into. */
export const HOOK_SETTINGS_PATH = ".claude/settings.json";

/** Any mindplan-mcp hook command, local (`mindplan-mcp hook`) or pinned (`mindplan-mcp@0.23.0 hook`). */
const HOOK_MARKER = /mindplan-mcp(@\S+)?\s+hook\s+pre-tool-use/;

/** This package's version, read from its package.json beside the compiled module; null when unreadable. */
function ownVersion(): string | null {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
    const version = (JSON.parse(fs.readFileSync(file, "utf-8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The command to install for this project: `HOOK_COMMAND` when the project has mindplan-mcp in its
 * node_modules (no download from a hook), else `npx -y mindplan-mcp@<this version> hook pre-tool-use`,
 * which works in a project that runs the server through npx alone (a non-JS repo).
 */
export function hookCommand(root: string): string {
  if (fs.existsSync(path.join(root, "node_modules", "mindplan-mcp", "package.json"))) return HOOK_COMMAND;
  const version = ownVersion();
  return version ? `npx -y mindplan-mcp@${version} hook pre-tool-use` : HOOK_COMMAND;
}
const MINDPLAN_DIR = "mindplan";

const WRITE_MESSAGE =
  "mindplan/ is the MindPlan graph and is written only through the MindPlan MCP tools, never host Edit/Write. " +
  "Use patch_node_territory for a node's sections, patch_node_rules for a node's rules, patch_project_rules for the " +
  "project rules (nodes, edges, and claims have their own tools: create_node, link_nodes, set_implementation_files).";

/** The host tools that write a file; the hook answers only these. */
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

type HookEntry = { matcher?: unknown; hooks?: unknown };

function settingsFile(root: string): string {
  return path.join(root, ...HOOK_SETTINGS_PATH.split("/"));
}

/** A Claude Code project: it has a `.claude/` directory or a `CLAUDE.md`. */
export function isClaudeCodeProject(root: string): boolean {
  try {
    return fs.statSync(path.join(root, ".claude")).isDirectory() || fs.existsSync(path.join(root, "CLAUDE.md"));
  } catch {
    return fs.existsSync(path.join(root, "CLAUDE.md"));
  }
}

function readSettings(root: string): Record<string, unknown> | null {
  const file = settingsFile(root);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8").replace(/^﻿/, "");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Blocked: ${HOOK_SETTINGS_PATH} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it, then install the hook again.`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Blocked: ${HOOK_SETTINGS_PATH} must hold a JSON object; fix it, then install the hook again.`);
  }
  return parsed as Record<string, unknown>;
}

function hasHook(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((e: HookEntry) =>
    Array.isArray(e?.hooks) &&
    e.hooks.some((h: { command?: unknown }) => typeof h?.command === "string" && HOOK_MARKER.test(h.command))
  );
}

/** Whether `.claude/settings.json` already carries the PreToolUse hook. Unreadable settings: not installed. */
export function hookInstalled(root: string): boolean {
  try {
    const settings = readSettings(root);
    const hooks = settings?.hooks as Record<string, unknown> | undefined;
    return hasHook(hooks?.PreToolUse);
  } catch {
    return false;
  }
}

/**
 * Merge the PreToolUse hook into `.claude/settings.json` (created when missing). Every other key,
 * hook, and entry is kept; an installed hook is left as is. `changed` is true when the file was written.
 */
export function installHook(root: string): { path: string; changed: boolean } {
  const settings = readSettings(root) ?? {};
  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && (typeof hooksValue !== "object" || hooksValue === null || Array.isArray(hooksValue))) {
    throw new Error(`Blocked: ${HOOK_SETTINGS_PATH} "hooks" must be an object; fix it, then install the hook again.`);
  }
  const hooks = (hooksValue ?? {}) as Record<string, unknown>;
  const pre = hooks.PreToolUse;
  if (pre !== undefined && !Array.isArray(pre)) {
    throw new Error(`Blocked: ${HOOK_SETTINGS_PATH} "hooks.PreToolUse" must be an array; fix it, then install the hook again.`);
  }
  if (hasHook(pre)) return { path: HOOK_SETTINGS_PATH, changed: false };
  const entries = [...((pre ?? []) as HookEntry[])];
  entries.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: hookCommand(root) }] });
  const next = { ...settings, hooks: { ...hooks, PreToolUse: entries } };
  const file = settingsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { path: HOOK_SETTINGS_PATH, changed: true };
}

/**
 * The `hook` field of setup_project / upgrade_project and the files it wrote. With `install`: the
 * hook is installed. Without: `{ installed: true, path }` when it is, an offer in a Claude Code
 * project that lacks it, else nothing.
 */
export function hookReply(
  root: string,
  install: boolean | undefined
): { hook?: Record<string, unknown>; changed_files: string[] } {
  if (install) {
    const result = installHook(root);
    return { hook: { installed: true, path: result.path }, changed_files: result.changed ? [result.path] : [] };
  }
  if (hookInstalled(root)) return { hook: { installed: true, path: HOOK_SETTINGS_PATH }, changed_files: [] };
  if (!isClaudeCodeProject(root)) return { changed_files: [] };
  return {
    hook: {
      installed: false,
      offer:
        "Call again with install_hook: true to install a Claude Code PreToolUse hook in .claude/settings.json that denies host " +
        "Edit/Write on mindplan/** (reads stay free) and names the MindPlan tool to use instead.",
    },
    changed_files: [],
  };
}

// ---------------------------------------------------------------------------
// Deciding one hook call
// ---------------------------------------------------------------------------

const WIN = process.platform === "win32";

/** An absolute, `/`-separated, comparable path (lower-cased on Windows). */
function normalize(p: string, base: string): string {
  let s = p.replace(/\\/g, "/");
  // Git Bash style `/d/projects/x` on Windows.
  if (WIN && /^\/[a-zA-Z]\//.test(s)) s = `${s[1]}:${s.slice(2)}`;
  const abs = (WIN ? path.win32 : path.posix).resolve(base.replace(/\\/g, "/"), s).replace(/\\/g, "/").replace(/\/+$/, "");
  return WIN ? abs.toLowerCase() : abs;
}

function within(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}/`);
}

/** The nearest directory at or above `start` holding `mindplan/`; null when none does. */
function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(path.join(dir, MINDPLAN_DIR)).isDirectory()) return dir;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** True when an ancestor (or the path itself) is a `mindplan/` folder holding a graph marker file. */
function insideMarkedGraph(abs: string): boolean {
  const parts = abs.split("/");
  for (let i = parts.length; i > 0; i--) {
    if (parts[i - 1].toLowerCase() !== MINDPLAN_DIR) continue;
    const dir = parts.slice(0, i).join("/") || "/";
    // version.json marks a MindPlan graph; a project.md alone is too common to count.
    if (fs.existsSync(`${dir}/version.json`)) return true;
  }
  return false;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * The deny JSON for one PreToolUse call, or null to allow. `input` is the hook payload Claude Code
 * sends (`tool_name`, `tool_input`, `cwd`); anything malformed is allowed.
 */
export function preToolUseDecision(input: unknown, fallbackCwd: string = process.cwd()): string | null {
  try {
    if (!input || typeof input !== "object") return null;
    const { tool_name, tool_input, cwd } = input as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
    if (typeof tool_name !== "string" || !tool_input || typeof tool_input !== "object") return null;
    const ti = tool_input as Record<string, unknown>;
    const base = str(cwd) ?? fallbackCwd;
    const rootDir = findRoot(base) ?? base;
    const root = normalize(rootDir, rootDir);
    const graphDir = `${root}/${WIN ? MINDPLAN_DIR.toLowerCase() : MINDPLAN_DIR}`;
    const inGraph = (p: string) => {
      const abs = normalize(p, base);
      return within(abs, graphDir) || insideMarkedGraph(abs);
    };

    // Reads are free (Read, Grep, Glob); only a host write into the graph is denied. An install from
    // before reads were allowed still matches Read/Grep/Glob, and is answered with no output here.
    if (!WRITE_TOOLS.has(tool_name)) return null;
    const target = str(ti.file_path) ?? str(ti.notebook_path) ?? str(ti.path);
    if (target === undefined || !inGraph(target)) return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: WRITE_MESSAGE,
      },
    });
  } catch {
    return null;
  }
}
