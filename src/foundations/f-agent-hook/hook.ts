/**
 * Claude Code PreToolUse hook that keeps agents' host file tools off `mindplan/**` — owned by
 * Foundation f-agent-hook. Installs the hook into `.claude/settings.json` (setup_project and
 * upgrade_project with `install_hook: true`), reports whether it is installed, and decides one hook
 * call for `mindplan-mcp hook pre-tool-use`. Never throws on hook input.
 */

import * as fs from "fs";
import * as path from "path";

/** The command the hook runs; `--no-install` never downloads a package from a hook. */
export const HOOK_COMMAND = "npx --no-install mindplan-mcp hook pre-tool-use";
/** The host file tools the hook watches. */
export const HOOK_MATCHER = "Read|Edit|MultiEdit|Write|Grep|Glob|NotebookEdit";
/** Project-relative settings file the hook goes into. */
export const HOOK_SETTINGS_PATH = ".claude/settings.json";

const HOOK_MARKER = "mindplan-mcp hook pre-tool-use";
const MINDPLAN_DIR = "mindplan";

const READ_MESSAGE =
  "mindplan/ is the MindPlan graph: read it through the MindPlan MCP tools, not host Read/Grep/Glob. " +
  "Use get_node_context for one node, find_in_node to search inside a node, search_graph to search the graph, " +
  "get_mindplan_graph for the whole graph.";
const WRITE_MESSAGE =
  "mindplan/ is the MindPlan graph and is written only through the MindPlan MCP tools, never host Edit/Write. " +
  "Use patch_node_territory for a node's sections, patch_node_rules for a node's rules, patch_project_rules for the " +
  "project rules (nodes, edges, and claims have their own tools: create_node, link_nodes, set_implementation_files).";

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
    e.hooks.some((h: { command?: unknown }) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER))
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
  entries.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: HOOK_COMMAND }] });
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
        "Read/Edit/Write/Grep/Glob on mindplan/** and names the MindPlan tool to use instead.",
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
    if (["version.json", "project.md"].some((f) => fs.existsSync(`${dir}/${f}`))) return true;
  }
  return false;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** The literal directory prefix of a glob (`a/b/**` → `a/b`). */
function globBase(glob: string): string {
  const s = glob.replace(/\\/g, "/");
  const first = s.search(/[*?[{]/);
  const literal = first === -1 ? s : s.slice(0, first);
  return first === -1 ? literal : literal.slice(0, literal.lastIndexOf("/") + 1);
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

    let hit = false;
    let write = false;
    switch (tool_name) {
      case "Read":
      case "Edit":
      case "MultiEdit":
      case "Write":
      case "NotebookEdit": {
        const target = str(ti.file_path) ?? str(ti.notebook_path) ?? str(ti.path);
        hit = target !== undefined && inGraph(target);
        write = tool_name !== "Read";
        break;
      }
      case "Grep":
      case "Glob": {
        // The folder searched, then the folder the glob's literal prefix names inside it.
        const dir = normalize(str(ti.path) ?? base, base);
        const glob = tool_name === "Grep" ? str(ti.glob) : str(ti.pattern);
        hit = inGraph(dir);
        if (!hit && glob) {
          const prefix = globBase(glob.replace(/^(\.\/)+/, ""));
          hit = prefix !== "" && inGraph(normalize(prefix, dir));
        }
        break;
      }
      default:
        return null;
    }
    if (!hit) return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: write ? WRITE_MESSAGE : READ_MESSAGE,
      },
    });
  } catch {
    return null;
  }
}
