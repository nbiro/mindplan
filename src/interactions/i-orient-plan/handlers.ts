/**
 * Orient on the plan — owned by i-orient-plan: orient_for_work (ranked rows, a full node, a whole
 * change), get_node_context, get_node_implementation, and find_related_nodes.
 */

import {
  isPipelineNodeType,
  type DecisionEntry,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeType,
  type RuleEntry,
} from "../../foundations/f-domain-model/types.js";
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
  territoryBodyReader,
  withoutOwnedSections,
} from "../../foundations/f-territory-store/store.js";
import { hotspotSettings } from "../../foundations/f-source-index/config.js";
import { fanOut } from "../../foundations/f-fan-out/index.js";
import {
  fanIn,
  hotspotFor,
  hotspotWarning,
  recentRate,
  hotspotContext,
} from "../../foundations/f-compiler-rules/open-closed.js";
import { buildOwnershipIndex, exclusiveOwner, nodeOwnedFiles } from "../../foundations/f-source-index/ownership.js";
import { blocked, findNode, interfacesExposing } from "../../foundations/f-compiler-rules/rules.js";
import {
  DEFAULT_FIND_LIMIT,
  expandNeighborhood,
  findRelatedNodes,
  searchNodes,
} from "../../foundations/f-graph-search/search.js";
import { shapeReport } from "../../foundations/f-compiler-rules/shape.js";
import { changeMembership } from "../../foundations/f-compiler-rules/planned.js";
import { reachingRules, recordOriented } from "../../foundations/f-orientation-ledger/ledger.js";
import { resolveNodeRules } from "../../foundations/f-graph-search/rules.js";
import {
  listDecisions,
  nodeDecisions,
  resolveNodeDecisions,
  slotDecisions,
  supersessionIndex,
  type DecisionQueryOptions,
} from "../../foundations/f-graph-search/decisions.js";
import * as fs from "fs";
import * as path from "path";
import {
  buildBlastRadiusPayload,
  rulesVersion,
} from "../../foundations/f-plan-views/views.js";

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

/** The Capability an `area` names; Blocked when it is not a Capability. */
function assertArea(graph: MindPlanGraph, area: string | undefined): void {
  if (area === undefined) return;
  const node = findNode(graph, area);
  if (node.type !== "Capability") {
    throw blocked(`area must be a Capability id (list_areas lists them); "${area}" is a ${node.type}.`);
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
  const shape = shapeReport(node);
  if (shape) payload.shape = shape;
  recordOriented(graph, [node.id]);
  return payload;
}

/**
 * orient_for_work({ change }): every member of a change (its open revisions, its planned sources,
 * and the other nodes holding a decision recorded under it) with the nodes whose
 * rules reach it, each source's rules once, and the members that hold decisions. Every member is
 * recorded as oriented, so one call clears the gate for a walk over the change. A decision gives
 * its node no change id, so decision holders are members here only, not in changeMembership.
 */
function orientForChange(
  graph: MindPlanGraph,
  change: string,
  known: Record<string, string> | undefined
): Record<string, unknown> {
  const { revisions, planned } = changeMembership(graph, change);
  const listed = new Set([...revisions, ...planned].map((n) => n.id));
  const holderIds = new Set(listDecisions(graph, { change }).map((d) => d.node_id));
  const deciders = graph.nodes.filter((n) => holderIds.has(n.id) && !listed.has(n.id));
  if (listed.size === 0 && deciders.length === 0) {
    throw blocked(
      `change "${change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
    );
  }
  const sources = new Map<string, RuleEntry>();
  const holders: string[] = [];
  let decisionCount = 0;
  const members = [
    ...revisions.map((n) => [n, "revision"] as const),
    ...planned.map((n) => [n, "planned"] as const),
    ...deciders.map((n) => [n, "decision"] as const),
  ].map(([n, kind]) => {
    const entries = reachingRules(graph, n.id);
    for (const e of entries) if (!sources.has(e.node_id)) sources.set(e.node_id, e);
    const own = nodeDecisions(graph, n).length;
    if (own > 0) {
      holders.push(n.id);
      decisionCount += own;
    }
    return {
      id: n.id,
      type: n.type,
      state: n.state,
      ...(n.next ? { next_state: n.next.state } : {}),
      kind,
      rules_from: entries.map((e) => e.node_id),
    };
  });
  const rules = [...sources.values()].map((e) => {
    const version = rulesVersion(e.rules);
    return known?.[e.node_id] === version
      ? { node_id: e.node_id, node_type: e.node_type, version, unchanged: true }
      : { node_id: e.node_id, node_type: e.node_type, version, rules: e.rules };
  });
  recordOriented(graph, members.map((m) => m.id));
  return {
    change,
    members,
    rules,
    decisions: { count: decisionCount, nodes: holders },
    next: 'orient_for_work({ node_id: "<member id>" }) for a member\'s body, decisions, and blast radius.',
  };
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
  /** Capability titles; omitted when the node belongs to none. */
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
  change?: string;
}): Promise<Record<string, unknown>> {
  const depth: OrientDepth = args.depth ?? "full";
  if (!(ORIENT_DEPTHS as readonly string[]).includes(depth)) {
    throw blocked(`orient_for_work depth must be one of: ${ORIENT_DEPTHS.join(", ")}.`);
  }
  const q = (args.query ?? "").trim();
  if (args.change !== undefined) {
    if (q || args.node_id) {
      throw blocked('orient_for_work takes "change" alone: drop "query" and "node_id", or orient on one node without "change".');
    }
    return orientForChange(loadGraph(), args.change, args.known_rules_versions);
  }
  if (!q && !args.node_id) {
    throw blocked('orient_for_work requires a non-empty "query", "node_id", or "change".');
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
  const shape = shapeReport(node);
  if (shape) reply.shape = shape;
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
    if (isPipelineNodeType(node.type)) reply.stability = stabilityPayload(graph, node);
  }
  return reply;
}

/**
 * Whether reopening the node is costly: its direct fan-in, how often it shipped lately against the
 * graph's median, its revision count and split record, and the `hotspot:` line when it is one.
 * A pre-ship node also carries `fan_out`: the other unshipped changes it reaches through
 * depends_on, so a node that would have to know every feature of a kind shows while it is planned.
 */
function stabilityPayload(graph: MindPlanGraph, node: MindPlanNode): Record<string, unknown> {
  const settings = hotspotSettings(loadProjectConfig(projectRoot()));
  const ctx = hotspotContext(graph, settings);
  const hotspot = hotspotFor(graph, node, settings, ctx);
  const round = (n: number) => Math.round(n * 10) / 10;
  const fan = fanOut(graph, node);
  return {
    fan_in: fanIn(graph, node, ctx.index).count,
    rate: round(recentRate(node, settings, ctx.now)),
    median_rate: round(ctx.median),
    ...(node.revisions !== undefined ? { revisions: node.revisions } : {}),
    ...(node.split_into?.length ? { split_at: node.split_at, split_into: [...node.split_into] } : {}),
    ...(hotspot ? { hotspot: hotspotWarning(hotspot) } : {}),
    ...(fan ? { fan_out: fan } : {}),
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

  if (node.type === "Capability") {
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
    return { node_id: node.id, type: "Capability", files };
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
