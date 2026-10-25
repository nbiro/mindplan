/**
 * Read/orient MCP tool handlers — owned by i-orient-plan.
 * Return plain payloads; if-mcp-tools wraps with ok/guarded.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  isInactiveNode,
  isPipelineNodeType,
  type DecisionEntry,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeType,
} from "../../foundations/f-domain-model/types.js";
import { loadProjectBrief } from "../../foundations/f-territory-store/project.js";
import { projectVersionStatus } from "../../foundations/f-territory-store/version.js";
import {
  ATTACHMENTS_DIR,
  NEXT_ATTACHMENTS_DIR,
  entityRelativePath,
  markdownRelativePath,
  listAttachments,
  loadGraph,
  loadProjectConfig,
  nodeToRecord,
  projectRoot,
  readMarkdown,
  splitContext,
  summarizeGraphNode,
  territoryBodyReader,
  withoutOwnedSections,
} from "../../foundations/f-territory-store/store.js";
import { expandClaims } from "../../foundations/f-source-index/claims.js";
import { listResolvedImports } from "../../foundations/f-source-index/imports.js";
import {
  RETIRED_STATES,
  buildOwnershipIndex,
  exclusiveOwner,
  nodeOwnedFiles,
} from "../../foundations/f-source-index/ownership.js";
import {
  blocked,
  blastRadiusDependents,
  changeMembers,
  changeNeighbors,
  findNode,
  interactionReachability,
  interfacesExposing,
} from "../../foundations/f-compiler-rules/rules.js";
import {
  DEFAULT_FIND_LIMIT,
  findRelatedNodes,
  searchNodes,
} from "../../foundations/f-graph-search/search.js";
import { resolveNodeRules, rulesImpact } from "../../foundations/f-graph-search/rules.js";
import {
  listDecisions,
  nodeDecisions,
  resolveNodeDecisions,
  slotDecisions,
  supersessionIndex,
  type DecisionQueryOptions,
} from "../../foundations/f-graph-search/decisions.js";

export type AffectedFileVia = "focus" | "dependent" | "exposing" | "importer";

const VIA_ORDER: AffectedFileVia[] = ["focus", "dependent", "exposing", "importer"];

function isRetired(node: MindPlanNode): boolean {
  return RETIRED_STATES.has(node.state);
}

function fileExists(rel: string, root?: string): boolean {
  const cwd = root ?? projectRoot();
  const abs = path.join(cwd, ...rel.split("/"));
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

function filesPayload(
  entries: string[],
  root?: string
): { path: string; exists: boolean }[] {
  return entries.map((p) => ({ path: p, exists: fileExists(p, root) }));
}

function taggedFiles(
  node: MindPlanNode,
  root?: string
): { path: string; owner_id: string; owner_type: string; exists: boolean }[] {
  const owned = nodeOwnedFiles(node, root);
  const out = owned.files.map((p) => ({
    path: p,
    owner_id: node.id,
    owner_type: node.type,
    exists: fileExists(p, root),
  }));
  return out;
}

/** Reverse-depends_on blast radius; Interaction focus also includes reachability + affected_files. */
export function buildBlastRadiusPayload(
  graph: MindPlanGraph,
  node: MindPlanNode,
  opts: { include_retired?: boolean } = {}
): Record<string, unknown> {
  const includeRetired = opts.include_retired === true;
  const { affected: entries } = blastRadiusDependents(graph, node.id);
  const visibleEntries = includeRetired
    ? entries
    : entries.filter(({ node: n }) => !isRetired(n));

  const journeysAtRisk = new Set<string>();
  for (const { node: affected } of visibleEntries) {
    if (affected.type !== "Interaction") continue;
    for (const edge of graph.edges) {
      if (edge.source === affected.id && edge.type === "belongs_to") {
        journeysAtRisk.add(edge.target);
      }
    }
  }

  const root = projectRoot();
  type Group = {
    owner_id: string;
    owner_type: string;
    via: Set<AffectedFileVia>;
    files: Set<string>;
  };
  const groups = new Map<string, Group>();
  // The linked tests of every owner listed below: the suites a change to the focus should run.
  const tests = new Set<string>();

  const pushFiles = (owner: MindPlanNode, via: AffectedFileVia) => {
    if (!includeRetired && isRetired(owner)) return;
    for (const p of expandClaims(owner.tests, root)) tests.add(p);
    let group = groups.get(owner.id);
    if (!group) {
      group = {
        owner_id: owner.id,
        owner_type: owner.type,
        via: new Set(),
        files: new Set(),
      };
      groups.set(owner.id, group);
    }
    group.via.add(via);
    for (const p of expandClaims(owner.implements, root)) {
      group.files.add(p);
    }
    if (owner.next) {
      for (const p of expandClaims(owner.next.implements, root)) {
        group.files.add(p);
      }
    }
  };

  if (isPipelineNodeType(node.type)) {
    pushFiles(node, "focus");
  }
  // Walk all BFS entries (including retired) so importers/dependents behind them stay visible;
  // pushFiles skips retired owners unless include_retired.
  for (const { node: dep } of entries) {
    if (isPipelineNodeType(dep.type)) pushFiles(dep, "dependent");
  }

  if (node.type === "Interaction") {
    for (const iface of interfacesExposing(graph, node.id)) {
      pushFiles(iface, "exposing");
    }
  }

  // Importers: other nodes whose files import focus-owned files
  const focusFiles = new Set([
    ...expandClaims(node.implements, root),
    ...(node.next ? expandClaims(node.next.implements, root) : []),
  ]);
  if (focusFiles.size > 0) {
    for (const other of graph.nodes) {
      if (other.id === node.id || !isPipelineNodeType(other.type)) continue;
      const otherFiles = [
        ...expandClaims(other.implements, root),
        ...(other.next ? expandClaims(other.next.implements, root) : []),
      ];
      let importsFocus = false;
      for (const f of otherFiles) {
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) continue;
        for (const edge of listResolvedImports(f, root)) {
          if (focusFiles.has(edge.to)) {
            importsFocus = true;
            break;
          }
        }
        if (importsFocus) break;
      }
      if (importsFocus) pushFiles(other, "importer");
    }
  }

  const affected_files = [...groups.values()]
    .map((g) => ({
      owner_id: g.owner_id,
      owner_type: g.owner_type,
      via: VIA_ORDER.filter((v) => g.via.has(v)),
      files: [...g.files].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.owner_id.localeCompare(b.owner_id));

  const payload: Record<string, unknown> = {
    node_id: node.id,
    affected: visibleEntries.map(({ node: n, distance }) => ({
      id: n.id,
      type: n.type,
      state: n.state,
      distance,
    })),
    journeys_at_risk: [...journeysAtRisk].sort(),
    affected_files,
    tests: [...tests].sort((a, b) => a.localeCompare(b)),
    rules_impact: rulesImpact(graph, node),
    decisions: blastRadiusDecisions(graph, node, visibleEntries),
  };
  if (node.type === "Interaction") {
    const reach = interactionReachability(graph, node.id);
    const keep = (n: MindPlanNode) => includeRetired || !isRetired(n);
    payload.reachability = {
      exposing_interfaces: reach.exposing_interfaces
        .filter(keep)
        .map(summarizeGraphNode),
      containing_journeys: reach.containing_journeys
        .filter(keep)
        .map(summarizeGraphNode),
      leads_to_downstream: reach.leads_to_downstream
        .filter(({ node: n }) => keep(n))
        .map(({ node: n, distance }) => ({
          ...summarizeGraphNode(n),
          distance,
        })),
    };
  }
  return payload;
}

/** One active decision a change to the focus would reach. */
export type BlastRadiusDecision = {
  id: string;
  node_id: string;
  via: "focus" | "dependent";
  distance: number;
  decision: string;
};

/** Active decisions held by the focus (`focus`, 0) and by each visible dependent (`dependent`). */
function blastRadiusDecisions(
  graph: MindPlanGraph,
  focus: MindPlanNode,
  dependents: { node: MindPlanNode; distance: number }[]
): BlastRadiusDecision[] {
  const index = supersessionIndex(graph);
  const rows: BlastRadiusDecision[] = [];
  const push = (n: MindPlanNode, via: "focus" | "dependent", distance: number) => {
    // A retired node's decisions constrain no live code, even when include_retired shows the node.
    if (isInactiveNode(n)) return;
    for (const d of nodeDecisions(graph, n, {}, index)) {
      rows.push({ id: d.id, node_id: n.id, via, distance, decision: d.decision });
    }
  };
  push(focus, "focus", 0);
  for (const { node: n, distance } of dependents) push(n, "dependent", distance);
  return rows;
}

/**
 * Territory context of one node: the live body and the open next body without the Rules and
 * Decisions sections, which come back separately (`rules`, `decisions`, `next.decisions`).
 * Superseded decisions are left out of both lists unless `include_superseded`, the same default
 * as `list_decisions` and `orient_for_work`, so a long trail does not bury what currently applies.
 */
export function buildNodeContextPayload(
  graph: MindPlanGraph,
  node: MindPlanNode,
  opts: DecisionQueryOptions = {}
): Record<string, unknown> {
  const rel = entityRelativePath(node);
  const currentRaw = readMarkdown(node, "current");
  const currentSplit = splitContext(currentRaw);
  // One supersession index serves both slots.
  const index = supersessionIndex(graph);
  const payload: Record<string, unknown> = {
    folder: rel,
    current_path: markdownRelativePath(node, "current"),
    attachments_path: `${rel}/${ATTACHMENTS_DIR}`,
    attachments: listAttachments(node),
    record: nodeToRecord(node),
    // The Rules and Decisions sections are returned separately; each has its own writer.
    body: withoutOwnedSections(currentSplit?.body ?? ""),
    rules: node.rules ?? "",
    decisions: slotDecisions(graph, node, "current", opts, index),
    next: null,
  };
  if (node.next) {
    const nextRaw = readMarkdown(node, "next");
    const nextSplit = splitContext(nextRaw);
    payload.next_path = markdownRelativePath(node, "next");
    payload.next_attachments_path = `${rel}/${NEXT_ATTACHMENTS_DIR}`;
    payload.next = {
      record: {
        state: node.next.state,
        title: node.next.title,
        description: node.next.description,
        updated_at: node.next.updated_at,
        ...(node.next.opened_at ? { opened_at: node.next.opened_at } : {}),
        ...(node.next.belongs_to?.length ? { belongs_to: node.next.belongs_to } : {}),
        ...(node.next.depends_on?.length ? { depends_on: node.next.depends_on } : {}),
        ...(node.next.exposes?.length ? { exposes: node.next.exposes } : {}),
        ...(node.next.leads_to?.length ? { leads_to: node.next.leads_to } : {}),
        ...(node.next.implements?.length ? { implements: node.next.implements } : {}),
        ...(node.next.role ? { role: node.next.role } : {}),
        ...(node.next.change ? { change: node.next.change } : {}),
        ...(node.next.change_ref ? { change_ref: node.next.change_ref } : {}),
      },
      body: withoutOwnedSections(nextSplit?.body ?? ""),
      decisions: slotDecisions(graph, node, "next", opts, index),
    };
  }
  return payload;
}

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

/** Hybrid-ranked matches for a query over the loaded graph (`[]` without a query). */
async function rankedMatches(
  graph: MindPlanGraph,
  query: string,
  args: { type?: NodeType; limit?: number }
): Promise<Awaited<ReturnType<typeof searchNodes>>> {
  if (!query) return [];
  return searchNodes(graph, query, {
    type: args.type,
    limit: args.limit ?? DEFAULT_FIND_LIMIT,
    root: projectRoot(),
    readBody: territoryBodyReader(),
  });
}

export async function findRelatedNodesHandler(args: {
  query?: string;
  node_id?: string;
  type?: NodeType;
  limit?: number;
}): Promise<ReturnType<typeof findRelatedNodes>> {
  const q = (args.query ?? "").trim();
  if (!q && !args.node_id) {
    throw blocked('find_related_nodes requires a non-empty "query" and/or "node_id".');
  }
  const graph = loadGraph();
  if (args.node_id) {
    findNode(graph, args.node_id);
  }
  return findRelatedNodes(graph, {
    query: q,
    node_id: args.node_id,
    type: args.type,
    limit: args.limit ?? DEFAULT_FIND_LIMIT,
    matches: await rankedMatches(graph, q, args),
  });
}

export function getBlastRadius(args: {
  node_id?: string;
  change?: string;
  include_retired?: boolean;
}): Record<string, unknown> {
  if ((args.node_id === undefined) === (args.change === undefined)) {
    throw blocked('get_blast_radius takes exactly one of "node_id" or "change".');
  }
  const graph = loadGraph();
  if (args.change !== undefined) {
    return buildChangeBlastRadiusPayload(graph, args.change, {
      include_retired: args.include_retired,
    });
  }
  const node = findNode(graph, args.node_id!);
  return buildBlastRadiusPayload(graph, node, {
    include_retired: args.include_retired,
  });
}

/**
 * Blast radius of a whole change: the radii of its members (open revisions and neighbors, the
 * shipped nodes it edits in place) merged. `affected` keeps each node's smallest distance and
 * leaves out the members themselves; files group by owner.
 */
export function buildChangeBlastRadiusPayload(
  graph: MindPlanGraph,
  change: string,
  opts: { include_retired?: boolean } = {}
): Record<string, unknown> {
  const revisions = changeMembers(graph, change);
  const neighbors = changeNeighbors(graph, change);
  const members = [...revisions, ...neighbors];
  if (members.length === 0) {
    throw blocked(
      `change "${change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
    );
  }
  const neighborIds = new Set(neighbors.map((n) => n.id));
  const memberIds = new Set(members.map((m) => m.id));
  const affected = new Map<string, { id: string; type: string; state: string; distance: number }>();
  const journeys = new Set<string>();
  const files = new Map<string, { owner_id: string; owner_type: string; via: Set<string>; files: Set<string> }>();
  const rulesReach = new Map<string, unknown>();
  const decisions = new Map<string, BlastRadiusDecision>();
  const tests = new Set<string>();
  for (const member of members) {
    const one = buildBlastRadiusPayload(graph, member, opts);
    for (const row of one.affected as { id: string; type: string; state: string; distance: number }[]) {
      if (memberIds.has(row.id)) continue;
      const prev = affected.get(row.id);
      if (!prev || row.distance < prev.distance) affected.set(row.id, row);
    }
    for (const j of one.journeys_at_risk as string[]) journeys.add(j);
    for (const group of one.affected_files as {
      owner_id: string;
      owner_type: string;
      via: string[];
      files: string[];
    }[]) {
      let merged = files.get(group.owner_id);
      if (!merged) {
        merged = { owner_id: group.owner_id, owner_type: group.owner_type, via: new Set(), files: new Set() };
        files.set(group.owner_id, merged);
      }
      for (const v of group.via) merged.via.add(v);
      for (const f of group.files) merged.files.add(f);
    }
    for (const t of one.tests as string[]) tests.add(t);
    rulesReach.set(member.id, one.rules_impact);
    for (const row of one.decisions as BlastRadiusDecision[]) {
      // A member's own decisions are "focus"; otherwise keep the smallest distance.
      const asFocus = memberIds.has(row.node_id) ? { ...row, via: "focus" as const, distance: 0 } : row;
      const prev = decisions.get(row.id);
      if (!prev || asFocus.distance < prev.distance) decisions.set(row.id, asFocus);
    }
  }
  return {
    change,
    members: members.map((m) => ({
      id: m.id,
      type: m.type,
      kind: neighborIds.has(m.id) ? "neighbor" : "revision",
      state: m.state,
      next_state: m.next?.state ?? null,
    })),
    affected: [...affected.values()].sort(
      (a, b) => a.distance - b.distance || a.id.localeCompare(b.id)
    ),
    journeys_at_risk: [...journeys].sort(),
    affected_files: [...files.values()]
      .map((g) => ({
        owner_id: g.owner_id,
        owner_type: g.owner_type,
        via: VIA_ORDER.filter((v) => g.via.has(v)),
        files: [...g.files].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.owner_id.localeCompare(b.owner_id)),
    tests: [...tests].sort((a, b) => a.localeCompare(b)),
    rules_impact: Object.fromEntries(rulesReach),
    decisions: [...decisions.values()].sort(
      (a, b) => a.distance - b.distance || a.node_id.localeCompare(b.node_id)
    ),
  };
}

export function getNodeContext(args: {
  node_id: string;
  include_superseded?: boolean;
}): Record<string, unknown> {
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  return buildNodeContextPayload(graph, node, { include_superseded: args.include_superseded });
}

/**
 * Decision entries for orient_for_work. Orientation runs before every action, so `depth: "rules"`
 * keeps each entry to what stops a simplification (the decision and why) and its label; `body`
 * and `full` carry the whole record. `list_decisions` always returns whole records.
 */
function orientDecisionEntries(entries: DecisionEntry[], depth: OrientDepth): unknown[] {
  if (depth !== "rules") return entries;
  return entries.map((e) => ({
    id: e.id,
    decision: e.decision,
    why: e.why,
    node_id: e.node_id,
    node_type: e.node_type,
    via: e.via,
    distance: e.distance,
    status: e.status,
    ...(e.superseded_by ? { superseded_by: e.superseded_by } : {}),
  }));
}

/** How much orient_for_work returns: rules + record, plus the body, or everything. */
export const ORIENT_DEPTHS = ["rules", "body", "full"] as const;
export type OrientDepth = (typeof ORIENT_DEPTHS)[number];

export async function orientForWork(args: {
  query?: string;
  node_id?: string;
  type?: NodeType;
  limit?: number;
  depth?: OrientDepth;
  include_superseded?: boolean;
}): Promise<Record<string, unknown>> {
  const depth: OrientDepth = args.depth ?? "full";
  if (!(ORIENT_DEPTHS as readonly string[]).includes(depth)) {
    throw blocked(`orient_for_work depth must be one of: ${ORIENT_DEPTHS.join(", ")}.`);
  }
  const q = (args.query ?? "").trim();
  if (!q && !args.node_id) {
    throw blocked('orient_for_work requires a non-empty "query" and/or "node_id".');
  }
  const graph = loadGraph();
  if (args.node_id) {
    findNode(graph, args.node_id);
  }
  const related = findRelatedNodes(graph, {
    query: q,
    node_id: args.node_id,
    type: args.type,
    limit: args.limit ?? DEFAULT_FIND_LIMIT,
    matches: await rankedMatches(graph, q, args),
  });
  let context: Record<string, unknown> | null = null;
  let blast_radius: Record<string, unknown> | null = null;
  let rules: Record<string, unknown> | null = null;
  let decisions: Record<string, unknown> | null = null;

  if (related.focus) {
    const node = findNode(graph, related.focus);
    context = buildNodeContextPayload(graph, node, { include_superseded: args.include_superseded });
    rules = { node_id: node.id, entries: resolveNodeRules(graph, node.id) };
    decisions = {
      node_id: node.id,
      entries: orientDecisionEntries(
        resolveNodeDecisions(graph, node.id, { include_superseded: args.include_superseded }),
        depth
      ),
    };
    if (depth === "full" && isPipelineNodeType(node.type)) {
      blast_radius = buildBlastRadiusPayload(graph, node);
    }
  }

  if (depth === "full") {
    return { ...related, context, blast_radius, rules, decisions };
  }
  // Lighter depths keep the ranked matches and the focus, not the neighborhood or blast radius.
  const slim: Record<string, unknown> = {
    query: related.query,
    matches: related.matches,
    focus: related.focus,
    rules,
    decisions,
  };
  if (context) {
    if (depth === "body") {
      slim.context = context;
    } else {
      const next = context.next as { record?: unknown } | null;
      slim.context = { record: context.record, next: next ? { record: next.record } : null };
    }
  } else {
    slim.context = null;
  }
  return slim;
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

/**
 * Declared file ownership query. Optional `path` returns the owning node.
 */
export function getNodeImplementationHandler(args: {
  node_id?: string;
  path?: string;
}): Record<string, unknown> {
  loadProjectConfig();
  const graph = loadGraph();
  const root = projectRoot();

  if (args.path) {
    const rel = args.path.replace(/\\/g, "/").replace(/^\.\//, "");
    const buckets = buildOwnershipIndex(graph, root);
    const ownerId = exclusiveOwner(buckets, rel);
    if (!ownerId) {
      return { path: rel, owner: null };
    }
    const owner = findNode(graph, ownerId);
    return {
      path: rel,
      owner: {
        node_id: owner.id,
        type: owner.type,
        state: owner.state,
        role: owner.role ?? null,
      },
    };
  }

  if (!args.node_id) {
    throw blocked('get_node_implementation requires "node_id" or "path".');
  }

  const node = findNode(graph, args.node_id);

  if (node.type === "Journey") {
    const interactions = graph.edges
      .filter((e) => e.type === "belongs_to" && e.target === node.id)
      .map((e) => findNode(graph, e.source))
      .filter((n) => n.type === "Interaction");
    const files: {
      path: string;
      owner_id: string;
      owner_type: string;
      exists: boolean;
    }[] = [];
    const seenIfaces = new Set<string>();
    for (const ix of interactions) {
      files.push(...taggedFiles(ix, root));
      for (const iface of interfacesExposing(graph, ix.id)) {
        if (seenIfaces.has(iface.id)) continue;
        seenIfaces.add(iface.id);
        files.push(...taggedFiles(iface, root));
      }
    }
    return { node_id: node.id, type: "Journey", files };
  }

  if (node.type === "Bug") {
    const files: {
      path: string;
      owner_id: string;
      owner_type: string;
      exists: boolean;
    }[] = [];
    for (const tid of node.affects ?? []) {
      const target = findNode(graph, tid);
      if (isPipelineNodeType(target.type)) {
        files.push(...taggedFiles(target, root));
      }
    }
    return { node_id: node.id, type: "Bug", files };
  }

  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `get_node_implementation does not apply to ${node.type} "${node.id}" without path lookup.`
    );
  }

  const owned = nodeOwnedFiles(node, root);
  const result: Record<string, unknown> = {
    node_id: node.id,
    files: filesPayload(owned.files, root),
  };
  if (owned.next_files) {
    result.next_files = filesPayload(owned.next_files, root);
  }
  return result;
}

/**
 * Resolve the bundled systems dialect at templates/agent/playbook.md.
 * Walks up from this module to the package root (same layout as the npm package).
 */
function loadBundledPlaybook(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "templates", "agent", "playbook.md");
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf-8");
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw blocked(
      `get_project could not read the bundled playbook (${message}). Reinstall mindplan-mcp so templates/agent/playbook.md is present.`
    );
  }
  throw blocked(
    "get_project could not find templates/agent/playbook.md. Reinstall mindplan-mcp so the systems dialect ships with the package."
  );
}

/** Names the integrity check where an agent cannot miss it: get_project is read first. */
export const CHECK_HINT =
  "Run the check with the run_check tool (CLI: mindplan-mcp check) before self-ready, in-review, ship / resolved, " +
  "and before saying the work is done. It must pass; moves to in-review and ship also run its import and ownership rules on the node's files.";

/**
 * Project brief (description + rules) plus the bundled systems dialect (playbook).
 * `version` is the stamp warning, present only when mindplan/version.json is not current.
 * Call before the first answer or code change; call again after description/rules change.
 */
export function getProject(): Record<string, unknown> {
  const brief = loadProjectBrief();
  const version = projectVersionStatus();
  return {
    path: brief.path,
    description: brief.description,
    rules: brief.rules,
    playbook: loadBundledPlaybook(),
    check: CHECK_HINT,
    ...(version.warning ? { version: version.warning } : {}),
  };
}

/**
 * Mandatory project rules only — call before each action, before orient_for_work.
 */
export function getRules(): Record<string, unknown> {
  const brief = loadProjectBrief();
  return {
    path: brief.path,
    rules: brief.rules,
  };
}
