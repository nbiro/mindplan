/**
 * Text ranking and 1-hop neighborhood for find_related_nodes.
 * Deterministic token scoring over id/title/description — no embeddings, no cache.
 */

import type { MindPlanEdge, MindPlanGraph, MindPlanNode, NodeType } from "./types.js";

export const DEFAULT_FIND_LIMIT = 5;
export const MAX_FIND_LIMIT = 20;

const SCORE_EXACT_ID = 1000;
const SCORE_ID_SUBSTRING = 100;
const SCORE_TITLE_TOKEN = 10;
const SCORE_DESCRIPTION_TOKEN = 3;

export interface RankedMatch {
  id: string;
  type: NodeType;
  state: MindPlanNode["state"];
  title: string;
  description: string;
  score: number;
}

export interface NodeSummary {
  id: string;
  type: NodeType;
  state: MindPlanNode["state"];
  title: string;
  description: string;
}

export interface FindRelatedResult {
  query: string;
  matches: RankedMatch[];
  focus: string | null;
  nodes: NodeSummary[];
  edges: MindPlanEdge[];
}

/** Tokenize on non-alphanumeric; lowercase; drop empties. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function toSummary(node: MindPlanNode): NodeSummary {
  return {
    id: node.id,
    type: node.type,
    state: node.state,
    title: node.title,
    description: node.description,
  };
}

/** Score a node against query tokens. Exact id match ≫ id substring ≫ title ≫ description. */
export function scoreNode(node: MindPlanNode, tokens: string[], queryLower: string): number {
  if (tokens.length === 0 && !queryLower) return 0;

  const id = node.id.toLowerCase();
  let score = 0;

  if (queryLower && id === queryLower) {
    score += SCORE_EXACT_ID;
  } else if (queryLower && id.includes(queryLower)) {
    score += SCORE_ID_SUBSTRING;
  }

  const titleLower = node.title.toLowerCase();
  const descLower = node.description.toLowerCase();

  for (const token of tokens) {
    if (id.includes(token)) score += SCORE_ID_SUBSTRING;
    if (titleLower.includes(token)) score += SCORE_TITLE_TOKEN;
    if (descLower.includes(token)) score += SCORE_DESCRIPTION_TOKEN;
  }

  return score;
}

export function rankNodes(
  nodes: MindPlanNode[],
  query: string,
  options?: { type?: NodeType; limit?: number }
): RankedMatch[] {
  const queryLower = query.trim().toLowerCase();
  const tokens = tokenize(query);
  const limit = Math.min(
    Math.max(options?.limit ?? DEFAULT_FIND_LIMIT, 1),
    MAX_FIND_LIMIT
  );

  let candidates = nodes;
  if (options?.type) {
    candidates = candidates.filter((n) => n.type === options.type);
  }

  const ranked: RankedMatch[] = [];
  for (const node of candidates) {
    const score = scoreNode(node, tokens, queryLower);
    if (score <= 0) continue;
    ranked.push({ ...toSummary(node), score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });

  return ranked.slice(0, limit);
}

/** Edges incident to focus (in or out); nodes = focus + every endpoint. */
export function expandNeighborhood(
  graph: MindPlanGraph,
  focusId: string
): { nodes: NodeSummary[]; edges: MindPlanEdge[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  if (!focus) {
    return { nodes: [], edges: [] };
  }

  const edges = graph.edges.filter((e) => e.source === focusId || e.target === focusId);
  const ids = new Set<string>([focusId]);
  for (const e of edges) {
    ids.add(e.source);
    ids.add(e.target);
  }

  const nodes = [...ids]
    .map((id) => byId.get(id))
    .filter((n): n is MindPlanNode => n !== undefined)
    .map(toSummary)
    .sort((a, b) => a.id.localeCompare(b.id));

  const sortedEdges = [...edges].sort((a, b) => {
    const ka = `${a.source}:${a.type}:${a.target}`;
    const kb = `${b.source}:${b.type}:${b.target}`;
    return ka.localeCompare(kb);
  });

  return { nodes, edges: sortedEdges };
}

export function findRelatedNodes(
  graph: MindPlanGraph,
  args: {
    query?: string;
    node_id?: string;
    type?: NodeType;
    limit?: number;
  }
): FindRelatedResult {
  const query = (args.query ?? "").trim();
  const matches =
    query.length > 0
      ? rankNodes(graph.nodes, query, { type: args.type, limit: args.limit })
      : [];

  let focus: string | null = null;
  if (args.node_id) {
    focus = args.node_id;
  } else if (matches.length > 0) {
    focus = matches[0].id;
  }

  if (!focus) {
    return { query, matches, focus: null, nodes: [], edges: [] };
  }

  const { nodes, edges } = expandNeighborhood(graph, focus);
  return { query, matches, focus, nodes, edges };
}
