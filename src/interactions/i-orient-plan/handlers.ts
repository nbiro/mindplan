/**
 * Read/orient MCP tool handlers — owned by i-orient-plan.
 * Return plain payloads; if-mcp-tools wraps with ok/guarded.
 */

import { createHash } from "crypto";
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
  readSectionFromBody,
  normalizeHeadingName,
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
  areaMembers,
  expandNeighborhood,
  findRelatedNodes,
  searchNodes,
} from "../../foundations/f-graph-search/search.js";
import { reachingRules, recordOriented } from "../../foundations/f-orientation-ledger/ledger.js";
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
  opts: { include_retired?: boolean; include_dependent_decisions?: boolean } = {}
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
    ...blastRadiusDecisions(graph, node, visibleEntries, opts.include_dependent_decisions === true),
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

/** How many active decisions the dependents hold, and on which nodes (nearest first). */
export type DependentDecisionsSummary = { count: number; nodes: string[] };

/**
 * Active decisions held by the focus (`focus`, 0), plus `dependent_decisions` (the count and holding
 * nodes of every visible dependent's). The dependents' own rows (`dependent`) join `decisions` only
 * with `includeDependents`: the summary says whose reasoning a change reaches, the rows on request.
 */
function blastRadiusDecisions(
  graph: MindPlanGraph,
  focus: MindPlanNode,
  dependents: { node: MindPlanNode; distance: number }[],
  includeDependents: boolean
): { decisions: BlastRadiusDecision[]; dependent_decisions: DependentDecisionsSummary } {
  const index = supersessionIndex(graph);
  const rows: BlastRadiusDecision[] = [];
  const summary: DependentDecisionsSummary = { count: 0, nodes: [] };
  const push = (n: MindPlanNode, via: "focus" | "dependent", distance: number) => {
    // A retired node's decisions constrain no live code, even when include_retired shows the node.
    if (isInactiveNode(n)) return;
    const held = nodeDecisions(graph, n, {}, index);
    if (via === "dependent" && held.length > 0) {
      summary.count += held.length;
      summary.nodes.push(n.id);
      if (!includeDependents) return;
    }
    for (const d of held) {
      rows.push({ id: d.id, node_id: n.id, via, distance, decision: d.decision });
    }
  };
  push(focus, "focus", 0);
  for (const { node: n, distance } of dependents) push(n, "dependent", distance);
  return { decisions: rows, dependent_decisions: summary };
}

/** Inherited decisions of a node: how many, on which nodes (nearest first), and the entries on request. */
export type InheritedDecisionsSummary = { count: number; nodes: string[]; entries?: unknown[] };

/**
 * A node's decisions split into its own and the inherited ones (`belongs_to` / `depends_on`, and
 * for a Bug everything past the nodes it affects directly, whose own decisions count as the Bug's).
 * `selfOnly` keeps a Bug's affected nodes in the inherited side instead: `get_node_context` lists
 * only the node's own file, so they belong with the inherited decisions there. The inherited
 * summary lists entries only with `include_inherited_decisions`: whole records at distance 1
 * (compact at `depth: "rules"`), one line `{ id, node_id, distance, decision }` beyond, which
 * names `status` and `superseded_by` when the decision is superseded.
 */
function splitNodeDecisions(
  graph: MindPlanGraph,
  node: MindPlanNode,
  opts: DecisionQueryOptions & { include_inherited_decisions?: boolean; selfOnly?: boolean },
  depth: OrientDepth = "full"
): { own: unknown[]; inherited_decisions: InheritedDecisionsSummary } {
  const all = resolveNodeDecisions(graph, node.id, { include_superseded: opts.include_superseded });
  const isOwn = (e: DecisionEntry) =>
    e.via === "self" ||
    (!opts.selfOnly && node.type === "Bug" && e.via === "affects" && e.distance === 1);
  const own = all.filter(isOwn);
  const inherited = all.filter((e) => !isOwn(e));
  const summary: InheritedDecisionsSummary = {
    count: inherited.length,
    nodes: [...new Set(inherited.map((e) => e.node_id))],
  };
  if (opts.include_inherited_decisions) {
    summary.entries = inherited.map((e) =>
      (e.distance ?? 0) <= 1
        ? orientDecisionEntries([e], depth)[0]
        : {
            id: e.id,
            node_id: e.node_id,
            distance: e.distance,
            decision: e.decision,
            ...(e.status === "superseded" ? { status: e.status, superseded_by: e.superseded_by } : {}),
          }
    );
  }
  return { own: orientDecisionEntries(own, depth), inherited_decisions: summary };
}

/** Which territory slot a node read returns; omitted means both (get_node_context). */
export const CONTEXT_SLOTS = ["current", "next"] as const;
export type ContextSlot = (typeof CONTEXT_SLOTS)[number];

/**
 * Territory context of one node: the live body and the open next body without the Rules and
 * Decisions sections, which come back separately (`rules`, `decisions`, `next.decisions`).
 * Superseded decisions are left out of both lists unless `include_superseded`, the same default
 * as `list_decisions` and `orient_for_work`, so a long trail does not bury what currently applies.
 * `slot` returns one slot's body and decisions (the other slot's record stays, so the caller knows
 * a revision is open); `section` cuts each returned body to one level-2 section, so a large node
 * can be read a section at a time.
 */
export function buildNodeContextPayload(
  graph: MindPlanGraph,
  node: MindPlanNode,
  opts: DecisionQueryOptions & {
    inherited?: boolean;
    include_inherited_decisions?: boolean;
    slot?: ContextSlot;
    section?: string;
    /** Leave the slots' decisions out (orient_for_work carries them in its own decisions block). */
    omitDecisions?: boolean;
  } = {}
): Record<string, unknown> {
  if (opts.slot === "next" && !node.next) {
    throw blocked(`"${node.id}" has no open revision; read slot "current", or open_next first.`);
  }
  const withCurrent = opts.slot !== "next";
  const withNextBody = opts.slot !== "current";
  // A heading missing from one slot names that slot: a section new in the revision is only in next.
  const cut = (body: string, slot: ContextSlot) => {
    if (!opts.section) return body;
    try {
      return readSectionFromBody(body, opts.section);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message.replace(/^Blocked: /, `Blocked: ${slot} slot: `));
    }
  };
  const rel = entityRelativePath(node);
  // One supersession index serves both slots.
  const index = opts.omitDecisions ? null : supersessionIndex(graph);
  const payload: Record<string, unknown> = {
    folder: rel,
    current_path: markdownRelativePath(node, "current"),
    attachments_path: `${rel}/${ATTACHMENTS_DIR}`,
    attachments: listAttachments(node),
    record: nodeToRecord(node),
  };
  if (opts.section) payload.section = `## ${normalizeHeadingName(opts.section)}`;
  if (withCurrent) {
    const currentSplit = splitContext(readMarkdown(node, "current"));
    // The Rules and Decisions sections are returned separately; each has its own writer.
    payload.body = cut(withoutOwnedSections(currentSplit?.body ?? ""), "current");
  }
  payload.rules = node.rules ?? "";
  if (withCurrent && index) payload.decisions = slotDecisions(graph, node, "current", opts, index);
  payload.next = null;
  // get_node_context names the inherited decisions; orient_for_work carries them in its decisions block.
  if (opts.inherited) {
    payload.inherited_decisions = splitNodeDecisions(graph, node, { ...opts, selfOnly: true }).inherited_decisions;
  }
  if (node.next) {
    payload.next_path = markdownRelativePath(node, "next");
    payload.next_attachments_path = `${rel}/${NEXT_ATTACHMENTS_DIR}`;
    const record = {
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
    };
    if (withNextBody) {
      const nextSplit = splitContext(readMarkdown(node, "next"));
      payload.next = {
        record,
        body: cut(withoutOwnedSections(nextSplit?.body ?? ""), "next"),
        ...(index ? { decisions: slotDecisions(graph, node, "next", opts, index) } : {}),
      };
    } else {
      payload.next = { record };
    }
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

/** The Journey an `area` names; Blocked when it is not a Journey. */
function assertArea(graph: MindPlanGraph, area: string | undefined): void {
  if (area === undefined) return;
  const node = findNode(graph, area);
  if (node.type !== "Journey") {
    throw blocked(`area must be a Journey id (list_areas lists them); "${area}" is a ${node.type}.`);
  }
}

/** Hybrid-ranked matches for a query over the loaded graph (`[]` without a query). */
async function rankedMatches(
  graph: MindPlanGraph,
  query: string,
  args: { type?: NodeType; limit?: number; area?: string }
): Promise<Awaited<ReturnType<typeof searchNodes>>> {
  if (!query) return [];
  return searchNodes(graph, query, {
    type: args.type,
    area: args.area,
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
  area?: string;
}): Promise<ReturnType<typeof findRelatedNodes>> {
  const q = (args.query ?? "").trim();
  if (!q && !args.node_id) {
    throw blocked('find_related_nodes requires a non-empty "query" and/or "node_id".');
  }
  const graph = loadGraph();
  if (args.node_id) {
    findNode(graph, args.node_id);
  }
  assertArea(graph, args.area);
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
  include_dependent_decisions?: boolean;
}): Record<string, unknown> {
  if ((args.node_id === undefined) === (args.change === undefined)) {
    throw blocked('get_blast_radius takes exactly one of "node_id" or "change".');
  }
  const graph = loadGraph();
  if (args.change !== undefined) {
    return buildChangeBlastRadiusPayload(graph, args.change, {
      include_retired: args.include_retired,
      include_dependent_decisions: args.include_dependent_decisions,
    });
  }
  const node = findNode(graph, args.node_id!);
  return buildBlastRadiusPayload(graph, node, {
    include_retired: args.include_retired,
    include_dependent_decisions: args.include_dependent_decisions,
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
  opts: { include_retired?: boolean; include_dependent_decisions?: boolean } = {}
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
  const dependentHolders = new Map<string, { count: number; distance: number }>();
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
    // Each holder that is not a member counts once, at its smallest distance from any member.
    const distances = new Map(
      (one.affected as { id: string; distance: number }[]).map((row) => [row.id, row.distance])
    );
    const counts = new Map<string, number>();
    for (const row of one.decisions as BlastRadiusDecision[]) {
      if (row.via === "dependent") counts.set(row.node_id, (counts.get(row.node_id) ?? 0) + 1);
    }
    for (const id of (one.dependent_decisions as DependentDecisionsSummary).nodes) {
      if (memberIds.has(id)) continue;
      const distance = distances.get(id) ?? Number.MAX_SAFE_INTEGER;
      const prev = dependentHolders.get(id);
      const count = counts.get(id) ?? prev?.count ?? nodeDecisions(graph, findNode(graph, id)).length;
      if (!prev || distance < prev.distance) dependentHolders.set(id, { count, distance });
    }
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
    dependent_decisions: {
      count: [...dependentHolders.values()].reduce((sum, h) => sum + h.count, 0),
      nodes: [...dependentHolders.entries()]
        .sort((a, b) => a[1].distance - b[1].distance || a[0].localeCompare(b[0]))
        .map(([id]) => id),
    },
  };
}

export function getNodeContext(args: {
  node_id: string;
  include_superseded?: boolean;
  include_inherited_decisions?: boolean;
  slot?: ContextSlot;
  section?: string;
}): Record<string, unknown> {
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  const payload = buildNodeContextPayload(graph, node, {
    include_superseded: args.include_superseded,
    inherited: true,
    include_inherited_decisions: args.include_inherited_decisions,
    slot: args.slot,
    section: args.section,
  });
  // It counts as orienting on the node, so it carries every rule that reaches it, not only its own.
  payload.resolved_rules = { node_id: node.id, entries: reachingRules(graph, node.id) };
  recordOriented(graph, [node.id]);
  return payload;
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

/** Rows a query-only orient_for_work returns by default. */
export const ORIENT_SUMMARY_LIMIT = 8;
/** A summary row's description is cut to this many characters (descriptions are search rows). */
export const ROW_DESCRIPTION_CHARS = 70;

/** One ranked row of a query-only orient_for_work: enough to pick the node to open. */
export type OrientRow = {
  id: string;
  type: string;
  state: string;
  title: string;
  description: string;
  /** Journey titles; omitted when the node belongs to none. */
  area?: string[];
  score: number;
};

function orientRow(match: Awaited<ReturnType<typeof searchNodes>>[number]): OrientRow {
  const description =
    match.description.length > ROW_DESCRIPTION_CHARS
      ? `${match.description.slice(0, ROW_DESCRIPTION_CHARS - 1).trimEnd()}…`
      : match.description;
  return {
    id: match.id,
    type: match.type,
    state: match.state,
    title: match.title,
    description,
    ...(match.area?.length ? { area: match.area } : {}),
    score: match.score,
  };
}

/**
 * Whether the top match is clearly the node the query means: the query is its exact id, it is the
 * only match, or its fused score is at least twice the next one's.
 */
function clearWinner(matches: Awaited<ReturnType<typeof searchNodes>>, query: string): boolean {
  if (matches.length === 0) return false;
  if (matches[0].id === query.trim().toLowerCase() || matches.length === 1) return true;
  return matches[0].score >= 2 * matches[1].score;
}

/**
 * Summary first. With only a `query`, orient_for_work returns ranked rows (`OrientRow`, no body,
 * neighborhood, blast radius, rules, or decisions) and the agent picks one; when the top row is a
 * clear winner the full node comes back with them (`auto_focus: true`). With `node_id` it returns
 * that node in full at `depth`: record, body, its rules, its own decisions, owned files, and at
 * `full` the neighborhood and blast radius. Every full reply records the node in the orientation
 * ledger, which is what lets writes on it through.
 */
export async function orientForWork(args: {
  query?: string;
  node_id?: string;
  type?: NodeType;
  limit?: number;
  depth?: OrientDepth;
  include_superseded?: boolean;
  include_inherited_decisions?: boolean;
  known_rules_versions?: Record<string, string>;
  area?: string;
  slot?: ContextSlot;
  section?: string;
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
  assertArea(graph, args.area);
  const limit = args.limit ?? (args.node_id ? DEFAULT_FIND_LIMIT : ORIENT_SUMMARY_LIMIT);
  // One extra match decides "the only match" and "twice the next" whatever the row limit.
  const ranked = await rankedMatches(graph, q, { type: args.type, limit: limit + 1, area: args.area });
  const matches = ranked.slice(0, limit);
  const rows = matches.map(orientRow);

  let focus = args.node_id ?? null;
  const autoFocus = !focus && clearWinner(ranked, q);
  if (autoFocus) focus = matches[0].id;
  if (!focus) {
    return {
      query: q,
      matches: rows,
      focus: null,
      next: rows.length ? 'orient_for_work({ node_id: "<row id>" })' : "No match: refine the query, or create_node.",
    };
  }

  const node = findNode(graph, focus);
  // The body comes from the active slot unless the caller names one; depth "rules" returns no body,
  // so it reads the live slot only (its next record comes back without the next body).
  // The decisions block is the reply's one copy of the focus's decisions.
  const context = buildNodeContextPayload(
    graph,
    node,
    depth === "rules"
      ? { slot: "current", omitDecisions: true }
      : { slot: args.slot ?? (node.next ? "next" : "current"), section: args.section, omitDecisions: true }
  );
  const rules = {
    node_id: node.id,
    entries: versionedRuleEntries(reachingRules(graph, node.id), args.known_rules_versions),
  };
  const split = splitNodeDecisions(graph, node, args, depth);
  const decisions = { node_id: node.id, entries: split.own, inherited_decisions: split.inherited_decisions };
  recordOriented(graph, [node.id]);

  const reply: Record<string, unknown> = {
    query: q,
    matches: rows,
    focus: node.id,
    ...(autoFocus ? { auto_focus: true } : {}),
    rules,
    decisions,
  };
  if (depth === "rules") {
    const next = context.next as { record?: unknown } | null;
    reply.context = { record: context.record, next: next ? { record: next.record } : null };
    return reply;
  }
  reply.context = context;
  if (isPipelineNodeType(node.type)) {
    const owned = nodeOwnedFiles(node, projectRoot());
    reply.files = { files: owned.files, ...(owned.next_files ? { next_files: owned.next_files } : {}) };
  }
  if (depth === "full") {
    const { nodes, edges } = expandNeighborhood(graph, node.id);
    reply.nodes = nodes;
    reply.edges = edges;
    reply.blast_radius = isPipelineNodeType(node.type) ? buildBlastRadiusPayload(graph, node) : null;
  }
  return reply;
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
 * Short tag of a rules text (12 hex chars of its SHA-256): equal tags mean equal text, so a caller
 * that already holds the text can skip it.
 */
export function rulesVersion(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

/**
 * Node rule entries with their `version`; an entry whose version the caller already knows
 * (`known[node_id]`) leaves its text out and says `unchanged: true`.
 */
function versionedRuleEntries(
  entries: ReturnType<typeof resolveNodeRules>,
  known: Record<string, string> | undefined
): Record<string, unknown>[] {
  return entries.map((entry) => {
    const version = rulesVersion(entry.rules);
    if (known?.[entry.node_id] === version) {
      const { rules: _text, ...rest } = entry;
      return { ...rest, version, unchanged: true };
    }
    return { ...entry, version };
  });
}

/**
 * Project brief (description + rules) plus the bundled systems dialect (playbook).
 * `rules_version` tags the rules, so the first `get_rules` of a session can already pass it.
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
    rules_version: rulesVersion(brief.rules),
    playbook: loadBundledPlaybook(),
    check: CHECK_HINT,
    ...(version.warning ? { version: version.warning } : {}),
  };
}

/**
 * Mandatory project rules only — call before each action, before orient_for_work.
 * `{ path, rules, rules_version }`; with a `known_version` equal to the current tag, the text is
 * left out: `{ path, rules_version, unchanged: true }`.
 */
export function getRules(args: { known_version?: string } = {}): Record<string, unknown> {
  const brief = loadProjectBrief();
  const rules_version = rulesVersion(brief.rules);
  if (args.known_version !== undefined && args.known_version === rules_version) {
    return { path: brief.path, rules_version, unchanged: true };
  }
  return {
    path: brief.path,
    rules: brief.rules,
    rules_version,
  };
}
