/**
 * Attach a non-empty uncommitted-source drift report to successful MCP payloads.
 * Lives on the Assembler so if-mcp-tools can use it without importing i-check-integrity
 * (Interfaces may only import Interactions they expose).
 */

import { buildDriftReport } from "../../interactions/i-check-integrity/check.js";

export function withDrift(payload: unknown): unknown {
  const drift = buildDriftReport();
  if (!drift) return payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), drift };
  }
  return { result: payload, drift };
}
