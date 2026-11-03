/**
 * The `root` input every MCP tool takes: one server serves the main checkout and its git worktrees
 * (a subagent in `.claude/worktrees/agent-x` writes that worktree's mindplan/). This file resolves
 * the input and marks a result that came from another root; register.ts runs the call inside it.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

import { resolveProjectRoot, rootKey } from "../../foundations/f-source-index/root-scope.js";
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
  return rootKey(a) === rootKey(b);
}

/**
 * The root a call names, resolved. Blocked unless it is an absolute path to an existing directory
 * (for every tool), and when it has no mindplan/ folder (except for the tools that create or
 * diagnose one). No `root` means the server's own root.
 */
export function resolveCallRoot(tool: string, root: string | undefined): CallRoot | { blocked: string } {
  if (root === undefined || root === "") return { root: undefined, foreign: false };
  if (!path.isAbsolute(root)) {
    return { blocked: `Blocked: root "${root}" must be an absolute path to a checkout or git worktree` };
  }
  const resolved = path.resolve(root);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return { blocked: `Blocked: root "${root}" is not an existing directory` };
  if (!ROOTLESS_TOOLS.has(tool) && !fs.existsSync(path.join(resolved, MINDPLAN_DIR))) {
    return { blocked: `Blocked: root "${root}" has no mindplan/ folder` };
  }
  return { root: resolved, foreign: !sameRoot(resolved, resolveProjectRoot()) };
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Names the root on a result from another root. An object payload gains `root` unless it already
 * has one (a payload's own `root` is never overwritten); an array or other JSON payload has no field
 * to carry it and stays untouched. Only a Blocked/error text or a plain string payload is suffixed.
 */
function markRoot(result: ToolResult, root: string): ToolResult {
  const suffixed = (): ToolResult => {
    const suffix = ` (root: ${root})`;
    return {
      ...result,
      content: result.content.map((c) => (c.type === "text" && !c.text.endsWith(suffix) ? { ...c, text: `${c.text}${suffix}` } : c)),
    };
  };
  if (result.isError) return suffixed();
  if (result.structuredContent) {
    if (Object.prototype.hasOwnProperty.call(result.structuredContent, "root")) return result;
    const structuredContent = { ...result.structuredContent, root };
    return { ...result, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  }
  if (result.content.some((c) => c.type === "text" && isJsonText(c.text))) return result;
  return suffixed();
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
