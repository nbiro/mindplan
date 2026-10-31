/**
 * Browse the graph — owned by i-browse-graph: get_mindplan_graph (paged), list_areas, and
 * list_decisions.
 */

import {
  isInactiveNode,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeType,
} from "../../foundations/f-domain-model/types.js";
import { loadGraph } from "../../foundations/f-territory-store/store.js";
import { findNode } from "../../foundations/f-compiler-rules/rules.js";
import { areaMembers } from "../../foundations/f-graph-search/search.js";
import { listDecisions } from "../../foundations/f-graph-search/decisions.js";

/** Default and maximum node count per `get_mindplan_graph` page. */
export const GRAPH_PAGE_DEFAULT = 200;

export const GRAPH_PAGE_MAX = 500;

export type GraphPage = MindPlanGraph & {
  total_nodes: number;
  total_edges: number;
  offset: number;
  limit: number;
  /** Present only when nodes remain after this page. */
  next_offset?: number;
};

/**
 * One page of the graph: nodes sorted by id and sliced by offset/limit, plus every edge whose
 * source is in the page, so a walk over all pages sees each node and each edge exactly once.
 * The default page keeps one result under a host's size limit; a graph that fits returns the
 * whole graph plus the totals.
 */
export function getMindPlanGraph(args: { offset?: number; limit?: number } = {}): GraphPage {
  const graph = loadGraph();
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.min(GRAPH_PAGE_MAX, Math.max(1, Math.floor(args.limit ?? GRAPH_PAGE_DEFAULT)));
  const sorted = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nodes = sorted.slice(offset, offset + limit);
  const inPage = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => inPage.has(e.source));
  const page: GraphPage = {
    version: graph.version,
    nodes,
    edges,
    total_nodes: sorted.length,
    total_edges: graph.edges.length,
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
