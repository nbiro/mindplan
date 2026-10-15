/**
 * MCP tools Interface — registers orient, steer, and export handlers with schemas
 * and the ok/guarded envelope. Does not own domain logic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { EDGE_TYPES, NODE_TYPES } from "../../foundations/f-domain-model/types.js";
import { DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT } from "../../foundations/f-graph-search/search.js";
import { VIEW_FORMATS } from "../../foundations/f-view-projection/view.js";
import {
  findRelatedNodesHandler,
  getBlastRadius,
  getMindPlanGraph,
  getNodeContext,
  getNodeImplementationHandler,
  getProject,
  getRules,
  orientForWork,
} from "../../interactions/i-orient-plan/handlers.js";
import { withDrift } from "../../foundations/f-mcp-runtime/with-drift.js";
import {
  createNode,
  discardNext,
  forceUnship,
  linkNodes,
  openNext,
  patchConfig,
  patchNodeTerritory,
  patchProjectDescription,
  patchProjectRules,
  putAttachment,
  removeAttachment,
  setImplementationFiles,
  unlinkNodes,
  updateNodeStatus,
} from "../../interactions/i-steer-plan/handlers.js";
import { exportMindPlanViewHandler } from "../../interactions/i-export-map/handlers.js";
import { FOUNDATION_ROLES } from "../../foundations/f-domain-model/types.js";
import { drainRemovedLegacyFiles } from "../../foundations/f-territory-store/store.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
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

/**
 * Wrap a handler with the §5.1 error contract. Successful results carry `drift`
 * unless `drift: false` — get_project and get_rules run before every action, so
 * drift rides on orient_for_work and the write tools instead.
 */
function guarded<A>(
  handler: (args: A) => unknown,
  options: { drift?: boolean } = {}
): (args: A) => ToolResult {
  const attachDrift = options.drift !== false;
  return (args: A) => {
    try {
      const payload = withRemovedLegacyFiles(handler(args));
      return ok(attachDrift ? withDrift(payload) : payload);
    } catch (err) {
      const removed = drainRemovedLegacyFiles();
      const message = err instanceof Error ? err.message : String(err);
      const note =
        removed.length === 0
          ? ""
          : `\n${removed.map((entry) => `Removed ${entry.from} (kept ${entry.to})`).join("\n")}`;
      return { content: [{ type: "text", text: `${message}${note}` }], isError: true };
    }
  };
}

const NODE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "ids must be kebab_case/slug style: lowercase letters, digits, - and _");

/** Register every MindPlan MCP tool onto the given server. */
export function registerMindPlanTools(server: McpServer): void {
  server.registerTool(
    "get_mindplan_graph",
    {
      title: "Get MindPlan graph",
      description:
        "Call when you need every node and edge. Prefer orient_for_work for one piece of work. " +
        "Returns the full MindPlan graph — nodes and edges assembled from <id>.mdx frontmatter.",
      inputSchema: {},
    },
    guarded(() => getMindPlanGraph())
  );

  server.registerTool(
    "export_mindplan_view",
    {
      title: "Export MindPlan view",
      description:
        "Call when a human wants a map for a PR or a doc. " +
        "Exports a deterministic typed-DAG projection as Mermaid or DOT. " +
        "Omit focus for the full filtered map; pass focus for that node plus its 1-hop neighborhood. " +
        "By default hides deprecated/cancelled nodes and closed bugs. Prefer find_related_nodes for agent orientation JSON.",
      inputSchema: {
        format: z
          .enum(VIEW_FORMATS)
          .optional()
          .describe('Diagram format: "mermaid" (default) or "dot".'),
        focus: NODE_ID.optional().describe(
          "When set, export focus + 1-hop linked neighborhood only."
        ),
        include_retired: z
          .boolean()
          .optional()
          .describe(
            "Include deprecated/cancelled nodes and closed bugs (resolved/wontfix). Default false."
          ),
      },
    },
    guarded(({ format, focus, include_retired }) =>
      exportMindPlanViewHandler({ format, focus, include_retired })
    )
  );

  server.registerTool(
    "find_related_nodes",
    {
      title: "Find related nodes",
      description:
        "Call before creating a node, to reuse one that already exists. " +
        "Ranks nodes by text query (id/title/description) and returns the focus node plus its 1-hop " +
        "linked neighborhood (summaries only). Prefer this over get_mindplan_graph for orientation. " +
        "Provide query and/or node_id. Use get_node_context for full territory; get_blast_radius for transitive dependents.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text query to rank nodes (id, title, description). Required if node_id omitted."),
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
      },
    },
    guarded(({ query, node_id, type, limit }) =>
      findRelatedNodesHandler({ query, node_id, type, limit })
    )
  );

  server.registerTool(
    "get_node_implementation",
    {
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
    guarded(({ node_id, path }) => getNodeImplementationHandler({ node_id, path }))
  );

  server.registerTool(
    "get_node_context",
    {
      title: "Get node context",
      description:
        "Call when you are about to read or edit one node's territory. " +
        "Returns authoritative record (graph slice), editable body, attachment paths, and filenames. " +
        "Includes next slot when an evolution is in progress (`next.record` + `next.body`).",
      inputSchema: {
        node_id: NODE_ID.describe("The id of the node whose territory to read."),
      },
    },
    guarded(({ node_id }) => getNodeContext({ node_id }))
  );

  server.registerTool(
    "orient_for_work",
    {
      title: "Orient for work",
      description:
        "Call before each action, after get_rules. Not only at session start. " +
        "Composite orientation: find_related_nodes + get_node_context (record+body) for focus, " +
        "plus get_blast_radius when focus is a Foundation, Interaction, or Interface. " +
        "Blast radius groups affected_files by owner and omits cancelled/deprecated by default. " +
        "Interaction focus also includes reachability (exposing Interfaces, containing Journeys, leads_to downstream).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text query to rank nodes. Required if node_id omitted."),
        node_id: NODE_ID.optional().describe("Force focus to this node when present."),
        type: z.enum(NODE_TYPES).optional().describe("Optional type filter before ranking."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIND_LIMIT)
          .optional()
          .describe(`Max ranked matches (default ${DEFAULT_FIND_LIMIT}).`),
      },
    },
    guarded(({ query, node_id, type, limit }) =>
      orientForWork({ query, node_id, type, limit })
    )
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project brief",
      description:
        "Call before the first answer or code change in a session, and again after the product description or rules change. Not before every action. " +
        "Returns the systems dialect and this product's description and standing rules " +
        "({ path, description, rules, playbook }). playbook is the bundled MindPlan dialect; description/rules come from mindplan/project.md.",
      inputSchema: {},
    },
    guarded(() => getProject(), { drift: false })
  );

  server.registerTool(
    "get_rules",
    {
      title: "Get project rules",
      description:
        "Call before each action, before orient_for_work. Returns the mandatory project rules " +
        "({ path, rules }) from mindplan/project.md. Empty string when the section is empty. " +
        "Does not return the playbook or description.",
      inputSchema: {},
    },
    guarded(() => getRules(), { drift: false })
  );

  server.registerTool(
    "patch_node_territory",
    {
      title: "Patch node territory",
      description:
        "Call when a node's title, description, or body should match the work, before the feature code. Follow the plan-project skill. " +
        "Required writer for territory prose: body (PRD, checklists), optional title/description/role " +
        "(pre-ship or open evolution), toggle_checkboxes. Do not edit mindplan/ MDX with host file tools. " +
        "When a shipped node has an open evolution (not a mirror twin), patches default to next. Optional slot: current|next.",
      inputSchema: {
        node_id: NODE_ID.describe("Node whose territory to patch."),
        title: z
          .string()
          .min(1)
          .optional()
          .describe("New title (pre-ship or next slot)."),
        description: z
          .string()
          .optional()
          .describe("New description (pre-ship or next slot)."),
        role: z
          .enum(FOUNDATION_ROLES)
          .optional()
          .describe("Foundation role (pre-ship or next slot)."),
        body: z.string().optional().describe("Replace entire territory body below frontmatter."),
        toggle_checkboxes: z
          .array(
            z.object({
              contains: z.string().min(1).describe("Substring to match on a checkbox line."),
              checked: z.boolean().describe("true for [x], false for [ ]."),
            })
          )
          .optional()
          .describe("Toggle markdown checkboxes by matching line content."),
        slot: z
          .enum(["current", "next"])
          .optional()
          .describe("Territory slot to patch. Defaults to next when an open evolution exists."),
      },
    },
    guarded(({ node_id, title, description, role, body, toggle_checkboxes, slot }) =>
      patchNodeTerritory({ node_id, title, description, role, body, toggle_checkboxes, slot })
    )
  );

  server.registerTool(
    "patch_project_description",
    {
      title: "Patch project description",
      description:
        "Call when the product summary changes, through the plan-project skill. The next session start calls get_project again. " +
        "Writes the ## Description section of mindplan/project.md via the territory store. " +
        "Leaves ## Rules unchanged. Do not hand-edit project.md.",
      inputSchema: {
        description: z
          .string()
          .describe("Replace the ## Description section body. Empty string clears it."),
      },
    },
    guarded(({ description }) => patchProjectDescription({ description }))
  );

  server.registerTool(
    "patch_project_rules",
    {
      title: "Patch project rules",
      description:
        "Call when standing rules change, through the plan-project skill. The next action calls get_rules again. " +
        "Writes the ## Rules section of mindplan/project.md via the territory store. " +
        "Leaves ## Description unchanged. Do not hand-edit project.md.",
      inputSchema: {
        rules: z
          .string()
          .describe("Replace the ## Rules section body. Empty string clears it."),
      },
    },
    guarded(({ rules }) => patchProjectRules({ rules }))
  );

  server.registerTool(
    "patch_config",
    {
      title: "Patch project config",
      description:
        "Call when source roots or exclude paths change, through the plan-project skill. " +
        "Writes mindplan/config.json sources and/or exclude via the territory store. " +
        "Do not hand-edit config.json.",
      inputSchema: {
        sources: z
          .array(z.string())
          .optional()
          .describe("Glob list for the ownership universe (replaces sources when set)."),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Glob list excluded from the universe (replaces exclude when set)."),
      },
    },
    guarded(({ sources, exclude }) => patchConfig({ sources, exclude }))
  );

  server.registerTool(
    "put_attachment",
    {
      title: "Put node attachment",
      description:
        "Call when a supporting file should sit beside a node, through the plan-project skill. " +
        "Writes a file under attachments/ (or next-attachments/ while evolving) as base64. " +
        "Slot defaults to next when an open evolution exists.",
      inputSchema: {
        node_id: NODE_ID.describe("Node that owns the attachment."),
        filename: z.string().min(1).describe("Basename only (no path separators)."),
        content_base64: z.string().describe("File bytes encoded as base64."),
        slot: z.enum(["current", "next"]).optional().describe("Attachment slot override."),
      },
    },
    guarded(({ node_id, filename, content_base64, slot }) =>
      putAttachment({ node_id, filename, content_base64, slot })
    )
  );

  server.registerTool(
    "remove_attachment",
    {
      title: "Remove node attachment",
      description:
        "Call when a supporting file should leave a node, through the plan-project skill. " +
        "Deletes a file under attachments/ (or next-attachments/ while evolving). " +
        "Slot defaults to next when an open evolution exists.",
      inputSchema: {
        node_id: NODE_ID.describe("Node that owns the attachment."),
        filename: z.string().min(1).describe("Basename only (no path separators)."),
        slot: z.enum(["current", "next"]).optional().describe("Attachment slot override."),
      },
    },
    guarded(({ node_id, filename, slot }) => removeAttachment({ node_id, filename, slot }))
  );

  server.registerTool(
    "set_implementation_files",
    {
      title: "Set implementation files",
      description:
        "Call before writing a file the node does not yet claim. " +
        "Replaces the server-owned implements list for an Interaction, Interface, or Foundation. " +
        "Pre-ship writes current; shipped writes only an open next (else Blocked → open_next); " +
        "retired nodes may only shrink. Rejects bad paths and ownership conflicts.",
      inputSchema: {
        node_id: NODE_ID.describe("Pipeline node whose implements list to replace."),
        files: z
          .array(z.string())
          .describe(
            "Repo-relative POSIX paths (files, or directories ending in /). Replaces the slot list."
          ),
        slot: z
          .enum(["current", "next"])
          .optional()
          .describe("Optional slot override. Defaults by lifecycle."),
      },
    },
    guarded(({ node_id, files, slot }) => setImplementationFiles({ node_id, files, slot }))
  );

  server.registerTool(
    "create_node",
    {
      title: "Create node",
      description:
        "Call when reuse found no node, before any new-feature code. Follow the plan-project skill. " +
        "Creates a Journey, Interaction, Interface, Foundation, or Bug: scaffolds territory folder + <id>.mdx frontmatter. " +
        "Foundations require role. Declare owned files later with set_implementation_files (no package scaffold).",
      inputSchema: {
        id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
        type: z.enum(NODE_TYPES).describe("Journey | Interaction | Interface | Foundation | Bug"),
        title: z.string().min(1).describe("Human-readable title (written to <id>.mdx frontmatter)."),
        description: z.string().describe("Short description (written to <id>.mdx frontmatter)."),
        role: z
          .enum(FOUNDATION_ROLES)
          .optional()
          .describe("Required for Foundation: assembler | infra | design-system | adapter."),
      },
    },
    guarded(({ id, type, title, description, role }) =>
      createNode({ id, type, title, description, role })
    )
  );

  server.registerTool(
    "link_nodes",
    {
      title: "Link nodes",
      description:
        "Call when two existing nodes should be connected, as part of the plan-project skill. " +
        "Adds an edge to the DAG. Legal shapes: Interaction -belongs_to-> Journey, " +
        "Interaction|Interface -depends_on-> Foundation, Foundation -depends_on-> Foundation, " +
        "Interface -exposes-> Interaction, Interaction -leads_to-> Interaction, " +
        "Bug -affects-> Interaction|Interface|Foundation. " +
        "While a node has <id>.next.mdx, belongs_to/depends_on/exposes/leads_to writes go to the next slot (proposed edges applied on ship).",
      inputSchema: {
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
        edge_type: z
          .enum(EDGE_TYPES)
          .describe("belongs_to | depends_on | exposes | leads_to | affects"),
      },
    },
    guarded(({ source_id, target_id, edge_type }) =>
      linkNodes({ source_id, target_id, edge_type })
    )
  );

  server.registerTool(
    "open_next",
    {
      title: "Open next evolution",
      description:
        "Call when a shipped node's contract changes, before editing that contract. Follow the plan-project skill. " +
        "Flips a shipped node's standing <id>.next.mdx twin from state mirror to draft (creates the twin from live if missing). " +
        "Optional title/description overrides. Does not reset checkboxes. The live node keeps serving. " +
        "Ship from next in-review to promote and restore the mirror; discard_next to abandon and restore the mirror.",
      inputSchema: {
        node_id: NODE_ID.describe(
          "Id of the shipped Foundation, Interaction, or Interface to evolve."
        ),
        title: z.string().min(1).optional().describe("Optional new title for the next slot."),
        description: z.string().optional().describe("Optional new description for the next slot."),
      },
    },
    guarded(({ node_id, title, description }) => openNext({ node_id, title, description }))
  );

  server.registerTool(
    "discard_next",
    {
      title: "Discard next evolution",
      description:
        "Call when an open evolution should be abandoned. Follow the plan-project skill. " +
        "Abandons an in-flight evolution and restores <id>.next.mdx as a state: mirror twin of the live file. " +
        "Clears next-attachments/. The live <id>.mdx is unchanged.",
      inputSchema: {
        node_id: NODE_ID.describe("Id of the node whose open evolution to discard."),
      },
    },
    guarded(({ node_id }) => discardNext({ node_id }))
  );

  server.registerTool(
    "get_blast_radius",
    {
      title: "Get blast radius",
      description:
        "Call before changing a shipped node. " +
        "Returns nodes that depend on the given node (transitive reverse depends_on closure), " +
        "with hop distance, journeys_at_risk, and affected_files grouped by owner " +
        "({ owner_id, owner_type, via[], files[] }; via ∈ focus|dependent|exposing|importer). " +
        "Cancelled and deprecated nodes are omitted by default; set include_retired to see them " +
        "(BFS still traverses through retired nodes so live dependents keep true distances). " +
        "When the focus is an Interaction, also returns reachability.",
      inputSchema: {
        node_id: NODE_ID.describe("The id of the node whose dependents to analyze."),
        include_retired: z
          .boolean()
          .optional()
          .describe("Include cancelled/deprecated nodes (default false)."),
      },
    },
    guarded(({ node_id, include_retired }) =>
      getBlastRadius({ node_id, include_retired })
    )
  );

  server.registerTool(
    "unlink_nodes",
    {
      title: "Unlink nodes",
      description:
        "Call when an existing edge should go away, as part of the plan-project skill. " +
        "Removes edge(s) between two nodes from the source node's frontmatter.",
      inputSchema: {
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
      },
    },
    guarded(({ source_id, target_id }) => unlinkNodes({ source_id, target_id }))
  );

  server.registerTool(
    "update_node_status",
    {
      title: "Update node status",
      description:
        "Call when a node should move along the build or bug pipeline, including ship or resolved at handoff. " +
        "Transitions a Foundation, Interaction, Interface, or Bug. Build pipeline: draft -> ready -> in-progress -> in-review -> ship (sets stable/unstable). " +
        "Bug pipeline: open -> triaged -> fixing -> in-review -> resolved | wontfix. " +
        "When an open evolution exists (not a mirror twin), build-pipeline transitions apply to the next slot; " +
        "ship promotes next over current and restores the mirror twin. " +
        "Pass revisions to advance a set in one call: Foundations, then Interactions, then Interfaces, then Bugs; stops on the first Blocked and leaves earlier nodes transitioned. " +
        "Journey and production stable/unstable are computed automatically.",
      inputSchema: {
        node_id: NODE_ID.optional().describe(
          "The id of the single node to transition. Mutually exclusive with revisions."
        ),
        new_status: z
          .string()
          .optional()
          .describe(
            "Foundation/Interaction/Interface: draft | ready | in-progress | in-review | ship | cancelled | deprecated. " +
              "Bug: open | triaged | fixing | in-review | resolved | wontfix. " +
              "From stable/unstable: deprecated only (or open_next then build/ship next). " +
              "Pre-ship abandon: cancelled from draft|ready|in-progress|in-review. " +
              "Required with node_id. Omit when using revisions."
          ),
        revisions: z
          .array(
            z.object({
              node_id: NODE_ID.describe("Node to transition."),
              new_status: z.string().describe("Target status for this node."),
            })
          )
          .min(1)
          .optional()
          .describe(
            "One revision. Server orders Foundations, Interactions, Interfaces, then Bugs, and stops on the first Blocked. Mutually exclusive with node_id and new_status."
          ),
      },
    },
    guarded((args) => updateNodeStatus(args))
  );

  server.registerTool(
    "force_unship",
    {
      title: "Force unship (mistaken ship recovery)",
      description:
        "Call only after the user explicitly confirms a mistaken ship. " +
        "DANGEROUS recovery only. Ask the user first and wait for an explicit yes — never invent confirmation. " +
        "Reverses a mistaken Foundation/Interaction/Interface ship: clears shipped_at and sets a pre-ship state (default ready). " +
        'Requires confirm exactly equal to "unship:<node_id>". Blocked while an open evolution exists or shipped dependents exist. Deletes the standing mirror twin.',
      inputSchema: {
        node_id: NODE_ID.describe(
          "Stable/unstable Foundation, Interaction, or Interface to unship."
        ),
        confirm: z
          .string()
          .describe('Exact token after user confirmation: "unship:<node_id>". Do not invent this.'),
        new_status: z
          .enum(["draft", "ready", "in-progress", "in-review"])
          .optional()
          .describe("Pre-ship target state (default ready)."),
      },
    },
    guarded(({ node_id, confirm, new_status }) =>
      forceUnship({ node_id, confirm, new_status })
    )
  );
}
