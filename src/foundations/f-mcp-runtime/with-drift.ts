/**
 * Attach the uncommitted-source drift report to successful MCP payloads.
 * Lives on the Assembler so if-mcp-tools can use it without importing i-check-integrity
 * (Interfaces may only import Interactions they expose).
 *
 * Lean by default: `drift` is `{ count, new_since_last_reply }`, the number of drifting paths and
 * only those this session has not been shown yet (a path listed once is not listed again while it
 * keeps drifting the same way). `get_drift` (or orient_for_work `sections: ["drift"]`) returns the
 * full list. `replies.legacy` restores the 0.22 shape: the report scoped to the touched node, in full.
 */

import { buildDriftReport } from "../../interactions/i-check-integrity/check.js";
import { fullDrift, leanDrift } from "../../interactions/i-check-integrity/drift.js";
import { loadProjectConfig, replySettings } from "../f-source-index/config.js";

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

function legacy(): boolean {
  try {
    return replySettings(loadProjectConfig()).legacy;
  } catch {
    return false;
  }
}

/**
 * The payload with `drift` attached. `full` attaches the full report (a caller that asked for it);
 * a payload that already carries `drift` keeps it.
 */
export function withDrift(payload: unknown, opts: { full?: boolean } = {}): unknown {
  let drift: unknown;
  if (opts.full) drift = fullDrift();
  else if (legacy()) drift = buildDriftReport({ nodeIds: touchedNodeIds(payload) });
  else drift = leanDrift();
  if (!drift) return payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), drift };
  }
  return { result: payload, drift };
}
