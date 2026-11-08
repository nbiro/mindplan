/**
 * MCP tool definitions owned by i-page-replies: next_page, which returns the rest of a list a reply
 * cut to the reply budget. if-mcp-tools mounts it with the shared envelope.
 */

import { z } from "zod";
import { defineTool, type ToolDef } from "../../foundations/f-tool-kit/tool.js";
import { nextPageHandler } from "./handlers.js";

/** The MCP tools i-page-replies owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "next_page",
    {
      kind: "read",
      drift: false,
      budget: false,
      title: "Next page of a cut reply",
      description:
        "Call when a reply carries truncated: [{ path, shown, total, cursor }] and you need more of that list. " +
        "Returns { path, from, items, total, next_cursor? }: the next items that fit the reply budget; pass next_cursor for more. " +
        "Cursors live for this session. Details: get_spec({ topic: \"next_page\" }).",
      inputSchema: {
        cursor: z.string().min(1).describe("A cursor from a reply's truncated list, or a next_cursor."),
      },
    },
    ({ cursor }) => nextPageHandler({ cursor })
  ),
];
