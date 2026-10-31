/**
 * MCP tools Interface — mounts the tools each exposed action defines (its `tools.ts`) with
 * annotations derived from each tool's kind and the ok/guarded envelope. Does not own domain logic
 * or tool definitions.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { ToolDef, ToolKind } from "../../foundations/f-tool-kit/tool.js";
import { withDrift } from "../../foundations/f-mcp-runtime/with-drift.js";
import { TOOLS as ORIENT_TOOLS } from "../../interactions/i-orient-plan/tools.js";
import { TOOLS as IMPACT_TOOLS } from "../../interactions/i-assess-impact/tools.js";
import { TOOLS as BRIEF_READ_TOOLS } from "../../interactions/i-read-brief/tools.js";
import { TOOLS as BROWSE_TOOLS } from "../../interactions/i-browse-graph/tools.js";
import { TOOLS as STATUS_TOOLS } from "../../interactions/i-change-status/tools.js";
import { TOOLS as SHAPE_TOOLS } from "../../interactions/i-shape-graph/tools.js";
import { TOOLS as TERRITORY_TOOLS } from "../../interactions/i-edit-territory/tools.js";
import { TOOLS as REVISE_TOOLS } from "../../interactions/i-revise-node/tools.js";
import { TOOLS as CLAIM_TOOLS } from "../../interactions/i-claim-files/tools.js";
import { TOOLS as DECISION_TOOLS } from "../../interactions/i-record-decision/tools.js";
import { TOOLS as BRIEF_EDIT_TOOLS } from "../../interactions/i-edit-brief/tools.js";
import { TOOLS as CHECK_TOOLS } from "../../interactions/i-check-integrity/tools.js";
import { TOOLS as EXPORT_TOOLS } from "../../interactions/i-export-map/tools.js";
import {
  drainRemovedLegacyFiles,
  restoreRemovedLegacyFiles,
} from "../../foundations/f-territory-store/store.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Success envelope: compact JSON text (pretty-printing cost about a third more tokens on every
 * result) plus a `structuredContent` mirror for object payloads so a client can read the result
 * without parsing. String payloads stay text-only. No `outputSchema` is declared.
 */
function ok(payload: unknown): ToolResult {
  if (typeof payload === "string") return { content: [{ type: "text", text: payload }] };
  const text = JSON.stringify(payload);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { content: [{ type: "text", text }], structuredContent: payload as Record<string, unknown> };
  }
  return { content: [{ type: "text", text }] };
}

function withRemovedLegacyFiles(payload: unknown): unknown {
  const removed = drainRemovedLegacyFiles();
  if (removed.length === 0) return payload;
  const froms = removed.map((entry) => entry.from);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = { ...(payload as Record<string, unknown>) };
    if (Array.isArray(obj.changed_files)) {
      obj.changed_files = [...new Set([...(obj.changed_files as string[]), ...froms])];
    }
    obj.removed_legacy_files = froms;
    return obj;
  }
  return { result: payload, removed_legacy_files: froms };
}

/** Every tool acts on the local mindplan/ tree and the repo, never an external system. */
const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

/** Mounts one tool: annotations from its kind, handler wrapped in the guarded envelope. */
function mount(server: McpServer, def: ToolDef): void {
  const { kind, drift, ...rest } = def.config;
  // The definition erased its handler's argument type; the SDK validates the input schema before
  // the call, so the handler receives exactly what its schema describes.
  const callback = guarded(def.handler as (args: unknown) => unknown, { write: kind !== "read", drift });
  server.registerTool(def.name, { ...rest, annotations: ANNOTATIONS[kind] }, callback as unknown as ToolCallback<typeof rest.inputSchema>);
}

/**
 * Wrap a handler with the §5.1 error contract. Successful results carry `drift`
 * (scoped to the touched node) unless `drift: false` — get_project and get_rules run before
 * every action, so drift rides on orient_for_work and the read tools instead. A `write` tool
 * carries it only with `verbose: true`, so a default write stays small.
 */
function guarded<A>(
  handler: (args: A) => unknown,
  options: { drift?: boolean; write?: boolean } = {}
): (args: A) => ToolResult | Promise<ToolResult> {
  const fail = (err: unknown): ToolResult => {
    const removed = drainRemovedLegacyFiles();
    const message = err instanceof Error ? err.message : String(err);
    const note =
      removed.length === 0
        ? ""
        : `\n${removed.map((entry) => `Removed ${entry.from} (kept ${entry.to})`).join("\n")}`;
    return { content: [{ type: "text", text: `${message}${note}` }], isError: true };
  };
  return (args: A) => {
    const verbose = (args as { verbose?: boolean } | undefined)?.verbose === true;
    const attachDrift = options.drift !== false && (!options.write || verbose);
    const succeed = (result: unknown): ToolResult => {
      const payload = withRemovedLegacyFiles(result);
      return ok(attachDrift ? withDrift(payload) : payload);
    };
    try {
      const result = handler(args);
      // Search handlers are async (the query embedding); every other handler returns its payload.
      // They load the graph before their first await, so the legacy files that load removed are
      // taken now: another call that runs while this one waits keeps its own.
      if (result instanceof Promise) {
        const removedBefore = drainRemovedLegacyFiles();
        const withEarlier = (value: unknown): ToolResult => {
          restoreRemovedLegacyFiles(removedBefore);
          return succeed(value);
        };
        return result.then(withEarlier).catch((err: unknown) => {
          restoreRemovedLegacyFiles(removedBefore);
          return fail(err);
        });
      }
      return succeed(result);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Tool order in tools/list: unchanged from when one file defined every tool. */
const TOOL_ORDER = [
  "run_check",
  "get_mindplan_graph",
  "export_mindplan_view",
  "find_related_nodes",
  "list_areas",
  "get_node_implementation",
  "get_node_context",
  "orient_for_work",
  "get_project",
  "get_spec",
  "get_rules",
  "patch_node_territory",
  "patch_node_rules",
  "record_decision",
  "list_decisions",
  "patch_project_description",
  "patch_project_rules",
  "patch_config",
  "put_attachment",
  "remove_attachment",
  "set_implementation_files",
  "set_test_files",
  "create_node",
  "link_nodes",
  "open_next",
  "discard_next",
  "get_blast_radius",
  "unlink_nodes",
  "update_node_status",
  "force_unship",
];

/** Register every MindPlan MCP tool onto the given server. */
export function registerMindPlanTools(server: McpServer): void {
  const defs = [
    ...ORIENT_TOOLS,
    ...IMPACT_TOOLS,
    ...BRIEF_READ_TOOLS,
    ...BROWSE_TOOLS,
    ...STATUS_TOOLS,
    ...SHAPE_TOOLS,
    ...TERRITORY_TOOLS,
    ...REVISE_TOOLS,
    ...CLAIM_TOOLS,
    ...DECISION_TOOLS,
    ...BRIEF_EDIT_TOOLS,
    ...CHECK_TOOLS,
    ...EXPORT_TOOLS,
  ];
  const byName = new Map(defs.map((d) => [d.name, d]));
  if (byName.size !== defs.length || byName.size !== TOOL_ORDER.length) {
    throw new Error("Blocked: two actions define the same MCP tool, or a tool is missing from TOOL_ORDER.");
  }
  for (const name of TOOL_ORDER) {
    const def = byName.get(name);
    if (!def) throw new Error(`Blocked: no action defines the MCP tool "${name}".`);
    mount(server, def);
  }
}
