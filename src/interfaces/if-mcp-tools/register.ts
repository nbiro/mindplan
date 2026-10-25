/**
 * MCP tools Interface — registers orient, steer, and export handlers with schemas,
 * annotations derived from each tool's kind, and the ok/guarded envelope. Does not own domain logic.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  DECISION_ID_PATTERN,
  EDGE_TYPES,
  NODE_TYPES,
} from "../../foundations/f-domain-model/types.js";
import { DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT } from "../../foundations/f-graph-search/search.js";
import { VIEW_FORMATS } from "../../foundations/f-view-projection/view.js";
import {
  GRAPH_PAGE_DEFAULT,
  GRAPH_PAGE_MAX,
  ORIENT_DEPTHS,
  findRelatedNodesHandler,
  getBlastRadius,
  getMindPlanGraph,
  getNodeContext,
  getNodeImplementationHandler,
  getProject,
  getRules,
  listDecisionsHandler,
  orientForWork,
} from "../../interactions/i-orient-plan/handlers.js";
import { withDrift } from "../../foundations/f-mcp-runtime/with-drift.js";
import {
  STATUS_SCOPES,
  createNode,
  discardNext,
  forceUnship,
  linkNodes,
  openNext,
  patchConfig,
  patchNodeRules,
  patchNodeTerritory,
  patchProjectDescription,
  patchProjectRules,
  putAttachment,
  recordDecision,
  removeAttachment,
  setImplementationFiles,
  setTestFiles,
  unlinkNodes,
  updateNodeStatus,
} from "../../interactions/i-steer-plan/handlers.js";
import { runCheckHandler } from "../../interactions/i-check-integrity/check.js";
import { EXPORT_RESULT_BUDGET, exportMindPlanViewHandler } from "../../interactions/i-export-map/handlers.js";
import { FOUNDATION_ROLES } from "../../foundations/f-domain-model/types.js";
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

/**
 * What a tool does to the graph. One kind per tool derives both its MCP annotations and its
 * envelope behavior (drift, verbose), so the hint the host prompts from and the result shape
 * cannot disagree. `destructive` removes data or edges that no undo restores.
 */
type ToolKind = "read" | "write" | "destructive";

/** Every tool acts on the local mindplan/ tree and the repo, never an external system. */
const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

type ToolConfig<Args extends ZodRawShapeCompat> = {
  kind: ToolKind;
  title: string;
  description: string;
  inputSchema: Args;
  /** `false` for read tools that must never carry drift (get_project, get_rules, run_check). */
  drift?: boolean;
};

/** Registers one tool: annotations from its kind, handler wrapped in the guarded envelope. */
function tool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  config: ToolConfig<Args>,
  handler: (args: ShapeOutput<Args>) => unknown
): void {
  const { kind, drift, ...rest } = config;
  // ToolCallback<Args> is a conditional type over a generic Args, which TypeScript cannot resolve
  // inside this helper; each concrete registration resolves it to (args: ShapeOutput<Args>) => result,
  // which is exactly what guarded() returns.
  const callback = guarded(handler, { write: kind !== "read", drift }) as unknown as ToolCallback<Args>;
  server.registerTool(name, { ...rest, annotations: ANNOTATIONS[kind] }, callback);
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

const VERBOSE = z
  .boolean()
  .optional()
  .describe(
    "Also return the node's record, its 1-hop neighborhood, and drift. Default false: a write returns { node_id, state, next_state, changed_files }."
  );

const NODE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "ids must be kebab_case/slug style: lowercase letters, digits, - and _");

const CHANGE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "change ids are slugs: lowercase letters, digits, - and _");

const CHANGE_REF = z
  .string()
  .optional()
  .describe("Optional branch name or PR URL for the change. Empty string clears it.");

/** The one flag that adds inherited decisions to orient_for_work and get_node_context. */
const INCLUDE_INHERITED_DECISIONS = z
  .boolean()
  .optional()
  .describe(
    "Also return the decisions inherited through belongs_to / depends_on (a Bug: past the nodes it affects): whole at distance 1, one line { id, node_id, distance, decision } beyond. Default false: only their count and nodes."
  );

/** Which writes send a ready revision back to draft; repeated in the write tools' hints. */
const READINESS_HINT =
  "A contract write to a slot in state ready (territory text or checkboxes, claims, links) moves that slot back to draft and returns readiness_reset; self-ready it again after review.";

/** Register every MindPlan MCP tool onto the given server. */
export function registerMindPlanTools(server: McpServer): void {
  tool(
    server,
    "run_check",
    {
      kind: "read",
      drift: false,
      title: "Run the integrity check",
      description:
        "Call before in-review, before ship, and before telling the user the work is done. " +
        "Runs the same check as `mindplan-mcp check`: graph load, exclusivity, coverage, presence (claims, and linked tests once a node is in review or shipped), mirror twins, leftovers, and the import matrix. " +
        "Returns { ok, output, failures, warnings }: output is exactly what the CLI prints (`mindplan-mcp check: ok`, or one Blocked: line per failure with the fix for each illegal import). " +
        "Warnings flag stale territory text, next-slot imports (one release before they Block), split route families, and revisions in review with no linked tests, and never fail the check. " +
        "An unclaimed source file is Blocked: Coverage with its probable owner and the claim call. " +
        "Pass change to also run the in-review gate on every member of that change: its open revisions and its neighbors (shipped nodes it edits in place; decision warnings for revisions only). " +
        "Moves to in-review and ship run this check on the node's files themselves.",
      inputSchema: {
        base: z
          .string()
          .optional()
          .describe("Opt-in: also enforce dirty-src ownership against this git ref (not used by CI)."),
        change: CHANGE_ID.optional().describe(
          "Also check every member of this change (imports, ownership, stale text) and list its members, each with kind revision | neighbor."
        ),
      },
    },
    ({ base, change }) => runCheckHandler({ base, change })
  );

  tool(
    server,
    "get_mindplan_graph",
    {
      kind: "read",
      title: "Get MindPlan graph",
      description:
        "Call when you need every node and edge. Prefer orient_for_work for one piece of work. " +
        "Returns one page of the MindPlan graph assembled from <id>.mdx frontmatter: nodes sorted by id, " +
        "the edges whose source is in the page, total_nodes, total_edges, and next_offset while nodes remain. " +
        `A graph of up to ${GRAPH_PAGE_DEFAULT} nodes fits one page; walk offset = next_offset for the rest.`,
      inputSchema: {
        offset: z.number().int().min(0).optional().describe("First node index (default 0)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(GRAPH_PAGE_MAX)
          .optional()
          .describe(`Nodes per page (default ${GRAPH_PAGE_DEFAULT}, max ${GRAPH_PAGE_MAX}).`),
      },
    },
    ({ offset, limit }) => getMindPlanGraph({ offset, limit })
  );

  tool(
    server,
    "export_mindplan_view",
    {
      kind: "read",
      title: "Export MindPlan view",
      description:
        "Call when a human wants a map for a PR or a doc. " +
        "Exports a deterministic typed-DAG projection as Mermaid or DOT. " +
        "Omit focus for the full filtered map; pass focus for that node plus its 1-hop neighborhood. " +
        "By default hides deprecated/cancelled nodes and closed bugs. Prefer find_related_nodes for agent orientation JSON. " +
        `A diagram over ${EXPORT_RESULT_BUDGET} characters is Blocked unless you pass focus or output (a repo-relative file path, outside mindplan/).`,
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
        decisions: z
          .boolean()
          .optional()
          .describe("Label each node that has active decisions with their count. Default false."),
        output: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Repo-relative file path to write the diagram to (outside mindplan/). The result then carries written_to and no diagram."
          ),
      },
    },
    ({ format, focus, include_retired, decisions, output }) =>
      exportMindPlanViewHandler({ format, focus, include_retired, decisions, output })
  );

  tool(
    server,
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
      },
    },
    ({ query, node_id, type, limit }) =>
      findRelatedNodesHandler({ query, node_id, type, limit })
  );

  tool(
    server,
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
  );

  tool(
    server,
    "get_node_context",
    {
      kind: "read",
      title: "Get node context",
      description:
        "Call when you are about to read or edit one node's territory. " +
        "Returns authoritative record (graph slice), editable body (without the ## Rules and ## Decisions sections), the node's own rules, " +
        "its own decisions (active ones; an empty list may still have superseded history, and a live decision replaced on the open next slot is hidden too: pass include_superseded to see the trail, as in list_decisions), " +
        "inherited_decisions ({ count, nodes }, plus entries with include_inherited_decisions), resolved_rules (every node rule that reaches it: it counts as orienting on the node), attachment paths, and filenames. " +
        "Includes next slot when an evolution is in progress (`next.record` + `next.body` + `next.decisions`).",
      inputSchema: {
        node_id: NODE_ID.describe("The id of the node whose territory to read."),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Also return superseded decisions (each names superseded_by). Default false."),
        include_inherited_decisions: INCLUDE_INHERITED_DECISIONS,
      },
    },
    ({ node_id, include_superseded, include_inherited_decisions }) =>
      getNodeContext({ node_id, include_superseded, include_inherited_decisions })
  );

  tool(
    server,
    "orient_for_work",
    {
      kind: "read",
      title: "Orient for work",
      description:
        "Call before each action, after get_rules. Not only at session start. Summary first: " +
        "with only a query it returns ranked rows ({ id, type, state, title, description, area?, score }, default 8, no body, rules, or decisions); " +
        "pick one and call again with node_id. When the top row is a clear winner (its exact id, the only match, or twice the next score) the full node comes back with the rows and auto_focus: true. " +
        "With node_id it returns the full node at depth: record and body (get_node_context), owned files, " +
        "and at full the 1-hop neighborhood and get_blast_radius for a Foundation, Interaction, or Interface. " +
        "Writes that act on a node (set_implementation_files, set_test_files, update_node_status, patch_node_territory, patch_node_rules, open_next, record_decision, attachments, force_unship, link_nodes / unlink_nodes on the source) " +
        "are Blocked: Orientation until that node had a full reply in this session (or get_node_context), and again after the rules that reach it changed; create_node is never blocked. " +
        "Also returns a rules block: the node rules that apply to the focus (its own, its Journey's, its Foundations', " +
        "or an affected node's for a Bug), each labeled with the node it came from and tagged with a version; pass known_rules_versions ({ node_id: version }) only for entries whose text you still hold, to leave that text out (they come back with unchanged: true). Those rules are mandatory. " +
        "And a decisions block, at every depth: the focus node's own recorded design decisions (a Bug: those of the nodes it affects); read them before reshaping that design. " +
        "inherited_decisions ({ count, nodes }) names the Journeys and Foundations whose decisions also apply; include_inherited_decisions adds them (whole at distance 1, one line beyond). Superseded ones only with include_superseded. " +
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
      },
    },
    ({ query, node_id, type, limit, depth, include_superseded, include_inherited_decisions, known_rules_versions }) =>
      orientForWork({
        query,
        node_id,
        type,
        limit,
        depth,
        include_superseded,
        include_inherited_decisions,
        known_rules_versions,
      })
  );

  tool(
    server,
    "get_project",
    {
      kind: "read",
      drift: false,
      title: "Get project brief",
      description:
        "Call before the first answer or code change in a session, and again after the product description or rules change. Not before every action. " +
        "Returns the systems dialect and this product's description and standing rules " +
        "({ path, description, rules, rules_version, playbook, check, version? }). playbook is the bundled MindPlan dialect; description/rules come from mindplan/project.md. " +
        "rules_version tags the rules: pass it to get_rules as known_version. " +
        "version appears only when mindplan/version.json is missing or does not match this server, and names the fix.",
      inputSchema: {},
    },
    () => getProject()
  );

  tool(
    server,
    "get_rules",
    {
      kind: "read",
      drift: false,
      title: "Get project rules",
      description:
        "Call before each action, before orient_for_work. Returns the mandatory project rules " +
        "({ path, rules, rules_version }) from mindplan/project.md. Empty string when the section is empty. " +
        "While you still hold the rules text, pass its rules_version as known_version: when the rules are unchanged the reply is { path, rules_version, unchanged: true } " +
        "and that text still applies; otherwise it carries the new text and tag. Without the text in context (a new session, a summarized one), pass nothing. " +
        "These are the global rules only; node rules arrive through orient_for_work. " +
        "Does not return the playbook or description.",
      inputSchema: {
        known_version: z
          .string()
          .optional()
          .describe("The rules_version of rules text you still hold (from get_project or get_rules); the text is left out when it still matches. Omit it when you no longer have the text."),
      },
    },
    ({ known_version }) => getRules({ known_version })
  );

  tool(
    server,
    "patch_node_territory",
    {
      kind: "write",
      title: "Patch node territory",
      description:
        "Call when a node's title, description, or body should match the work, before the feature code. " +
        "Required writer for territory prose: body (whole body), section + text (rewrite one ## section), " +
        "replace { find, with } (one exact edit), toggle_checkboxes, optional title/description/role " +
        "(pre-ship or open evolution). Prefer section/replace for small fixes: they do not resend the body. " +
        "Do not edit mindplan/ MDX with host file tools. " +
        "When a shipped node has an open evolution (not a mirror twin), patches default to next. Optional slot: current|next. " +
        READINESS_HINT +
        " change / change_ref set the revision's change id (grouping only: never resets readiness); moving the last revision off a change clears its neighbor labels (cleared_neighbors). " +
        "On a shipped node with no open next, change labels it a neighbor of that change (edited in place; returns neighbor_of, " +
        "and replaced_change when it had another label); change_ref is Blocked there.",
      inputSchema: {
        verbose: VERBOSE,
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
        section: z
          .string()
          .optional()
          .describe(
            'Heading of one section to rewrite, e.g. "## Purpose". Needs text. Other sections and the heading line stay as they are.'
          ),
        text: z
          .string()
          .optional()
          .describe("Replacement text for the section named by section."),
        replace: z
          .object({
            find: z.string().min(1).describe("Exact text to find in the body (must be unique unless all)."),
            with: z.string().describe("Replacement text."),
            all: z.boolean().optional().describe("Replace every occurrence."),
          })
          .optional()
          .describe("Replace one exact piece of the body without resending it."),
        toggle_checkboxes: z
          .array(
            z.object({
              contains: z.string().min(1).describe("Substring to match on a checkbox line."),
              checked: z
                .boolean()
                .optional()
                .describe("true for [x], false for [ ]. Optional with not_applicable (it ticks)."),
              all: z
                .boolean()
                .optional()
                .describe("Toggle every matching line. Without it, a substring matching several lines is Blocked."),
              note: z
                .string()
                .optional()
                .describe('Tick with a note, written as " — note: <text>" after the item.'),
              not_applicable: z
                .string()
                .optional()
                .describe('Tick as not applicable with a reason, written as " — n/a: <reason>". Counts as done.'),
            })
          )
          .optional()
          .describe(
            "Toggle markdown checkboxes by matching line content. Returns toggled: the lines as written. " +
              "Close an item honestly with note or not_applicable instead of rewording it."
          ),
        change: z
          .string()
          .optional()
          .describe(
            "Set this revision's change id (a slug), or label a shipped node with no open next a neighbor; empty string clears it."
          ),
        change_ref: CHANGE_REF,
        slot: z
          .enum(["current", "next"])
          .optional()
          .describe("Territory slot to patch. Defaults to next when an open evolution exists."),
      },
    },
    
      ({
        node_id,
        title,
        description,
        role,
        body,
        section,
        text,
        replace,
        toggle_checkboxes,
        change,
        change_ref,
        slot,
        verbose,
      }) =>
        patchNodeTerritory({
          node_id,
          title,
          description,
          role,
          body,
          section,
          text,
          replace,
          toggle_checkboxes,
          change,
          change_ref,
          slot,
          verbose,
        })
  );

  tool(
    server,
    "patch_node_rules",
    {
      kind: "write",
      title: "Patch node rules",
      description:
        "Call when a rule applies to one node and the work that inherits from it, not everywhere " +
        "(use patch_project_rules for rules that apply everywhere). " +
        "Replaces the ## Rules section of that node; an empty string clears it. Works on any non-retired node, " +
        "including shipped ones, without open_next. Returns rules_impact: the nodes whose work the rules reach.",
      inputSchema: {
        node_id: NODE_ID.describe("Node whose rules to replace."),
        rules: z
          .string()
          .describe(
            "Replace the node's ## Rules section. Empty string clears it. No level-1 or level-2 headings."
          ),
      },
    },
    ({ node_id, rules }) => patchNodeRules({ node_id, rules })
  );

  tool(
    server,
    "record_decision",
    {
      kind: "write",
      title: "Record a decision",
      description:
        "Call when you choose between viable designs (a data shape, an ordering guarantee, which system owns a fact), " +
        "on the node the choice shapes. Appends a structured entry to that node's ## Decisions section: on its next slot while a revision is open, else live. " +
        "Records are never rewritten: to change a decision, record a new one with supersedes (the old one stays listable as superseded). " +
        "A decision-worthy revision (a shipped Foundation's contract, a new migration or schema file, a wide blast radius, a depends_on change) " +
        "is Blocked at in-review until a decision is recorded under its change id or on the node. Never resets readiness.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Node the decision shapes (not a Bug)."),
        decision: z.string().min(1).describe("One sentence: what was chosen."),
        alternatives: z
          .array(z.string().min(1))
          .min(1)
          .describe("What else was considered, one line each (the alternative you rejected, and why it lost)."),
        why: z.string().min(1).describe("The constraint or trade-off that decided it."),
        consequences: z.string().optional().describe("What this makes harder or forbids."),
        supersedes: z
          .string()
          .optional()
          .describe("Id of an active decision on this node, its Journey, or its Foundations that this one replaces."),
        change: CHANGE_ID.optional().describe(
          "Change id to record it under (default: the node's open revision's change, or a neighbor's label). On a shipped node with no open next it also labels the node a neighbor of that change."
        ),
        id: z
          .string()
          .regex(DECISION_ID_PATTERN, 'decision ids are "d-" followed by a slug')
          .optional()
          .describe("Stable id, e.g. d-capacity-on-booking. Generated from the decision when omitted."),
      },
    },
    
      ({ node_id, decision, alternatives, why, consequences, supersedes, change, id, verbose }) =>
        recordDecision({ node_id, decision, alternatives, why, consequences, supersedes, change, id, verbose })
  );

  tool(
    server,
    "list_decisions",
    {
      kind: "read",
      title: "List decisions",
      description:
        "Call before reshaping a design someone else chose, or to read the reasoning trail of a node or change. " +
        "Returns { decisions, count }: one node's own decisions, every decision recorded under a change, or the whole graph's, " +
        "each with its node, status (active or superseded), and superseded_by. Superseded entries only with include_superseded.",
      inputSchema: {
        node_id: NODE_ID.optional().describe("List this node's own decisions."),
        change: CHANGE_ID.optional().describe("List decisions recorded under this change id."),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Also return superseded decisions. Default false."),
      },
    },
    ({ node_id, change, include_superseded }) =>
      listDecisionsHandler({ node_id, change, include_superseded })
  );

  tool(
    server,
    "patch_project_description",
    {
      kind: "write",
      title: "Patch project description",
      description:
        "Call when the product summary changes. The next session start calls get_project again. " +
        "Writes the ## Description section of mindplan/project.md via the territory store. " +
        "Leaves ## Rules unchanged. Do not hand-edit project.md.",
      inputSchema: {
        description: z
          .string()
          .describe("Replace the ## Description section body. Empty string clears it."),
      },
    },
    ({ description }) => patchProjectDescription({ description })
  );

  tool(
    server,
    "patch_project_rules",
    {
      kind: "write",
      title: "Patch project rules",
      description:
        "Call when standing rules change. The next action calls get_rules again. " +
        "Writes the ## Rules section of mindplan/project.md via the territory store. " +
        "Leaves ## Description unchanged. Do not hand-edit project.md.",
      inputSchema: {
        rules: z
          .string()
          .describe("Replace the ## Rules section body. Empty string clears it."),
      },
    },
    ({ rules }) => patchProjectRules({ rules })
  );

  tool(
    server,
    "patch_config",
    {
      kind: "write",
      title: "Patch project config",
      description:
        "Call when source roots, exclude paths, decision-gate settings, or search settings change. " +
        "Writes mindplan/config.json sources, exclude, decisions, and/or search via the territory store. " +
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
        // Strict: an unknown (mistyped) key is rejected instead of stripped into a silent no-op.
        decisions: z
          .strictObject({
            blast_radius: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("A revision with more dependents than this is decision-worthy (default 5)."),
            schema_files: z
              .array(z.string().min(1))
              .optional()
              .describe("Globs of migration and schema files; claiming a new one is decision-worthy."),
          })
          .optional()
          .describe("Decision-gate settings. A field not passed keeps its stored value."),
        search: z
          .strictObject({
            enabled: z
              .boolean()
              .optional()
              .describe("false turns semantic ranking off (keyword ranking always runs). Default true."),
            model: z
              .string()
              .min(1)
              .optional()
              .describe('Embedding model id (default "Xenova/bge-small-en-v1.5"); changing it rebuilds the search cache.'),
          })
          .optional()
          .describe("Search settings. A field not passed keeps its stored value."),
      },
    },
    ({ sources, exclude, decisions, search }) => patchConfig({ sources, exclude, decisions, search })
  );

  tool(
    server,
    "put_attachment",
    {
      kind: "write",
      title: "Put node attachment",
      description:
        "Call when a supporting file should sit beside a node. " +
        "Writes a file under attachments/ (or next-attachments/ while evolving) as base64. " +
        "Slot defaults to next when an open evolution exists.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Node that owns the attachment."),
        filename: z.string().min(1).describe("Basename only (no path separators)."),
        content_base64: z.string().describe("File bytes encoded as base64."),
        slot: z.enum(["current", "next"]).optional().describe("Attachment slot override."),
      },
    },
    
      ({ node_id, filename, content_base64, slot, verbose }) =>
        putAttachment({ node_id, filename, content_base64, slot, verbose })
  );

  tool(
    server,
    "remove_attachment",
    {
      kind: "destructive",
      title: "Remove node attachment",
      description:
        "Call when a supporting file should leave a node. " +
        "Deletes a file under attachments/ (or next-attachments/ while evolving). " +
        "Slot defaults to next when an open evolution exists.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Node that owns the attachment."),
        filename: z.string().min(1).describe("Basename only (no path separators)."),
        slot: z.enum(["current", "next"]).optional().describe("Attachment slot override."),
      },
    },
    
      ({ node_id, filename, slot, verbose }) =>
        removeAttachment({ node_id, filename, slot, verbose })
  );

  tool(
    server,
    "set_implementation_files",
    {
      kind: "write",
      title: "Set implementation files",
      description:
        "Call before writing a file the node does not yet claim. " +
        "Replaces the server-owned implements list for an Interaction, Interface, or Foundation. " +
        "Pre-ship writes current; shipped with an open next writes next; " +
        "shipped with no open next writes live in place, additive only: every old entry kept (or under a new dir entry), " +
        "each new entry an exact file (or F/) in a folder F the node dominates (it already claims a file directly in F, no other node claims under F); " +
        "removing, moving, globbing, claiming elsewhere, or claiming a migration or schema file (config decisions.schema_files) is Blocked → open_next. " +
        "In-place results list added_in_place; name each in the body with patch_node_territory (run_check warns until then). " +
        "retired nodes may only shrink. Rejects bad paths and ownership conflicts. " +
        "Results may carry folder_claims: a folder/ entry that would replace several per-file entries. " +
        "Entries are files, directories ending in /, or globs (* ** ?; [ ] stay literal), e.g. src/templates/*/actions/i-read-post/. " +
        READINESS_HINT,
      inputSchema: {
        verbose: VERBOSE,
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
        change: CHANGE_ID.or(z.literal(""))
          .optional()
          .describe(
            "Change id for the written slot; on a shipped node with no open next it labels the node a neighbor (returns neighbor_of). Empty string clears it."
          ),
      },
    },
    
      ({ node_id, files, slot, change, verbose }) =>
        setImplementationFiles({ node_id, files, slot, change, verbose })
  );

  tool(
    server,
    "set_test_files",
    {
      kind: "write",
      title: "Set test files",
      description:
        "Call when tests that verify a node exist, before moving it to in-review. " +
        "Replaces the node's linked tests list for an Interaction, Interface, or Foundation. " +
        "The list is evidence, not a claim: it does not own the files (claim them with set_implementation_files), several nodes may list one file, " +
        "and it is written to live and an open next alike, so a shipped node needs no open_next and readiness is never reset. " +
        "run_check Blocks an entry missing on disk once the node is in review or shipped, and warns about a revision in review with none. " +
        "get_blast_radius lists the linked tests a change should run. " +
        "Entries are files, directories ending in /, or globs (* ** ?). An empty list removes it.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Pipeline node whose linked tests to replace."),
        files: z
          .array(z.string())
          .describe("Repo-relative POSIX test paths (files, directories ending in /, or globs). Replaces the list."),
        change: CHANGE_ID.or(z.literal(""))
          .optional()
          .describe(
            "Change id for the active slot; on a shipped node with no open next it labels the node a neighbor (returns neighbor_of). Empty string clears it."
          ),
      },
    },
    
      ({ node_id, files, change, verbose }) => setTestFiles({ node_id, files, change, verbose })
  );

  tool(
    server,
    "create_node",
    {
      kind: "write",
      title: "Create node",
      description:
        "Call when reuse found no node, before any new-feature code. " +
        "Creates a Journey, Interaction, Interface, Foundation, or Bug: scaffolds territory folder + <id>.mdx frontmatter. " +
        "Foundations require role. Declare owned files later with set_implementation_files (no package scaffold).",
      inputSchema: {
        verbose: VERBOSE,
        id: NODE_ID.describe("Unique slug id for the node, e.g. bug-checkout-race."),
        type: z.enum(NODE_TYPES).describe("Journey | Interaction | Interface | Foundation | Bug"),
        title: z.string().min(1).describe("Human-readable title (written to <id>.mdx frontmatter)."),
        description: z.string().describe("Short description (written to <id>.mdx frontmatter)."),
        role: z
          .enum(FOUNDATION_ROLES)
          .optional()
          .describe("Required for Foundation: assembler | infra | design-system | adapter."),
        change: CHANGE_ID.optional().describe(
          "Optional change id (a slug) that ties this new Foundation, Interaction, or Interface to other revisions of one change."
        ),
        change_ref: CHANGE_REF,
      },
    },
    
      ({ id, type, title, description, role, change, change_ref, verbose }) =>
        createNode({ id, type, title, description, role, change, change_ref, verbose })
  );

  tool(
    server,
    "link_nodes",
    {
      kind: "write",
      title: "Link nodes",
      description:
        "Call when two existing nodes should be connected. " +
        "Adds an edge to the DAG. Legal shapes: Interaction -belongs_to-> Journey, " +
        "Interaction|Interface -depends_on-> Foundation, Foundation -depends_on-> Foundation, " +
        "Interface -exposes-> Interaction, Foundation -mounts-> Interface (a composition root that imports Interfaces), Interaction -leads_to-> Interaction, " +
        "Bug -affects-> Interaction|Interface|Foundation. " +
        "While a node has <id>.next.mdx, belongs_to/depends_on/exposes/leads_to writes go to the next slot (proposed edges applied on ship). " +
        READINESS_HINT,
      inputSchema: {
        verbose: VERBOSE,
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
        edge_type: z
          .enum(EDGE_TYPES)
          .describe("belongs_to | depends_on | exposes | leads_to | affects | mounts"),
      },
    },
    
      ({ source_id, target_id, edge_type, verbose }) =>
        linkNodes({ source_id, target_id, edge_type, verbose })
  );

  tool(
    server,
    "open_next",
    {
      kind: "write",
      title: "Open next evolution",
      description:
        "Call when a shipped node's contract changes, before editing that contract. " +
        "Flips a shipped node's standing <id>.next.mdx twin from state mirror to draft (creates the twin from live if missing). " +
        "Optional title/description overrides. Does not reset checkboxes. The live node keeps serving. " +
        "Ship from next in-review to promote and restore the mirror; discard_next to abandon and restore the mirror. " +
        "Pass change to tie this revision to the others of one change (update_node_status scope change, get_blast_radius change, run_check change act on the group). " +
        "A neighbor label is inherited as the revision's change unless change names another, which clears it (replaced_change).",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe(
          "Id of the shipped Foundation, Interaction, or Interface to evolve."
        ),
        title: z.string().min(1).optional().describe("Optional new title for the next slot."),
        description: z.string().optional().describe("Optional new description for the next slot."),
        change: CHANGE_ID.optional().describe("Optional change id (a slug) grouping this revision with others."),
        change_ref: CHANGE_REF,
      },
    },
    
      ({ node_id, title, description, change, change_ref, verbose }) =>
        openNext({ node_id, title, description, change, change_ref, verbose })
  );

  tool(
    server,
    "discard_next",
    {
      kind: "destructive",
      title: "Discard next evolution",
      description:
        "Call when an open evolution should be abandoned. " +
        "Abandons an in-flight evolution and restores <id>.next.mdx as a state: mirror twin of the live file. " +
        "Clears next-attachments/. The live <id>.mdx is unchanged. " +
        "When it was its change's last open revision, the change's neighbor labels are cleared (cleared_neighbors).",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Id of the node whose open evolution to discard."),
      },
    },
    ({ node_id, verbose }) => discardNext({ node_id, verbose })
  );

  tool(
    server,
    "get_blast_radius",
    {
      kind: "read",
      title: "Get blast radius",
      description:
        "Call before changing a shipped node. " +
        "Returns nodes that depend on the given node (transitive reverse depends_on closure), " +
        "with hop distance, journeys_at_risk, and affected_files grouped by owner " +
        "({ owner_id, owner_type, via[], files[] }; via ∈ focus|dependent|exposing|importer). " +
        "Cancelled and deprecated nodes are omitted by default; set include_retired to see them " +
        "(BFS still traverses through retired nodes so live dependents keep true distances). " +
        "When the focus is an Interaction, also returns reachability. " +
        "decisions lists the active decisions held by the focus; dependent_decisions ({ count, nodes }) names the dependents that hold decisions a change would reach, and include_dependent_decisions adds their one-line entries to decisions. " +
        "tests lists the linked test files of the focus and every owner in affected_files: the suites to run. " +
        "Pass change instead of node_id for the merged radius of every member of a change (open revisions and neighbors; members carry kind).",
      inputSchema: {
        node_id: NODE_ID.optional().describe("The id of the node whose dependents to analyze. Or pass change."),
        change: CHANGE_ID.optional().describe("A change id: merge the blast radius of all its open revisions and neighbors."),
        include_retired: z
          .boolean()
          .optional()
          .describe("Include cancelled/deprecated nodes (default false)."),
        include_dependent_decisions: z
          .boolean()
          .optional()
          .describe("Also list the dependents' decisions in decisions (default false: only their count and nodes)."),
      },
    },
    ({ node_id, change, include_retired, include_dependent_decisions }) =>
      getBlastRadius({ node_id, change, include_retired, include_dependent_decisions })
  );

  tool(
    server,
    "unlink_nodes",
    {
      kind: "destructive",
      title: "Unlink nodes",
      description:
        "Call when an existing edge should go away. " +
        "Removes edge(s) between two nodes from the source node's frontmatter. " +
        READINESS_HINT,
      inputSchema: {
        verbose: VERBOSE,
        source_id: NODE_ID.describe("The id of the edge source node."),
        target_id: NODE_ID.describe("The id of the edge target node."),
      },
    },
    
      ({ source_id, target_id, verbose }) => unlinkNodes({ source_id, target_id, verbose })
  );

  tool(
    server,
    "update_node_status",
    {
      kind: "write",
      title: "Update node status",
      description:
        "Call when a node should move along the build or bug pipeline, including ship or resolved at handoff. " +
        "Transitions a Foundation, Interaction, Interface, or Bug. Build pipeline: draft -> ready -> in-progress -> in-review -> ship (sets stable/unstable). " +
        "Bug pipeline: open -> triaged -> fixing -> in-review -> resolved | wontfix. " +
        "When an open evolution exists (not a mirror twin), build-pipeline transitions apply to the next slot; " +
        "ship promotes next over current and restores the mirror twin. " +
        "Pass revisions to advance a set in one call: Foundations, then Interactions, then Interfaces, then Bugs; stops on the first Blocked and leaves earlier nodes transitioned. " +
        "Pass scope + new_status to walk every open update (or a node and its dependents, or one change's revisions) to a target in one call, validated before the first write; dry_run lists every transition. " +
        "A scoped walk to ship that would skip a node's in-review stop is Blocked unless skip_review: true, which walks it through in-review (gate included) and reports skipped_review. " +
        "Moves to in-review and ship run the check's import and ownership rules on the node's files and return Blocked: on a violation; stale-text warnings ride along. " +
        "A move to in-review of a decision-worthy revision (a shipped Foundation's contract, a new migration or schema file, a wide blast radius, or a depends_on change) with no decision recorded is Blocked: Decision with the record_decision call. " +
        "A batch returns one line per node. " +
        "When a ship or cancel leaves a change with no open revisions, its neighbor labels are cleared (cleared_neighbors); " +
        "scope change walks revisions only, and a walk of it to ship clears its labels. " +
        "Journey and production stable/unstable are computed automatically.",
      inputSchema: {
        verbose: VERBOSE,
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
        scope: z
          .enum(STATUS_SCOPES)
          .optional()
          .describe(
            "Walk many nodes in one call to the new_status target: all_open_updates (every shipped node with an open next, and every pre-ship node being built: in-progress or in-review; draft and ready plans are never walked) " +
              "or node_and_dependents (node_id plus its open dependents), or change (every open revision with that change id, draft and ready included). " +
              "The server orders Foundations, Interactions, Interfaces, " +
              "walks each node through the pipeline, and validates the whole walk before writing anything. Target: ready | in-progress | in-review | ship."
          ),
        change: CHANGE_ID.optional().describe('The change id walked by scope "change".'),
        skip_review: z
          .boolean()
          .optional()
          .describe(
            "Scoped walk to ship only: allow moving nodes that are not in-review yet. Each still passes the in-review gate; the result lists skipped_review."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Validate and return the plan and the first Blocked reason without writing anything."
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
    (args) => updateNodeStatus(args)
  );

  tool(
    server,
    "force_unship",
    {
      kind: "destructive",
      title: "Force unship (mistaken ship recovery)",
      description:
        "Call only after the user confirms a mistaken ship; recovery only. " +
        "Reverses a mistaken Foundation/Interaction/Interface ship: clears shipped_at and sets a pre-ship state (default ready). " +
        'Requires confirm exactly equal to "unship:<node_id>"; do not invent the confirm token. Blocked while an open evolution exists or shipped dependents exist. Deletes the standing mirror twin and clears a neighbor label (cleared_change) and added_claims.',
      inputSchema: {
        verbose: VERBOSE,
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
    
      ({ node_id, confirm, new_status, verbose }) =>
        forceUnship({ node_id, confirm, new_status, verbose })
  );
}
