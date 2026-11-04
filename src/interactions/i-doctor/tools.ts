/**
 * MCP tool definitions owned by i-doctor: name, when-to-call description, input schema, and
 * handler. if-mcp-tools mounts them with the shared envelope.
 */

import { defineTool, type ToolDef } from "../../foundations/f-tool-kit/tool.js";
import { doctor } from "./handlers.js";

/** The MCP tools i-doctor owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "doctor",
    {
      kind: "read",
      drift: false,
      gate: false,
      title: "Check the server's health",
      description:
        "Call when the server seems slow, attached to the wrong folder, or a graph tool fails in a way the message does not explain. " +
        "Returns { version, node, root, graph: { status, level, server_level }, load_ms_cached, cache_hit, load_error?, cache: { graph, search }, started_at, uptime_s }: " +
        "the server and Node versions, the project root it serves, the graph's state (setup, upgrade, server-behind, current), " +
        "how long a graph load takes through the graph cache and whether every node came from it (only a current graph is loaded, and never when the load would remove legacy files; otherwise load_error says why), and which derived caches exist. " +
        "Answers in every graph state.",
      inputSchema: {},
    },
    () => doctor()
  ),
];
