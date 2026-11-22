/**
 * The Claude Code SessionStart hook — owned by i-read-brief: puts the get_project payload into the
 * session's context at startup, after /clear, and after compaction (`mindplan-mcp hook session-start`,
 * wired by the Claude Code plugin). It does not record the rules as served: the hook runs in its own
 * process with no MCP session, so the server's write gate still needs get_project or get_rules
 * (decision d-hook-brief-not-gate).
 */

import * as fs from "fs";
import { mindplanRoot } from "../../foundations/f-territory-store/store.js";
import { projectPayload } from "./handlers.js";

/** Sources that start a context without the brief; resume and fork keep the one they had. */
const BRIEF_SOURCES = new Set(["startup", "clear", "compact"]);

export interface SessionStartOutput {
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
}

/** The get_project payload as Markdown, closed by the line that names the write gate. */
export function renderBrief(payload: Record<string, unknown>): string {
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string).trim() : "");
  const parts = ["# MindPlan brief (from the SessionStart hook)"];
  if (text("version")) parts.push(`## Graph version\n\n${text("version")}`);
  if (text("restart")) parts.push(`## Server restart\n\n${text("restart")}`);
  parts.push(`## Product description\n\n${text("description") || "_None yet._"}`);
  parts.push(
    `## Project rules (rules_version ${text("rules_version")}) — mandatory\n\n${text("rules") || "_None._"}`
  );
  parts.push(`## Check\n\n${text("check")}`);
  parts.push(text("playbook"));
  parts.push(
    "---\n\nThis brief is in context, but the MindPlan server has not served it to this session: " +
      `call get_project, or get_rules({ known_version: "${text("rules_version")}" }), once before the first MindPlan write.`
  );
  return parts.join("\n\n");
}

/**
 * The SessionStart answer for a hook payload, or null when the hook should print nothing
 * (another source, no mindplan/ under the root, malformed input, an unreadable brief).
 */
export function sessionStartContext(input: unknown): SessionStartOutput | null {
  if (!input || typeof input !== "object") return null;
  const source = (input as { source?: unknown }).source;
  if (typeof source !== "string" || !BRIEF_SOURCES.has(source)) return null;
  try {
    if (!fs.existsSync(mindplanRoot())) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: renderBrief(projectPayload()),
      },
    };
  } catch {
    return null;
  }
}
