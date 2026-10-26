/**
 * Text ranking and 1-hop neighborhood for find_related_nodes and orient_for_work.
 * `searchNodes` ranks hybrid: keyword (FTS5 bm25 from the search index, or token scoring when
 * there is no index) and semantic (cosine over node embeddings, once the model is ready) merged
 * with reciprocal rank fusion, then a small graph boost; an exact id is always first.
 * `rankNodes` is the token scoring alone: the fallback, and pure.
 */

import type { MindPlanEdge, MindPlanGraph, MindPlanNode, NodeType } from "../f-domain-model/types.js";
import type { SearchDoc } from "../f-search-index/index-db.js";
import type { Embedder } from "../f-search-index/embedder.js";
import { keywordRankDocs } from "../f-search-index/keyword-js.js";
import { prepareSearch, refreshSearch, warmSearch } from "../f-search-index/service.js";

export const DEFAULT_FIND_LIMIT = 5;
export const MAX_FIND_LIMIT = 20;

const SCORE_EXACT_ID = 1000;
const SCORE_ID_SUBSTRING = 100;
const SCORE_TITLE_TOKEN = 10;
const SCORE_DESCRIPTION_TOKEN = 3;

/**
 * One ranked node. `score` is the fused score of `searchNodes` (the token score of `rankNodes`):
 * higher is better, comparable only within one reply.
 */
export interface RankedMatch {
  id: string;
  type: NodeType;
  state: MindPlanNode["state"];
  title: string;
  description: string;
  score: number;
  /** Journey titles of the node (`searchDocs` area); set by `searchNodes`, absent from `rankNodes`. */
  area?: string[];
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

const CLOSED_BUG_STATES = new Set(["resolved", "wontfix"]);

/** Match export_mindplan_view default: hide deprecated/cancelled nodes and closed bugs from ranking. */
function isRetired(node: MindPlanNode): boolean {
  if (node.state === "deprecated" || node.state === "cancelled") return true;
  if (node.type === "Bug" && CLOSED_BUG_STATES.has(node.state)) return true;
  return false;
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
  // Aliases weigh like the title: they are other names for the node.
  const aliasesLower = (node.aliases ?? []).join(" | ").toLowerCase();

  for (const token of tokens) {
    if (id.includes(token)) score += SCORE_ID_SUBSTRING;
    if (titleLower.includes(token)) score += SCORE_TITLE_TOKEN;
    if (aliasesLower.includes(token)) score += SCORE_TITLE_TOKEN;
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

  let candidates = nodes.filter((n) => !isRetired(n));
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

/**
 * Focus plus 1-hop neighborhood. `matches` are rows already ranked by `searchNodes`; without them
 * the query is ranked by token scoring (`rankNodes`).
 */
export function findRelatedNodes(
  graph: MindPlanGraph,
  args: {
    query?: string;
    node_id?: string;
    type?: NodeType;
    limit?: number;
    matches?: RankedMatch[];
  }
): FindRelatedResult {
  const query = (args.query ?? "").trim();
  const matches =
    args.matches ??
    (query.length > 0 ? rankNodes(graph.nodes, query, { type: args.type, limit: args.limit }) : []);

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

// --- Hybrid search -------------------------------------------------------------------------

/** Scaffold headings every node has; they say nothing about what a node does. */
const SCAFFOLD_HEADINGS = new Set([
  "purpose",
  "actor & trigger",
  "execution logic",
  "acceptance criteria",
  "atomic ops",
  "checklist",
  "attachments",
  "rules",
  "decisions",
  "shared substrate spec",
  "interface spec",
  "kind",
  "prd",
  "spec",
  "symptoms",
  "reproduction",
  "fix",
]);

/** The `##` headings of a body, scaffold headings left out, in order, without duplicates. */
export function sectionHeadings(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const heading = m[1].trim();
    if (!heading || SCAFFOLD_HEADINGS.has(heading.toLowerCase()) || out.includes(heading)) continue;
    out.push(heading);
  }
  return out;
}

/**
 * Reads a node's body for its headings: the open next slot's while a revision is open. `stamp`
 * (the file's modification time) makes an edit made outside MCP that leaves the frontmatter alone
 * re-read the headings too.
 */
export type BodyReader = ((node: MindPlanNode, slot: "current" | "next") => string) & {
  stamp?: (node: MindPlanNode, slot: "current" | "next") => string;
};

const headingMemo = new Map<string, string[]>();

function headingsOf(node: MindPlanNode, readBody: BodyReader | undefined): string[] {
  if (!readBody) return [];
  const slot = node.next ? "next" : "current";
  let stamp = "";
  try {
    stamp = readBody.stamp?.(node, slot) ?? "";
  } catch {
    // No stamp: the memo keys on updated_at alone.
  }
  const key = `${node.id}\u0000${slot}\u0000${node.next?.updated_at ?? node.updated_at}\u0000${stamp}`;
  const hit = headingMemo.get(key);
  if (hit) return hit;
  let headings: string[] = [];
  try {
    headings = sectionHeadings(readBody(node, slot));
  } catch {
    // A node whose file cannot be read is still searchable by its record.
  }
  if (headingMemo.size > 20000) headingMemo.clear();
  headingMemo.set(key, headings);
  return headings;
}

const SEARCH_EDGE_FIELDS = ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "affects"] as const;
type SearchEdgeField = (typeof SEARCH_EDGE_FIELDS)[number];

/** Live and proposed targets of one edge field. */
function edgeTargets(n: MindPlanNode, field: SearchEdgeField): string[] {
  const live = n[field] ?? [];
  const next = field === "affects" ? [] : (n.next?.[field] ?? []);
  return [...new Set([...live, ...next])];
}

/**
 * One `SearchDoc` per node: the open next slot's title and description while a revision is open
 * (so a node being reshaped is found by its new wording), its area (Journey titles reached through
 * belongs_to, through the Interactions an Interface exposes, or through the Interactions a Bug
 * affects), its entry points (the Interfaces that expose it), its aliases, its section headings
 * (minus those most nodes share), and its claimed paths.
 */
export function searchDocs(graph: MindPlanGraph, readBody?: BodyReader): SearchDoc[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const journeysOf = (n: MindPlanNode): string[] =>
    edgeTargets(n, "belongs_to")
      .map((id) => byId.get(id))
      .filter((j): j is MindPlanNode => j?.type === "Journey")
      .map((j) => j.title);
  const areaOf = (n: MindPlanNode): string[] => {
    const titles = new Set<string>();
    const add = (ix: MindPlanNode | undefined) => {
      if (ix?.type === "Interaction") for (const t of journeysOf(ix)) titles.add(t);
    };
    if (n.type === "Interaction") add(n);
    if (n.type === "Interface") for (const id of edgeTargets(n, "exposes")) add(byId.get(id));
    if (n.type === "Bug") for (const id of edgeTargets(n, "affects")) add(byId.get(id));
    return [...titles];
  };
  // A heading most nodes share (a scaffold section) says nothing about any one of them.
  const headings = new Map(graph.nodes.map((n) => [n.id, headingsOf(n, readBody)]));
  const seen = new Map<string, number>();
  for (const list of headings.values()) {
    for (const h of new Set(list.map((x) => x.toLowerCase()))) seen.set(h, (seen.get(h) ?? 0) + 1);
  }
  const common = Math.max(3, Math.ceil(graph.nodes.length * 0.08));
  const entries = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.type !== "Interface" || isRetired(n)) continue;
    for (const id of edgeTargets(n, "exposes")) entries.set(id, [...(entries.get(id) ?? []), n.next?.title ?? n.title]);
  }
  return graph.nodes.map((n) => {
    const edges: { target: string; type: string }[] = [];
    for (const field of SEARCH_EDGE_FIELDS) {
      for (const target of edgeTargets(n, field)) edges.push({ target, type: field });
    }
    return {
      id: n.id,
      type: n.type,
      state: n.state,
      title: n.next?.title ?? n.title,
      description: n.next?.description ?? n.description,
      area: areaOf(n),
      entry: entries.get(n.id) ?? [],
      aliases: [...(n.aliases ?? [])],
      headings: (headings.get(n.id) ?? []).filter((h) => (seen.get(h.toLowerCase()) ?? 0) <= common),
      paths: [...new Set([...(n.implements ?? []), ...(n.next?.implements ?? [])])],
      retired: isRetired(n),
      edges,
    };
  });
}

/** Reciprocal rank fusion constant: score = Σ 1 / (RRF_K + rank). */
export const RRF_K = 60;
/** Each half contributes at most this many ranked ids. */
export const FUSION_DEPTH = 50;
/** A semantic hit counts only within this cosine distance of the query's best hit. */
export const SEMANTIC_WINDOW = 0.12;
/**
 * Bonus for a node one belongs_to / depends_on / exposes / mounts link from a top-3 node: one rank
 * step at the top of the fused list, so it breaks near-ties toward the linked node and never
 * reorders a clear winner.
 */
export const GRAPH_BOOST = 1 / (RRF_K + 1) - 1 / (RRF_K + 2);
const BOOST_EDGES = new Set(["belongs_to", "depends_on", "exposes", "mounts"]);

/** A query that names a file or folder: one word with a slash, or ending in a file extension. */
function pathQuery(query: string): string | null {
  const q = query.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (/\s/.test(q)) return null;
  if (q.includes("/") || /\.[a-z0-9]{1,6}$/i.test(q)) return q.toLowerCase();
  return null;
}

function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}${glob.endsWith("/") ? "" : "$"}`);
}

/** How specific a claim is for a path query: its length when one contains the other, else 0. */
function pathMatch(claim: string, q: string): number {
  const c = claim.toLowerCase();
  if (c === q || c === `${q}/` || q === `${c}/`) return c.length + 1;
  if (c.endsWith("/") && q.startsWith(c)) return c.length;
  if (q.endsWith("/") && c.startsWith(q)) return q.length;
  if (/[*?]/.test(c) && globRegex(c).test(q)) return c.length;
  return 0;
}

/**
 * Fuse ranked id lists (best first) into one ranking: reciprocal rank fusion, then the graph
 * boost for nodes linked to the top 3 (only nodes some list already found, top-3 nodes linked to
 * each other included), then the path and exact-id shortcuts on top. Pure.
 */
export function fuseRankings(
  lists: string[][],
  opts: { docs: Map<string, SearchDoc>; exact?: string | null; paths?: string[] }
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.slice(0, FUSION_DEPTH).forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  const order = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top3 = order(scores)
    .slice(0, 3)
    .map(([id]) => id);
  // Each node one link from a top-3 node (another top-3 node included) gets the bonus once.
  const linked = new Set<string>();
  for (const id of top3) {
    for (const e of opts.docs.get(id)?.edges ?? []) {
      if (BOOST_EDGES.has(e.type) && e.target !== id) linked.add(e.target);
    }
  }
  for (const doc of opts.docs.values()) {
    if (doc.edges.some((e) => BOOST_EDGES.has(e.type) && e.target !== doc.id && top3.includes(e.target))) {
      linked.add(doc.id);
    }
  }
  const boosted = new Map(scores);
  for (const id of linked) {
    if (boosted.has(id)) boosted.set(id, boosted.get(id)! + GRAPH_BOOST);
  }
  // Shortcuts: a path match ranks above every fused score, an exact id above everything.
  const lift = (id: string, by: number) => boosted.set(id, (boosted.get(id) ?? 0) + by);
  (opts.paths ?? []).forEach((id, i) => lift(id, 1 - i / 1000));
  if (opts.exact) lift(opts.exact, 10);
  return order(boosted).map(([id, score]) => ({ id, score: Math.round(score * 1e5) / 1e5 }));
}

export interface SearchOptions {
  type?: NodeType;
  limit?: number;
  /**
   * The keyword half: FTS5 when the cache has it (`auto`, the default), else the JS BM25; `js`
   * always uses the JS BM25 (the eval measures it on every runtime).
   */
  keywordEngine?: "auto" | "js";
  /** Project root of the search cache. */
  root: string;
  /** Reads bodies for section headings. */
  readBody?: BodyReader;
  /**
   * Overrides the model: tests pass fixture vectors; null forces keyword-only. A given embedder
   * embeds every stale node before ranking.
   */
  embedder?: Embedder | null;
}

/**
 * Hybrid ranking of `graph` for `query`. The type filter applies first and retired nodes never
 * rank. Returns the `RankedMatch` shape of `rankNodes`. A cache or model problem never fails the
 * search: the keyword half falls back to token scoring and the semantic half is skipped.
 */
export async function searchNodes(
  graph: MindPlanGraph,
  query: string,
  opts: SearchOptions
): Promise<RankedMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_FIND_LIMIT, 1), MAX_FIND_LIMIT);
  const docs = searchDocs(graph, opts.readBody);
  const backend = await prepareSearch(
    opts.root,
    docs,
    opts.embedder !== undefined ? { embedder: opts.embedder, waitForVectors: true } : {}
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const candidates = new Set(
    docs.filter((d) => !d.retired && (!opts.type || d.type === opts.type)).map((d) => d.id)
  );

  let keyword: string[] | null = null;
  if (opts.keywordEngine !== "js") {
    try {
      keyword = backend.index?.keyword(q, candidates, FUSION_DEPTH, { type: opts.type }) ?? null;
    } catch (err) {
      // Another server may be rebuilding the file; this call ranks in JS instead.
      console.error(
        `MindPlan search: keyword query failed (${err instanceof Error ? err.message : String(err)}).`
      );
    }
  }
  // No FTS5 (Node 22.13's SQLite), no cache, or a failed query: the same BM25 in plain JS.
  keyword ??= keywordRankDocs(docs, q, candidates, FUSION_DEPTH);

  let semantic: string[] = [];
  if (backend.index && backend.embedder) {
    try {
      const [vector] = await backend.embedder.embed([q], "query");
      const hits = backend.index.semantic(vector, candidates, FUSION_DEPTH);
      const best = hits[0]?.score ?? 0;
      semantic = hits.filter((h) => h.score >= best - SEMANTIC_WINDOW).map((h) => h.id);
    } catch (err) {
      console.error(
        `MindPlan search: query embedding failed (${err instanceof Error ? err.message : String(err)}).`
      );
    }
  }

  const pq = pathQuery(q);
  const paths = pq
    ? [...candidates]
        .map((id) => ({ id, best: Math.max(0, ...docById.get(id)!.paths.map((c) => pathMatch(c, pq))) }))
        .filter((p) => p.best > 0)
        .sort((a, b) => b.best - a.best || a.id.localeCompare(b.id))
        .map((p) => p.id)
    : [];
  const qLower = q.toLowerCase();
  const exact = candidates.has(qLower) ? qLower : null;

  return fuseRankings([keyword, semantic], { docs: docById, exact, paths })
    .slice(0, limit)
    .map(({ id, score }) => ({ ...toSummary(byId.get(id)!), score, area: docById.get(id)!.area }));
}

/** After a graph write: sync the search cache now and embed what changed in the background. */
export function refreshSearchIndex(graph: MindPlanGraph, root: string, readBody?: BodyReader): void {
  try {
    refreshSearch(root, searchDocs(graph, readBody));
  } catch (err) {
    console.error(`MindPlan search: refresh failed (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/**
 * Server start: load the model in the background, then index and embed the whole graph as it is
 * once the model is ready. Never rejects; a tool call never waits on it.
 */
export function warmSearchIndex(
  root: string,
  loadGraph: () => MindPlanGraph,
  readBody?: BodyReader
): Promise<void> {
  return warmSearch(root, () => searchDocs(loadGraph(), readBody));
}
