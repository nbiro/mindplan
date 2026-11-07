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
        "Returns the server and Node versions, the project root it serves, the graph's state (setup, upgrade, server-behind, current), graph-load time through the cache (load_error says why it did not load), and which derived caches exist. Answers in every graph state. " +
        "Details: get_spec({ topic: \"doctor\" }).",
      inputSchema: {},
    },
    () => doctor()
  ),
];
