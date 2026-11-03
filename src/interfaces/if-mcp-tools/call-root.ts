/**
 * The `root` input every MCP tool takes: one server serves the main checkout and its git worktrees
 * (a subagent in `.claude/worktrees/agent-x` writes that worktree's mindplan/). This file resolves
 * the input and marks a payload that came from another root; register.ts runs the call inside it
 * and marks each result where it shapes it.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

import { MINDPLAN_DIR } from "../../foundations/f-territory-store/store.js";

export const ROOT_INPUT = z
  .string()
  .optional()
  .describe(
    "Absolute path to a checkout or git worktree whose mindplan/ this call reads and writes. Default: the server's project root."
  );

/** Tools that answer for a root with no mindplan/ yet (they create or diagnose one). */
const ROOTLESS_TOOLS = new Set(["setup_project", "doctor"]);

export type CallRoot = { root: string | undefined };

/**
 * The root a call names, resolved. Blocked unless it is an absolute path to an existing directory
 * (for every tool), and when it has no mindplan/ folder (except for the tools that create or
 * diagnose one). No `root` means the server's own root.
 */
export function resolveCallRoot(tool: string, root: string | undefined): CallRoot | { blocked: string } {
  if (root === undefined || root === "") return { root: undefined };
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
  return { root: resolved };
}

/**
 * Names the root on a payload from another root (`root`, see `foreignRoot`): an object payload
 * gains `root` unless it already has one (a payload's own `root` is never overwritten); a plain
 * string is suffixed ` (root: …)`; an array or any other payload has no field to carry it and
 * stays untouched.
 */
export function markRoot(payload: unknown, root: string | undefined): unknown {
  if (root === undefined) return payload;
  if (typeof payload === "string") return markRootText(payload, root);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (Object.prototype.hasOwnProperty.call(payload, "root")) return payload;
  return { ...(payload as Record<string, unknown>), root };
}

/** A Blocked/error or plain text from another root, suffixed ` (root: …)` once. */
export function markRootText(text: string, root: string | undefined): string {
  if (root === undefined) return text;
  const suffix = ` (root: ${root})`;
  return text.endsWith(suffix) ? text : `${text}${suffix}`;
}
