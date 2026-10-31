/**
 * Browse the graph — owned by i-browse-graph: get_mindplan_graph (paged), list_areas, and
 * list_decisions.
 */

import {
  activeChange,
  BUG_STATES,
  EDGE_TYPES,
  EXECUTION_STATES,
  isInactiveNode,
  JOURNEY_STATES,
  PRODUCTION_STATES,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeState,
  type NodeType,
} from "../../foundations/f-domain-model/types.js";
import { loadGraph } from "../../foundations/f-territory-store/store.js";
import { findNode } from "../../foundations/f-compiler-rules/rules.js";
import { areaMembers } from "../../foundations/f-graph-search/search.js";
import { listDecisions } from "../../foundations/f-graph-search/decisions.js";

/** Default and maximum node count per `get_mindplan_graph` page. */
export const GRAPH_PAGE_DEFAULT = 200;

export const GRAPH_PAGE_MAX = 500;

/** Every node state a `state` filter may name: the build pipeline's, production's, Journeys', and Bugs'. */
export const GRAPH_NODE_STATES = [
  ...new Set<NodeState>([...EXECUTION_STATES, ...PRODUCTION_STATES, ...JOURNEY_STATES, ...BUG_STATES]),
] as [NodeState, ...NodeState[]];

/** The node record fields `fields` may name: every key of a `MindPlanNode`. */
export const GRAPH_NODE_FIELDS = [
  "id",
  "type",
  "title",
  "description",
  "state",
  "created_at",
  "updated_at",
  "shipped_at",
  "revisions",
  "split_at",
  "split_into",
  "churn",
  "churn_at",
  "severity",
  "belongs_to",
  "depends_on",
  "exposes",
  "leads_to",
  "mounts",
  "affects",
  "implements",
  "added_claims",
  "tests",
  "aliases",
  "planned",
  "attributed",
  "role",
  "next",
  "rules",
  "change",
  "change_ref",
  "decisions",
] as const satisfies readonly (keyof MindPlanNode)[];

// Fails to compile when MindPlanNode gains a key the list does not name.
const _allFieldsListed: Exclude<keyof MindPlanNode, (typeof GRAPH_NODE_FIELDS)[number]> extends never ? true : never =
  true;
void _allFieldsListed;

export type GraphNodeField = (typeof GRAPH_NODE_FIELDS)[number];

export type GraphQuery = {
  offset?: number;
  limit?: number;
  state?: NodeState | NodeState[];
  type?: NodeType | NodeType[];
  change?: string;
  fields?: string[];
  /** true (default): every edge from the page; false: none; an array: only those edge types. */
  edges?: boolean | string[];
};

export type GraphPage = Omit<MindPlanGraph, "nodes" | "edges"> & {
  nodes: Partial<MindPlanNode>[];
  /** Absent with `edges: false`. */
  edges?: MindPlanGraph["edges"];
  /** Absent with `edges: false`. */
  total_edges?: number;
  total_nodes: number;
  offset: number;
  limit: number;
  /** Present only when nodes remain after this page. */
  next_offset?: number;
};

/** The node's change as the change tools read it: an open revision's (`activeChange`). */
function nodeChange(node: MindPlanNode): string | undefined {
  return activeChange(node);
}

/** Unknown names fail before any node is read, listing the valid ones. */
function projectionFields(fields: string[]): Set<string> {
  for (const name of fields) {
    if (!(GRAPH_NODE_FIELDS as readonly string[]).includes(name)) {
      throw new Error(
        `Blocked: get_mindplan_graph fields: unknown field "${name}". Valid fields: ${GRAPH_NODE_FIELDS.join(", ")}.`
      );
    }
  }
  return new Set(["id", ...fields]);
}

/**
 * The edge types an `edges` array keeps; null for `true`, `false`, or omitted (the caller drops every
 * edge on `false`). Unknown names fail before any node is read, listing the valid ones.
 */
function edgeSelection(edges: boolean | string[] | undefined): Set<string> | null {
  if (!Array.isArray(edges)) return null;
  for (const name of edges) {
    if (!(EDGE_TYPES as readonly string[]).includes(name)) {
      throw new Error(
        `Blocked: get_mindplan_graph edges: unknown edge type "${name}". Valid edge types: ${EDGE_TYPES.join(", ")}.`
      );
    }
  }
  return new Set(edges);
}

const asList = <T>(value: T | T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

/**
 * One page of the graph: nodes filtered (`state`, `type`, `change`: AND across filters, OR inside
 * one array), sorted by id, and sliced by offset/limit, plus every edge whose source is in the
 * page, so a walk over all pages sees each node and each edge exactly once. Totals describe the
 * filtered set. `fields` keeps only the named fields (and `id`) on each node. `edges: false` drops
 * `edges` and `total_edges`; an array of edge types keeps only those (and counts only those). The
 * default page keeps one result under a host's size limit; with no filter a graph that fits returns
 * the whole graph plus the totals.
 */
export function getMindPlanGraph(args: GraphQuery = {}): GraphPage {
  const keep = args.fields ? projectionFields(args.fields) : null;
  const edgeTypes = edgeSelection(args.edges);
  const omitEdges = args.edges === false;
  const states = asList(args.state);
  const types = asList(args.type);
  const graph = loadGraph();
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.min(GRAPH_PAGE_MAX, Math.max(1, Math.floor(args.limit ?? GRAPH_PAGE_DEFAULT)));
  const filtered = graph.nodes.filter(
    (n) =>
      (!states || states.includes(n.state)) &&
      (!types || types.includes(n.type)) &&
      (args.change === undefined || nodeChange(n) === args.change)
  );
  const unfiltered = filtered.length === graph.nodes.length;
  const sorted = filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const slice = sorted.slice(offset, offset + limit);
  const nodes = keep
    ? slice.map(
        (n) => Object.fromEntries(Object.entries(n).filter(([key]) => keep.has(key))) as Partial<MindPlanNode>
      )
    : slice;
  let edges: GraphPage["edges"];
  let totalEdges: number | undefined;
  if (!omitEdges) {
    const typed = edgeTypes ? graph.edges.filter((e) => edgeTypes.has(e.type)) : graph.edges;
    const inPage = new Set(slice.map((n) => n.id));
    const inSet = new Set(sorted.map((n) => n.id));
    edges = typed.filter((e) => inPage.has(e.source));
    totalEdges = unfiltered ? typed.length : typed.filter((e) => inSet.has(e.source)).length;
  }
  // Key order matches the reply before `edges` existed.
  const page: GraphPage = {
    version: graph.version,
    nodes,
    ...(edges ? { edges } : {}),
    total_nodes: sorted.length,
    ...(totalEdges !== undefined ? { total_edges: totalEdges } : {}),
    offset,
    limit,
  };
  if (offset + nodes.length < sorted.length) page.next_offset = offset + nodes.length;
  return page;
}

/** An area row's description is cut to this many characters (the full one comes with orient). */
export const AREA_DESCRIPTION_CHARS = 60;

export const AREA_COLUMNS = ["id", "title", "description", "interactions", "interfaces", "foundations", "open_bugs"] as const;

/**
 * Every Journey as one compact row: `{ columns, rows, count }`, a row being `[id, title,
 * description (60 characters), interactions, interfaces, foundations, open_bugs]` over the area's
 * live members (`areaMembers`): its active Interactions, the Interfaces exposing them, the
 * Foundations they depend on, and the open Bugs affecting any of those. Rows sort by id. Small
 * enough to call before orienting (30 areas stay under 4 KB); pass a row's id as `area`.
 */
export function listAreas(): Record<string, unknown> {
  const graph = loadGraph();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const journeys = graph.nodes
    .filter((n) => n.type === "Journey" && !isInactiveNode(n))
    .sort((a, b) => a.id.localeCompare(b.id));
  const rows = journeys.map((j) => {
    const members = [...areaMembers(graph, j.id)]
      .map((id) => byId.get(id))
      .filter((n): n is MindPlanNode => n !== undefined && !isInactiveNode(n));
    const count = (type: NodeType) => members.filter((n) => n.type === type).length;
    const memberIds = new Set(members.map((n) => n.id));
    const openBugs = graph.nodes.filter(
      (n) => n.type === "Bug" && !isInactiveNode(n) && (n.affects ?? []).some((id) => memberIds.has(id))
    ).length;
    const title = j.next?.title ?? j.title;
    const full = j.next?.description ?? j.description;
    const description =
      full.length > AREA_DESCRIPTION_CHARS ? `${full.slice(0, AREA_DESCRIPTION_CHARS - 1).trimEnd()}…` : full;
    return [j.id, title, description, count("Interaction"), count("Interface"), count("Foundation"), openBugs];
  });
  return { columns: AREA_COLUMNS, rows, count: rows.length };
}

/**
 * Decision records by node (its own, active slot), by change, or for the whole graph.
 * Superseded entries only with `include_superseded`, each naming `superseded_by`.
 */
export function listDecisionsHandler(args: {
  node_id?: string;
  change?: string;
  include_superseded?: boolean;
}): Record<string, unknown> {
  const graph = loadGraph();
  if (args.node_id) findNode(graph, args.node_id);
  const decisions = listDecisions(graph, {
    node_id: args.node_id,
    change: args.change,
    include_superseded: args.include_superseded,
  });
  return {
    ...(args.node_id ? { node_id: args.node_id } : {}),
    ...(args.change ? { change: args.change } : {}),
    decisions,
    count: decisions.length,
  };
}
