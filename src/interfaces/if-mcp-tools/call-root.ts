/**
 * The `root` input every MCP tool takes: one server serves the main checkout and its git worktrees
 * (a subagent in `.claude/worktrees/agent-x` writes that worktree's mindplan/). This file resolves
 * the input and marks a result that came from another root; register.ts runs the call inside it.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

import { resolveProjectRoot } from "../../foundations/f-source-index/root-scope.js";
import { MINDPLAN_DIR } from "../../foundations/f-territory-store/store.js";

export const ROOT_INPUT = z
  .string()
  .optional()
  .describe(
    "Absolute path to a checkout or git worktree whose mindplan/ this call reads and writes. Default: the server's project root."
  );

/** Tools that answer for a root with no mindplan/ yet (they create or diagnose one). */
const ROOTLESS_TOOLS = new Set(["setup_project", "doctor"]);

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type CallRoot = { root: string | undefined; foreign: boolean };

function sameRoot(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * The root a call names, resolved. Blocked when it has no mindplan/ folder (except for the tools
 * that create or diagnose one). No `root` means the server's own root.
 */
export function resolveCallRoot(tool: string, root: string | undefined): CallRoot | { blocked: string } {
  if (root === undefined || root === "") return { root: undefined, foreign: false };
  const resolved = path.resolve(root);
  if (!ROOTLESS_TOOLS.has(tool) && !fs.existsSync(path.join(resolved, MINDPLAN_DIR))) {
    return { blocked: `Blocked: root "${root}" has no mindplan/ folder` };
  }
  return { root: resolved, foreign: !sameRoot(resolved, resolveProjectRoot()) };
}

function markRoot(result: ToolResult, root: string): ToolResult {
  if (result.isError || !result.structuredContent) return result;
  const structuredContent = { ...result.structuredContent, root };
  return { ...result, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

/** A result from another root than the server's says which root it read or wrote. */
export function withCallRoot(
  call: CallRoot,
  result: ToolResult | Promise<ToolResult>
): ToolResult | Promise<ToolResult> {
  if (!call.foreign || call.root === undefined) return result;
  const root = call.root;
  return result instanceof Promise ? result.then((r) => markRoot(r, root)) : markRoot(result, root);
}
