/**
 * MCP tool definitions owned by i-find-text: find_in_node and search_graph (names, when-to-call
 * descriptions, input schemas, and handlers). if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import { NODE_TYPES } from "../../foundations/f-domain-model/types.js";
import { defineTool, type ToolDef, NODE_ID, CHANGE_ARG } from "../../foundations/f-tool-kit/tool.js";
import {
  DEFAULT_FIND_IN_NODE_LIMIT,
  DEFAULT_SEARCH_GRAPH_LIMIT,
  FIND_SLOTS,
  MAX_FIND_IN_NODE_LIMIT,
  MAX_SEARCH_GRAPH_LIMIT,
  findInNode,
  searchGraph,
} from "./handlers.js";

const TEXT = z
  .string()
  .describe("The text to find, matched line by line: a case-insensitive substring unless case_sensitive or regex.");

const REGEX = z.boolean().optional().describe("Treat text as a JavaScript regular expression (Blocked when invalid). Default false.");

const CASE_SENSITIVE = z.boolean().optional().describe("Match case exactly. Default false.");

/** The MCP tools i-find-text owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "find_in_node",
    {
      kind: "read",
      title: "Find in node",
      description:
        "Call when you need the exact text of a node for patch_node_territory's replace edit. Searches the node's body as replace.find sees it (live without ## Rules / ## Decisions, plus the open revision) and returns each matching line with its slot, line, section, and a snippet of whole lines that occurs exactly once in that slot: pass it as replace.find (with the match's slot and change). Details: get_spec({ topic: \"find_in_node\" }).",
      inputSchema: {
        node_id: NODE_ID.describe("The node whose body to search."),
        text: TEXT,
        slot: z
          .enum(FIND_SLOTS)
          .optional()
          .describe(
            "current (live) or next (an open revision; Blocked when none is open). Default: live, plus the open revision change names or the only open one."
          ),
        change: CHANGE_ARG,
        regex: REGEX,
        case_sensitive: CASE_SENSITIVE,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIND_IN_NODE_LIMIT)
          .optional()
          .describe(`Max matches (default ${DEFAULT_FIND_IN_NODE_LIMIT}, max ${MAX_FIND_IN_NODE_LIMIT}).`),
      },
    },
    ({ node_id, text, slot, change, regex, case_sensitive, limit }) =>
      findInNode({ node_id, text, slot, change, regex, case_sensitive, limit })
  ),
  defineTool(
    "search_graph",
    {
      kind: "read",
      title: "Search graph",
      description:
        "Call when you need to know which nodes' text mentions something (a path, a term, a phrase) instead of grepping mindplan/. Searches the body of every non-retired node (live and each open revision) and returns matching lines { node_id, type, slot, change?, line, section, match }. find_in_node then gives a replace-ready snippet. Details: get_spec({ topic: \"search_graph\" }).",
      inputSchema: {
        text: TEXT,
        regex: REGEX,
        case_sensitive: CASE_SENSITIVE,
        type: z.enum(NODE_TYPES).optional().describe("Only search nodes of this type."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_GRAPH_LIMIT)
          .optional()
          .describe(`Max matching lines (default ${DEFAULT_SEARCH_GRAPH_LIMIT}, max ${MAX_SEARCH_GRAPH_LIMIT}).`),
      },
    },
    ({ text, regex, case_sensitive, type, limit }) => searchGraph({ text, regex, case_sensitive, type, limit })
  ),
];
