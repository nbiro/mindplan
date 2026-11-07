/**
 * MCP tool definitions owned by i-orient-plan: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import { ORIENT_SECTIONS } from "./sections.js";
import {
  NODE_TYPES,
} from "../../foundations/f-domain-model/types.js";
import {
  DEFAULT_FIND_LIMIT,
  MAX_FIND_LIMIT,
} from "../../foundations/f-graph-search/search.js";
import {
  defineTool,
  type ToolDef,
  NODE_ID,
  CHANGE_ID,
  CHANGE_ARG,
  AREA,
  INCLUDE_INHERITED_DECISIONS,
  SECTION_READ,
} from "../../foundations/f-tool-kit/tool.js";
import {
  CONTEXT_SLOTS,
  ORIENT_DEPTHS,
  findRelatedNodesHandler,
  getNodeContext,
  getNodeImplementationHandler,
  orientForWork,
} from "./handlers.js";

/** The territory slot a node read returns (orient_for_work and get_node_context). */
const SLOT_READ = z
  .enum(CONTEXT_SLOTS)
  .optional()
  .describe(
    "Return only this slot's body (get_node_context: and its decisions): current (live) or next (the open revision; Blocked when none is open)."
  );


/** Return every reaching rule's text, not only the node's own and those at distance 1. */
const INCLUDE_INHERITED_RULES = z
  .boolean()
  .optional()
  .describe(
    "Also return the text of rules from sources past distance 1 (a Foundation's Foundations, a Capability's further links). Default false: those come back as one line { node_id, distance, version, first, count }."
  );

/** The MCP tools i-orient-plan owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "find_related_nodes",
    {
      kind: "read",
      title: "Find related nodes",
      description:
        "Call before creating a node, to reuse one that already exists. Ranks nodes for a text query (keyword plus semantic; an exact id ranks first) and returns the focus node plus its 1-hop neighborhood as summaries. Pass query and/or node_id; get_node_context reads full territory. Details: get_spec({ topic: \"find_related_nodes\" }).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text query to rank nodes (keyword and semantic: id, title, description, area, headings, paths). Required if node_id omitted."
          ),
        node_id: NODE_ID.optional().describe(
          "Force focus to this node when present. Required if query is empty."
        ),
        type: z
          .enum(NODE_TYPES)
          .optional()
          .describe("Optional type filter applied before ranking."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIND_LIMIT)
          .optional()
          .describe(`Max ranked matches to return (default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT}).`),
        area: AREA,
      },
    },
    ({ query, node_id, type, limit, area }) =>
      findRelatedNodesHandler({ query, node_id, type, limit, area })
  ),
  defineTool(
    "get_node_implementation",
    {
      kind: "read",
      title: "Get node implementation",
      description:
        "Call before editing a file, to see which node owns it, or to list a node's claimed files. Pass node_id for its implements files ({ path, exists }, next_files?), or path for the owner of that path. Details: get_spec({ topic: \"get_node_implementation\" }).",
      inputSchema: {
        node_id: NODE_ID.optional().describe(
          "Node id whose implements list to read. Required unless path is set."
        ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe("Repo-relative path to look up owner for."),
      },
    },
    ({ node_id, path }) => getNodeImplementationHandler({ node_id, path })
  ),
  defineTool(
    "get_node_context",
    {
      kind: "read",
      title: "Get node context",
      description:
        "Call when you are about to read or edit one node's territory. Returns its record, body (without ## Rules / ## Decisions), own rules, active decisions, resolved_rules (sources past distance 1 as one line unless include_inherited_rules), and attachments, plus the next slot while a revision is open; it counts as orienting on the node. With several open revisions pass change to read one (otherwise only live comes back). slot and section narrow the reply; include_superseded and include_inherited_decisions widen the decisions. Details: get_spec({ topic: \"get_node_context\" }).",
      inputSchema: {
        node_id: NODE_ID.describe("The id of the node whose territory to read."),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Also return superseded decisions (each names superseded_by). Default false."),
        include_inherited_decisions: INCLUDE_INHERITED_DECISIONS,
        include_inherited_rules: INCLUDE_INHERITED_RULES,
        slot: SLOT_READ,
        section: SECTION_READ,
        change: CHANGE_ARG,
      },
    },
    ({ node_id, include_superseded, include_inherited_decisions, include_inherited_rules, slot, section, change }) =>
      getNodeContext({ node_id, include_superseded, include_inherited_decisions, include_inherited_rules, slot, section, change })
  ),
  defineTool(
    "orient_for_work",
    {
      kind: "read",
      title: "Orient for work",
      description:
        "Call before working on a node: a write on a node is Blocked: Orientation until that node had a full reply in this session, and again after the rules reaching it changed (create_node never is). With query alone it returns ranked rows (a clear winner comes back in full with auto_focus: true); with node_id, the node: record, active-slot body, owned files, shape, its mandatory node rules (its own and those at distance 1 in full, further sources as one line), and its decisions; depth full adds the neighborhood, blast radius, and stability. change alone orients on every member of a change and clears the gate for all of them; with node_id it reads that node's revision. known_rules_versions leaves out rule text you still hold; a reply without the rules section does not clear the gate. Replies that orient carry project_rules when the project rules have not reached the session or changed. Details: get_spec({ topic: \"orient_for_work\" }).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text query to rank nodes. Required if node_id and change are omitted."),
        node_id: NODE_ID.optional().describe("Force focus to this node when present."),
        change: CHANGE_ID.optional().describe(
          "Alone: orient on every member of this change (each node's revision of it, planned sources, and nodes holding a decision under it) in one reply. With node_id: read that node's open revision of this change."
        ),
        type: z.enum(NODE_TYPES).optional().describe("Optional type filter before ranking."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIND_LIMIT)
          .optional()
          .describe(`Max ranked rows (default 8 for a query alone, ${DEFAULT_FIND_LIMIT} with node_id).`),
        depth: z
          .enum(ORIENT_DEPTHS)
          .optional()
          .describe(
            "rules: the node's rules and record only. body (default): also its body and files. full: also the neighborhood, blast radius, and stability."
          ),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Also return superseded decisions in the decisions block (each names superseded_by). Default false."),
        include_inherited_decisions: INCLUDE_INHERITED_DECISIONS,
        include_inherited_rules: INCLUDE_INHERITED_RULES,
        known_rules_versions: z
          .record(z.string(), z.string())
          .optional()
          .describe("Node id → rules version you already hold (from an earlier rules block); those entries come back without their text, with unchanged: true."),
        area: AREA,
        slot: SLOT_READ,
        section: SECTION_READ,
        sections: z
          .array(z.string())
          .optional()
          .describe(
            `Return only these parts (plus focus and query): ${ORIENT_SECTIONS.join(", ")}. A reply without "rules" does not clear the write gate. Default: every part depth returns.`
          ),
      },
    },
    ({ query, node_id, change, type, limit, depth, include_superseded, include_inherited_decisions, include_inherited_rules, known_rules_versions, area, slot, section, sections }) =>
      orientForWork({
        query,
        node_id,
        change,
        type,
        limit,
        depth,
        include_superseded,
        include_inherited_decisions,
        include_inherited_rules,
        known_rules_versions,
        area,
        slot,
        section,
        sections,
      })
  ),
];
