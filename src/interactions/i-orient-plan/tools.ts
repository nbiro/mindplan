/**
 * MCP tool definitions owned by i-orient-plan: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
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


/** The MCP tools i-orient-plan owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "find_related_nodes",
    {
      kind: "read",
      title: "Find related nodes",
      description:
        "Call before creating a node, to reuse one that already exists. " +
        "Ranks nodes for a text query (keyword plus semantic search; an exact id ranks first) and returns the focus node plus its 1-hop " +
        "linked neighborhood (summaries only). Prefer this over get_mindplan_graph for orientation. " +
        "Provide query and/or node_id. Use get_node_context for full territory; get_blast_radius for transitive dependents.",
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
        "Call before editing a file, to see who owns it, or when you need a node's claimed files. " +
        "Returns declared owned files for a node (`implements`), or looks up the owner of a path. " +
        "Interaction/Interface/Foundation: { node_id, files: [{path,exists}], next_files? }. " +
        "Journey/Bug: tagged files of members/affects targets. Pass path for path→owner lookup.",
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
        "Call when you are about to read or edit one node's territory. " +
        "Returns authoritative record (graph slice), editable body (without the ## Rules and ## Decisions sections), the node's own rules, " +
        "its own decisions (active ones; an empty list may still have superseded history, and a live decision replaced on the open next slot is hidden too: pass include_superseded to see the trail, as in list_decisions), " +
        "inherited_decisions ({ count, nodes }, plus entries with include_inherited_decisions), resolved_rules (every node rule that reaches it: it counts as orienting on the node), attachment paths, and filenames. " +
        "Includes next slot when an evolution is in progress (`next.record` + `next.body` + `next.decisions`). " +
        "Both slots come back unless slot names one; section returns one section of each body.",
      inputSchema: {
        node_id: NODE_ID.describe("The id of the node whose territory to read."),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Also return superseded decisions (each names superseded_by). Default false."),
        include_inherited_decisions: INCLUDE_INHERITED_DECISIONS,
        slot: SLOT_READ,
        section: SECTION_READ,
      },
    },
    ({ node_id, include_superseded, include_inherited_decisions, slot, section }) =>
      getNodeContext({ node_id, include_superseded, include_inherited_decisions, slot, section })
  ),
  defineTool(
    "orient_for_work",
    {
      kind: "read",
      title: "Orient for work",
      description:
        "Call before each action, after get_rules. Not only at session start. Summary first: " +
        "with only a query it returns ranked rows ({ id, type, state, title, description, area?, score }, default 8, no body, rules, or decisions); " +
        "pick one and call again with node_id, or pass change alone to orient on every member of a change in one reply (open revisions, planned sources, and the nodes holding a decision recorded under it as kind \"decision\"; each member's rules_from, each rule source's text once, the members holding decisions), which clears the write gate for all of them. When the top row is a clear winner (its exact id, the only match, or twice the next score) the full node comes back with the rows and auto_focus: true. " +
        "With node_id it returns the full node at depth: record and body (get_node_context), owned files, " +
        "the body being the active slot's (the open next while a revision is open; slot picks one, section cuts it to one section), " +
        "and at full the 1-hop neighborhood and get_blast_radius for a Foundation, Interaction, or Interface, plus stability ({ fan_in, rate, median_rate, revisions?, split_at?, split_into?, hotspot?, fan_out? }): how many nodes depend on it directly and how often it shipped lately against the project's median; check it before choosing open_next. A pre-ship node's fan_out ({ count, changes }) names the other unshipped changes it depends on; several mean it may need to know every feature of a kind. " +
        "A full reply carries shape while the node has a transition ahead: the required sections of its active slot, each present, missing, or stub, and the gates that check them. " +
        "Writes that act on a node (set_implementation_files, set_test_files, update_node_status, patch_node_territory, patch_node_rules, open_next, record_decision, attachments, force_unship, link_nodes / unlink_nodes on the source) " +
        "are Blocked: Orientation until that node had a full reply in this session (or get_node_context), and again after the rules that reach it changed; create_node is never blocked. " +
        "Also returns a rules block: the node rules that apply to the focus (its own, its Journey's, its Foundations', " +
        "or an affected node's for a Bug), each labeled with the node it came from and tagged with a version; pass known_rules_versions ({ node_id: version }) only for entries whose text you still hold, to leave that text out (they come back with unchanged: true). Those rules are mandatory. " +
        "And a decisions block, at every depth: the focus node's own recorded design decisions (a Bug: those of the nodes it affects), the reply's only copy of them; read them before reshaping that design. " +
        "inherited_decisions ({ count, nodes }) names the Journeys and Foundations whose decisions also apply; include_inherited_decisions adds them (whole at distance 1, one line beyond). Superseded ones only with include_superseded. " +
        "Blast radius groups affected_files by owner and omits cancelled/deprecated by default. " +
        "Interaction focus also includes reachability (exposing Interfaces, containing Journeys, leads_to downstream).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text query to rank nodes. Required if node_id and change are omitted."),
        node_id: NODE_ID.optional().describe("Force focus to this node when present."),
        change: CHANGE_ID.optional().describe(
          "Orient on every member of this change (open revisions, planned sources, and nodes holding a decision under it) in one reply; pass it without query or node_id."
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
            "rules: the node's rules and record only. body: also its body. full (default): also the neighborhood and blast radius."
          ),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Also return superseded decisions in the decisions block (each names superseded_by). Default false."),
        include_inherited_decisions: INCLUDE_INHERITED_DECISIONS,
        known_rules_versions: z
          .record(z.string(), z.string())
          .optional()
          .describe("Node id → rules version you already hold (from an earlier rules block); those entries come back without their text, with unchanged: true."),
        area: AREA,
        slot: SLOT_READ,
        section: SECTION_READ,
      },
    },
    ({ query, node_id, change, type, limit, depth, include_superseded, include_inherited_decisions, known_rules_versions, area, slot, section }) =>
      orientForWork({
        query,
        node_id,
        change,
        type,
        limit,
        depth,
        include_superseded,
        include_inherited_decisions,
        known_rules_versions,
        area,
        slot,
        section,
      })
  ),
];
