/**
 * Attach a non-empty uncommitted-source drift report to successful MCP payloads.
 * Lives on the Assembler so if-mcp-tools can use it without importing i-check-integrity
 * (Interfaces may only import Interactions they expose).
 *
 * The report is scoped to the node the payload is about, so one write stays small:
 * that node's files are listed, every other owner's files are only counted.
 */

import { buildDriftReport } from "../../interactions/i-check-integrity/check.js";

/** Node ids a payload is about: its own node_id, orient focus, link ends, or created node. */
function touchedNodeIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  add(p.node_id);
  add(p.focus);
  const linked = p.linked as Record<string, unknown> | undefined;
  add(linked?.source);
  add(linked?.target);
  const created = p.created as Record<string, unknown> | undefined;
  add(created?.id);
  return [...ids];
}

export function withDrift(payload: unknown): unknown {
  const drift = buildDriftReport({ nodeIds: touchedNodeIds(payload) });
  if (!drift) return payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), drift };
  }
  return { result: payload, drift };
}
