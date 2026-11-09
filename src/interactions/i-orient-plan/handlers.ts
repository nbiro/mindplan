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
import {
  REVISIONS_DIR,
  loadRevision,
  revisionFilePath,
  revisionRelativeFilePath,
} from "../../foundations/f-territory-store/revisions.js";
import { openChanges, pickRevision, withRevision } from "../../foundations/f-revision-model/index.js";
import { decisionGateSettings, fanInSettings, hotspotSettings } from "../../foundations/f-source-index/config.js";
import { fanOut } from "../../foundations/f-fan-out/index.js";
import { fanInContext, fanInFor, fanInGrouping, fanInWarning, isPreShipFoundation } from "../../foundations/f-fan-in/index.js";
import {
  fanIn,
  hotspotFor,
  hotspotWarning,
  diagnoseHotspot,
  recentRate,
  hotspotContext,
  answeredUnder,
} from "../../foundations/f-compiler-rules/open-closed.js";
import { buildOwnershipIndex, exclusiveOwner, nodeOwnedFiles } from "../../foundations/f-source-index/ownership.js";
import { blocked, findNode, interfacesExposing, isRevisionOf, liveGraph, revisionGraph } from "../../foundations/f-compiler-rules/rules.js";
import {
  DEFAULT_FIND_LIMIT,
  expandNeighborhood,
  findRelatedNodes,
  searchNodes,
} from "../../foundations/f-graph-search/search.js";
import { shapeReport } from "../../foundations/f-compiler-rules/shape.js";
import { openHumanItemsOfChange, openHumanItemsOfNode } from "../../foundations/f-compiler-rules/checklist-gates.js";
import { changeMembership } from "../../foundations/f-compiler-rules/planned.js";
import {
  orientationGateEnabled,
  pushProjectRules,
  reachingRules,
  recordOriented,
  recordRulesSent,
  firstHotspotWarning,
  sentRulesVersions,
  tracksSentText,
  unsentDecisions,
} from "../../foundations/f-orientation-ledger/ledger.js";
import { replySettings } from "../../foundations/f-source-index/config.js";
import { loadProjectBrief } from "../../foundations/f-territory-store/project.js";
import { cutReply, orients, parseSections, type OrientSection } from "./sections.js";
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
  namedRevisionChange,
  revisionSummaries,
  rulesBlock,
  rulesVersion,
  summarizeBlastRadius,
} from "../../foundations/f-plan-views/views.js";

/**
 * `{ project_rules }` for a reply that orients when the project rules have not reached this
 * session or changed since they did (recorded as served); `{}` otherwise or with the gate off.
 */
function orientRulesPush(): Record<string, unknown> {
  if (!orientationGateEnabled()) return {};
  const brief = loadProjectBrief();
  return pushProjectRules({ path: brief.path, rules: brief.rules, rules_version: rulesVersion(brief.rules) });
}

/**
 * Whether this reply leaves out rule text and decisions the session already received: on while the
 * gate is on, unless `replies.legacy` is set or the caller passes `resend_rules`.
 */
function tracking(resend?: boolean): boolean {
  if (resend) return false;
  return tracksSentText(replySettings(loadProjectConfig(projectRoot())).legacy);
}

/** The rule versions a reply may leave out: the caller's own, plus what this session already holds. */
function knownRules(caller: Record<string, string> | undefined, track: boolean): Record<string, string> | undefined {
  if (!track) return caller;
  return { ...sentRulesVersions(), ...(caller ?? {}) };
}

/** A rules block whose texts reached the agent: record them so later replies leave them out. */
function sent<T extends Record<string, unknown>>(block: T): T {
  recordRulesSent((block.entries as Record<string, unknown>[] | undefined) ?? []);
  return block;
}

/**
 * New decisions one narrowed read carries at most; the rest (`decisions_more`) are not recorded as
 * sent, so the next read carries them (a bounded list the reply budget never cuts).
 */
const NARROW_DECISIONS = 10;

/** The record a narrowed read (`section` / `slot`) keeps: which node, and where it stands. */
function minimalRecord(node: MindPlanNode): Record<string, unknown> {
  return { id: node.id, type: node.type, state: node.state, title: node.title };
}

/**
 * A node read cut to the body part asked for (`section` / `slot`): the minimal record, the body (and
 * the open revision's), the rules (text only for sources this session has not received), and only
 * the decisions this session has not received at their current text (`decisions_known` counts the rest).
 */
function narrowContext(
  node: MindPlanNode,
  full: Record<string, unknown>,
  track: boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = { record: minimalRecord(node) };
  if (full.section !== undefined) out.section = full.section;
  if (full.body !== undefined) out.body = full.body;
  const decisions: { id?: unknown }[] = [...((full.decisions as { id?: unknown }[] | undefined) ?? [])];
  const next = full.next as { record?: Record<string, unknown>; body?: unknown; decisions?: unknown } | string | null;
  if (typeof next === "string") out.next = next;
  else if (next) {
    out.next = {
      state: next.record?.state,
      ...(next.record?.title !== node.title ? { title: next.record?.title } : {}),
      ...(next.body !== undefined ? { body: next.body } : {}),
    };
    decisions.push(...((next.decisions as { id?: unknown }[] | undefined) ?? []));
  }
  const { fresh, known, more } = unsentDecisions(decisions, track, NARROW_DECISIONS);
  if (fresh.length) out.decisions = fresh;
  if (known) out.decisions_known = known;
  if (more) out.decisions_more = more;
  if (full.inherited_decisions !== undefined) {
    const inherited = full.inherited_decisions as InheritedDecisionsSummary;
    if (inherited.entries) out.inherited_decisions = inherited;
    else if (inherited.count) out.inherited_decisions = { count: inherited.count };
  }
  return out;
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
 *
 * Open revisions: `revisions` lists each one lean (`revisionSummaries`). `change` (already
 * resolved by the caller) makes that revision the next slot (`withRevision`); without it a node
 * with one open revision reads that one, and a node with several reads live only, with
 * `next: "pass change to read a revision"`.
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
    /** The open revision to read as the next slot (a change id the node has a revision of). */
    change?: string;
  } = {}
): Record<string, unknown> {
  const open = openChanges(node);
  // A pre-ship member of the change has no stored revision: its live slot is the change's.
  if (opts.slot === "next" && opts.change !== undefined && !node.shipped_at && isRevisionOf(node, opts.change)) {
    throw blocked(
      `"${node.id}" is a pre-ship member of change "${opts.change}": a pre-ship node has no open revision; ` +
        `its live slot is the change's. Omit slot (or pass slot "current") to read it.`
    );
  }
  // Several revisions and slot "next" without change: Blocked, naming them.
  const pickedRevision = pickRevision(node, opts.change, { strict: opts.slot === "next" });
  const change = pickedRevision.change ?? undefined;
  const view = pickedRevision.view;
  if (opts.slot === "next" && !view.next) {
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
  const revisions = revisionSummaries(node);
  if (revisions.length > 0) payload.revisions = revisions;
  // get_node_context names the inherited decisions; orient_for_work carries them in its decisions block.
  if (opts.inherited) {
    payload.inherited_decisions = splitNodeDecisions(graph, node, { ...opts, selfOnly: true }).inherited_decisions;
  }
  const stored = change !== undefined ? revisionFile(node, change) : undefined;
  if (view.next && stored) {
    const next = view.next;
    payload.next_path = revisionRelativeFilePath(node, change!);
    payload.next_attachments_path = `${rel}/${REVISIONS_DIR}/${change}/${ATTACHMENTS_DIR}`;
    const record = {
      state: next.state,
      title: next.title,
      description: next.description,
      updated_at: next.updated_at,
      ...(next.opened_at ? { opened_at: next.opened_at } : {}),
      ...(next.belongs_to?.length ? { belongs_to: next.belongs_to } : {}),
      ...(next.depends_on?.length ? { depends_on: next.depends_on } : {}),
      ...(next.exposes?.length ? { exposes: next.exposes } : {}),
      ...(next.leads_to?.length ? { leads_to: next.leads_to } : {}),
      ...(next.implements?.length ? { implements: next.implements } : {}),
      ...(next.role ? { role: next.role } : {}),
      ...(next.change ? { change: next.change } : {}),
      ...(next.change_ref ? { change_ref: next.change_ref } : {}),
      ...(stored.revision.conflicts.length ? { conflicts: stored.revision.conflicts } : {}),
    };
    if (withNextBody) {
      payload.next = {
        record,
        body: cut(withoutOwnedSections(stored.body), "next"),
        ...(index ? { decisions: slotDecisions(graph, view, "next", opts, index) } : {}),
      };
    } else {
      payload.next = { record };
    }
  } else if (open.length > 1) {
    payload.next = PASS_CHANGE;
  }
  return payload;
}

/** What `next` says on a node with several open revisions read without `change`. */
export const PASS_CHANGE = "pass change to read a revision";

/** The revision of `change` as stored under `revisions/`, or undefined when the node has none of it. */
function revisionFile(node: MindPlanNode, change: string): ReturnType<typeof loadRevision> | undefined {
  if (!node.open_revisions?.some((r) => r.change === change)) return undefined;
  if (!fs.existsSync(revisionFilePath(node, change))) return undefined;
  return loadRevision(node, change);
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
    // Each open revision's headings are searchable too (the reader's `revision`).
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
  include_inherited_rules?: boolean;
  slot?: ContextSlot;
  section?: string;
  change?: string;
  resend_rules?: boolean;
}): Record<string, unknown> {
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  const change = args.change !== undefined ? namedRevisionChange(node, args.change) : undefined;
  const track = tracking(args.resend_rules);
  const full = buildNodeContextPayload(graph, node, {
    include_superseded: args.include_superseded,
    inherited: true,
    include_inherited_decisions: args.include_inherited_decisions,
    slot: args.slot,
    section: args.section,
    change,
  });
  // A section or slot read returns that body part, not the whole record (lean replies).
  const narrow = args.section !== undefined || args.slot !== undefined;
  const payload = narrow ? { node_id: node.id, ...narrowContext(node, full, track) } : full;
  if (change !== undefined) payload.unlocks = change;
  // It counts as orienting on the node, so it carries every rule that reaches it, not only its own
  // (sources past distance 1 as one line unless include_inherited_rules); text this session already
  // received comes back as { node_id, version, unchanged: true }.
  payload.resolved_rules = sent(
    rulesBlock(node.id, reachingRules(graph, node.id), { all: args.include_inherited_rules, known: knownRules(undefined, track) })
  );
  // The node's own rules text rides in resolved_rules; the raw copy goes once that text is known.
  const own = ((payload.resolved_rules as Record<string, unknown>).entries as Record<string, unknown>[]).find(
    (e) => e.node_id === node.id
  );
  if (track && own?.unchanged) delete payload.rules;
  if (!narrow) {
    const shape = shapeReport(change !== undefined ? withRevision(node, change) : node);
    if (shape) payload.shape = shape;
  }
  recordOriented(graph, [node.id]);
  return payload;
}

/**
 * orient_for_work({ change }): every member of a change (each node's revision of it, its planned
 * sources, and the other nodes holding a decision recorded under it) with the nodes whose
 * rules reach it, each source's rules once, and the members that hold decisions. Membership and
 * rules are judged on `revisionGraph(graph, change)`. Every member is recorded as oriented, so one
 * call clears the gate for a walk over the change. A decision gives its node no change id, so
 * decision holders are members here only, not in changeMembership.
 */
function orientForChange(
  graph: MindPlanGraph,
  change: string,
  known: Record<string, string> | undefined,
  sections?: Set<OrientSection>,
  all?: boolean,
  track = false
): Record<string, unknown> {
  const under = revisionGraph(graph, change);
  const { revisions, planned } = changeMembership(under, change);
  const listed = new Set([...revisions, ...planned].map((n) => n.id));
  const holderIds = new Set(listDecisions(graph, { change }).map((d) => d.node_id));
  const deciders = under.nodes.filter((n) => holderIds.has(n.id) && !listed.has(n.id));
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
    const entries = reachingRules(under, n.id);
    // Each source once, at its nearest distance to any member.
    for (const e of entries) {
      const prior = sources.get(e.node_id);
      if (!prior || e.distance < prior.distance) sources.set(e.node_id, e);
    }
    const own = nodeDecisions(under, n).length;
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
      ...(kind === "revision" ? { change } : {}),
      rules_from: entries.map((e) => e.node_id),
    };
  });
  const block = rulesBlock(change, [...sources.values()], { all, known: knownRules(known, track) });
  if (orients(sections)) sent(block);
  const rules = (block.entries as Record<string, unknown>[]).map(({ via: _via, distance: _distance, ...rest }) => rest);
  if (orients(sections)) recordOriented(graph, members.map((m) => m.id));
  const openItems = openHumanItemsOfChange(graph, change);
  return cutReply(
    {
      change,
      members,
      rules,
      ...(block.more ? { rules_more: block.more } : {}),
      ...(orients(sections) ? orientRulesPush() : {}),
      decisions: { count: decisionCount, nodes: holders },
      ...(openItems.length ? { open_items: openItems } : {}),
      next: 'orient_for_work({ node_id: "<member id>" }) for a member\'s body, decisions, and blast radius.',
    },
    sections
  );
}

/** Most nodes one orient_for_work({ node_ids }) takes. */
export const MAX_ORIENT_NODES = 20;

/**
 * orient_for_work({ node_ids }): orient on several nodes in one reply. Each node comes back lean
 * (id, type, state, title, open revisions, the rule sources reaching it, its decision count), and
 * every rule source once at its nearest distance, text only where this session has not received
 * it. Every node is recorded as oriented, so writes on any of them go through.
 */
function orientForNodes(
  graph: MindPlanGraph,
  ids: string[],
  known: Record<string, string> | undefined,
  sections: Set<OrientSection> | undefined,
  all: boolean | undefined,
  track: boolean
): Record<string, unknown> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw blocked('orient_for_work "node_ids" needs at least one node id.');
  if (unique.length > MAX_ORIENT_NODES) {
    throw blocked(`orient_for_work takes at most ${MAX_ORIENT_NODES} node_ids; pass a change id to orient on a whole change.`);
  }
  const sources = new Map<string, RuleEntry>();
  const nodes = unique.map((id) => {
    const node = findNode(graph, id);
    const entries = reachingRules(graph, node.id);
    for (const e of entries) {
      const prior = sources.get(e.node_id);
      if (!prior || e.distance < prior.distance) sources.set(e.node_id, e);
    }
    const revisions = revisionSummaries(node);
    return {
      id: node.id,
      type: node.type,
      state: node.state,
      title: node.title,
      ...(revisions.length ? { revisions: revisions.map(({ change, state }) => ({ change, state })) } : {}),
      rules_from: entries.map((e) => e.node_id),
      decisions: nodeDecisions(graph, node).length,
    };
  });
  const block = rulesBlock(unique.join(","), [...sources.values()], { all, known: knownRules(known, track) });
  if (orients(sections)) {
    sent(block);
    recordOriented(graph, unique);
  }
  const rules = (block.entries as Record<string, unknown>[]).map(({ via: _via, distance: _distance, ...rest }) => rest);
  return cutReply(
    {
      node_ids: unique,
      members: nodes,
      rules,
      ...(block.more ? { rules_more: block.more } : {}),
      ...(orients(sections) ? orientRulesPush() : {}),
      next: 'orient_for_work({ node_id, section }) or get_node_context({ node_id, section }) for a body part.',
    },
    sections
  );
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

/** The default: what an edit needs; the neighborhood, blast radius, and stability are asked for. */
export const DEFAULT_ORIENT_DEPTH = "body";

/** Sections only depth "full" computes. */
const FULL_DEPTH_SECTIONS = new Set<string>(["blast_radius", "stability", "neighborhood"]);

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
  include_inherited_rules?: boolean;
  known_rules_versions?: Record<string, string>;
  area?: string;
  slot?: ContextSlot;
  section?: string;
  change?: string;
  sections?: string[];
  node_ids?: string[];
  resend_rules?: boolean;
}): Promise<Record<string, unknown>> {
  const sections = parseSections(args.sections);
  const track = tracking(args.resend_rules);
  // Naming a part only depth "full" computes asks for it: no depth needed alongside.
  const asksFull = [...(sections ?? [])].some((s) => FULL_DEPTH_SECTIONS.has(s));
  const depth: OrientDepth = args.depth ?? (asksFull ? "full" : DEFAULT_ORIENT_DEPTH);
  if (!(ORIENT_DEPTHS as readonly string[]).includes(depth)) {
    throw blocked(`orient_for_work depth must be one of: ${ORIENT_DEPTHS.join(", ")}.`);
  }
  const q = (args.query ?? "").trim();
  if (args.change !== undefined && !args.node_id) {
    if (q) {
      throw blocked(
        'orient_for_work takes "change" alone (every member of the change) or with "node_id" (that node\'s revision of it): drop "query".'
      );
    }
    return orientForChange(loadGraph(), args.change, args.known_rules_versions, sections, args.include_inherited_rules, track);
  }
  if (args.node_ids !== undefined) {
    if (q || args.node_id || args.change !== undefined) {
      throw blocked('orient_for_work takes "node_ids" alone: drop "query", "node_id", and "change".');
    }
    return orientForNodes(loadGraph(), args.node_ids, args.known_rules_versions, sections, args.include_inherited_rules, track);
  }
  if (!q && !args.node_id) {
    throw blocked('orient_for_work requires a non-empty "query", "node_id", "node_ids", or "change".');
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
  // A named change picks that revision; Blocked when the node has none of it, unless the node is a
  // pre-ship member of that change: its live slot is the change's (it has no stored revision).
  const change = args.change;
  const preShipMember = change !== undefined && !node.shipped_at && isRevisionOf(node, change);
  const { view } = preShipMember ? { view: node } : pickRevision(node, change, { strict: change !== undefined });
  // The body comes from the active slot unless the caller names one; depth "rules" returns no body,
  // so it reads the live slot only (its next record comes back without the next body).
  // The decisions block is the reply's one copy of the focus's decisions.
  const context = buildNodeContextPayload(
    graph,
    node,
    depth === "rules"
      ? { slot: "current", omitDecisions: true, change }
      : { slot: args.slot ?? (view.next ? "next" : "current"), section: args.section, omitDecisions: true, change }
  );
  const revisions = context.revisions;
  delete context.revisions;
  const rules = rulesBlock(node.id, reachingRules(graph, node.id), {
    all: args.include_inherited_rules,
    known: knownRules(args.known_rules_versions, track),
  });
  if (orients(sections)) sent(rules);
  const split = splitNodeDecisions(graph, node, args, depth);
  const decisions = { node_id: node.id, entries: split.own, inherited_decisions: split.inherited_decisions };
  // A reply cut to sections without the rules does not orient.
  if (orients(sections)) recordOriented(graph, [node.id]);

  const reply: Record<string, unknown> = {
    query: q,
    matches: rows,
    focus: node.id,
    ...(autoFocus ? { auto_focus: true } : {}),
    ...(revisions ? { revisions } : {}),
    ...(change !== undefined ? { unlocks: change } : {}),
    // Several revisions and none named: the body is live; say how to read one.
    ...(context.next === PASS_CHANGE ? { next: PASS_CHANGE } : {}),
    rules,
    decisions,
  };
  // The rules count as served only once the reply that carries them is complete.
  const withRulesPush = (r: Record<string, unknown>) =>
    cutReply(orients(sections) ? { ...r, ...orientRulesPush() } : r, sections);
  const shape = shapeReport(view);
  if (shape) reply.shape = shape;
  // Review and deploy items wait on people: listed so the agent says so instead of ticking them.
  const openItems = openHumanItemsOfNode(node);
  if (openItems.length) reply.open_items = openItems;
  // A section or slot read: that body part, the minimal record, the rules, and only new decisions.
  if (depth !== "rules" && sections === undefined && (args.section !== undefined || args.slot !== undefined)) {
    const { fresh, known, more } = unsentDecisions(split.own as { id?: unknown }[], track, NARROW_DECISIONS);
    return withRulesPush({
      query: q,
      focus: node.id,
      ...(autoFocus ? { auto_focus: true } : {}),
      ...(change !== undefined ? { unlocks: change } : {}),
      ...(context.next === PASS_CHANGE ? { next: PASS_CHANGE } : {}),
      rules,
      context: narrowContext(node, context, track),
      ...(fresh.length ? { decisions: { node_id: node.id, entries: fresh } } : {}),
      ...(known ? { decisions_known: known } : {}),
      ...(more ? { decisions_more: more } : {}),
      ...(args.include_inherited_decisions ? { inherited_decisions: split.inherited_decisions } : {}),
    });
  }
  if (depth === "rules") {
    const next = context.next as { record?: unknown } | string | null;
    reply.context = {
      record: context.record,
      next: typeof next === "string" ? next : next ? { record: next.record } : null,
    };
    return withRulesPush(reply);
  }
  reply.context = context;
  if (isPipelineNodeType(node.type)) {
    const owned = nodeOwnedFiles(view, projectRoot());
    reply.files = { files: owned.files, ...(owned.next_files ? { next_files: owned.next_files } : {}) };
  }
  if (depth === "full") {
    const { nodes, edges } = expandNeighborhood(graph, node.id);
    reply.nodes = nodes;
    reply.edges = edges;
    // A named revision is judged on the graph it would ship into.
    const judged = change !== undefined ? revisionGraph(graph, change) : liveGraph(graph);
    // The summary: get_blast_radius({ node_id, detail: "full" }) returns every row.
    reply.blast_radius = isPipelineNodeType(node.type)
      ? summarizeBlastRadius(judged, buildBlastRadiusPayload(judged, findNode(judged, node.id)))
      : null;
    if (isPipelineNodeType(node.type)) reply.stability = stabilityPayload(graph, node);
  }
  return withRulesPush(reply);
}

/**
 * The stability payload's hotspot fields: the warning text once per node per open change in this
 * session (none when a decision under the change answered it), afterwards `hotspot: true` and the
 * diagnosis only. A node with no open revision keeps the text (it is not tied to a change).
 */
function hotspotFields(node: MindPlanNode, hotspot: NonNullable<ReturnType<typeof hotspotFor>>): Record<string, unknown> {
  const open = openChanges(node);
  const unanswered = open.filter((c) => !answeredUnder(node, c));
  if (open.length > 0 && unanswered.length === 0) return { hotspot: true, diagnosis: hotspot.diagnosis.kind, answered: true };
  const fresh = open.length === 0 || unanswered.filter((c) => firstHotspotWarning(node.id, c)).length > 0;
  return fresh
    ? { hotspot: hotspotWarning(hotspot), diagnosis: hotspot.diagnosis.kind }
    : { hotspot: true, diagnosis: hotspot.diagnosis.kind };
}

/**
 * Whether reopening the node is costly: its direct fan-in, how often it shipped lately against the
 * graph's median, its revision count and split record, and the `hotspot:` line when it is one.
 * A pre-ship node also carries `fan_out`: the other unshipped changes it reaches through
 * depends_on, so a node that would have to know every feature of a kind shows while it is planned.
 * A pre-ship Foundation also carries `fan_in_groups` (its direct dependents by Capability) and,
 * when the fan-in signal fires, `fan_in_warning`: the `fan-in:` line the check gives.
 */
function stabilityPayload(graph: MindPlanGraph, node: MindPlanNode): Record<string, unknown> {
  const config = loadProjectConfig(projectRoot());
  const settings = hotspotSettings(config);
  const ctx = hotspotContext(graph, settings);
  const hotspot = hotspotFor(graph, node, settings, ctx);
  const round = (n: number) => Math.round(n * 10) / 10;
  const fan = fanOut(graph, node);
  const preShipFoundation = isPreShipFoundation(node);
  const fanInCtx = preShipFoundation ? fanInContext(graph) : null;
  const grouping = fanInCtx ? fanInGrouping(graph, node, fanInCtx) : null;
  const fanInSignal = fanInCtx
    ? fanInFor(graph, node, fanInSettings(config), decisionGateSettings(config).blast_radius, fanInCtx)
    : null;
  return {
    fan_in: fanIn(graph, node, ctx.index).count,
    rate: round(recentRate(node, settings, ctx.now)),
    median_rate: round(ctx.median),
    // The rate by the reasons its revisions recorded (unrecorded: ships from before reasons existed).
    ...(node.shipped_at
      ? (({ wiring, behavior, unrecorded }) => ({ rate_by_reason: { wiring, behavior, unrecorded } }))(
          diagnoseHotspot(node, settings, ctx.now)
        )
      : {}),
    ...(node.revisions !== undefined ? { revisions: node.revisions } : {}),
    ...(node.split_into?.length ? { split_at: node.split_at, split_into: [...node.split_into] } : {}),
    ...(hotspot ? hotspotFields(node, hotspot) : {}),
    ...(fan ? { fan_out: fan } : {}),
    ...(grouping && grouping.groups.length > 0 ? { fan_in_groups: grouping.groups } : {}),
    ...(fanInSignal ? { fan_in_warning: fanInWarning(fanInSignal) } : {}),
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
