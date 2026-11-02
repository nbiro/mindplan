/**
 * Change a node's status — owned by i-change-status: update_node_status (single, ordered, scoped,
 * dry run, ship and promotion with revision counts and declared splits) and force_unship.
 */

import { splitPartLinked } from "../../foundations/f-compiler-rules/open-closed.js";
import {
  churnAfterShip,
  decayChurn,
  isNextPipelineState,
  isPipelineNodeType,
  type MindPlanGraph,
  type MindPlanNode,
  type ProductionState,
} from "../../foundations/f-domain-model/types.js";
import {
  deleteNextSlotFiles,
  loadGraph,
  loadProjectConfig,
  projectRoot,
  patchFrontmatter,
  writeRevisionFields,
  readMarkdown,
  writeMarkdown,
  clearAddedClaims,
  writeChangeFrontmatter,
  clearAttributed,
  stripLiveAtomicOps,
  freshLiveAtomicOps,
} from "../../foundations/f-territory-store/store.js";
import {
  discardRevision,
  shipRevision,
  writeRevisionState,
} from "../../foundations/f-territory-store/revisions.js";
import {
  graphUnder,
  openChanges,
  resolveRevisionChange,
  revisionFor,
  withRevision,
} from "../../foundations/f-revision-model/index.js";
import { hotspotSettings } from "../../foundations/f-source-index/config.js";
import {
  blocked,
  changeMembers,
  findNode,
  recomputeCapabilityStates,
  recomputeStability,
  resolveForceUnship,
  resolveStatusChange,
} from "../../foundations/f-compiler-rules/rules.js";
import { assertCheckCleanForNode, staleTextWarnings } from "../../foundations/f-compiler-rules/integrity.js";
import { assertDecisionForReview, createDecisionContext, type DecisionContext } from "../../foundations/f-compiler-rules/decisions.js";
import {
  changedFiles,
  assertNoLegacyNext,
  conflictLabel,
  gateWrite,
  mutationTail,
  refreshPersistedMap,
  syncNodes,
  territoryPath,
  withChangeCleanup,
} from "../../foundations/f-plan-writes/writes.js";

const STATUS_TIER: Record<string, number> = {
  Foundation: 0,
  Interaction: 1,
  Interface: 2,
  Bug: 3,
};

type StatusRevision = { node_id: string; new_status: string; change?: string };

/** Moves that retire a node: they act on live and delete every open revision. */
const RETIRE_STATES = new Set(["deprecated", "cancelled"]);

/**
 * Which open revision a transition of `node` moves: the revision of `change`, or the node's only
 * one; undefined for live (a pre-ship node, a Bug, a shipped node with none, or a retirement).
 * Blocked when several are open and no change is given (naming them), when `change` names no
 * open revision, and when a `<id>.next.mdx` from an older release is still on disk.
 */
function revisionChangeFor(node: MindPlanNode, newStatus: string, change?: string): string | undefined {
  if (!isPipelineNodeType(node.type)) {
    if (change) throw blocked(`"${node.id}" is a ${node.type}; it has no revisions, so it takes no change.`);
    return undefined;
  }
  assertNoLegacyNext(node, "update_node_status");
  if (!node.shipped_at) {
    if (change && node.change !== change) {
      throw blocked(`"${node.id}" is not shipped and belongs to ${node.change ? `change "${node.change}"` : "no change"}, not "${change}".`);
    }
    return undefined;
  }
  if (RETIRE_STATES.has(newStatus) && !change) return undefined;
  return resolveRevisionChange(node, change) ?? undefined;
}

/** The node as gates judge a live-only move: no revision view on `next`. */
function liveOnly(node: MindPlanNode): MindPlanNode {
  if (!node.next) return node;
  const copy = { ...node };
  delete copy.next;
  return copy;
}

/** Blocked when the revision still holds rebase conflicts (in-review and ship need none). */
function assertNoConflicts(node: MindPlanNode, change: string, step: string): void {
  // WP4: the conflict Blocked moves into the revision gates; this handler check then goes.
  const rev = revisionFor(node, change);
  if (!rev || rev.conflicts.length === 0) return;
  const target = (c: (typeof rev.conflicts)[number]): string =>
    c.kind === "section" ? `section: "${c.section}"` : c.kind === "scalar" ? `field: "${c.field}"` : `claim: "${c.path}"`;
  throw blocked(
    `revision "${change}" of "${node.id}" holds unresolved conflicts (${rev.conflicts.map(conflictLabel).join(", ")}) ` +
      `left by a sibling revision that shipped; it cannot move to ${step}. Resolve each with ` +
      rev.conflicts
        .map((c) => `resolve_conflict({ node_id: "${node.id}", change: "${change}", ${target(c)}, take: "revision" | "live" | "text" })`)
        .join(", ") +
      `, then retry.`
  );
}

/** Which nodes a scoped status call walks. */
export const STATUS_SCOPES = ["all_open_updates", "node_and_dependents", "change"] as const;

export type StatusScope = (typeof STATUS_SCOPES)[number];

/** Forward build pipeline a scoped call walks each node through. */
const WALK_PIPELINE = ["draft", "ready", "in-progress", "in-review", "ship"] as const;

type StatusArgs = {
  node_id?: string;
  new_status?: string;
  revisions?: StatusRevision[];
  scope?: StatusScope;
  /**
   * Change id walked by `scope: "change"`; for a single node, which of its open revisions the
   * transition moves (optional when it has at most one).
   */
  change?: string;
  /** Let a scoped walk to `ship` move nodes that have not reached in-review. Reported in the result. */
  skip_review?: boolean;
  /** Let a scoped walk move every node that passes its gates and leave the blocked ones in place. */
  skip_blocked?: boolean;
  dry_run?: boolean;
  verbose?: boolean;
};

type StatusMode = "single" | "batch" | "scope";

function normalizeStatusArgs(args: StatusArgs): { mode: StatusMode; items: StatusRevision[] } {
  const list = args.revisions;
  const hasList = Array.isArray(list) && list.length > 0;
  const hasSingle = args.node_id !== undefined || args.new_status !== undefined;
  if (args.scope !== undefined) {
    if (hasList) {
      throw blocked("update_node_status accepts either scope or revisions, not both.");
    }
    if (!(STATUS_SCOPES as readonly string[]).includes(args.scope)) {
      throw blocked(`scope must be one of: ${STATUS_SCOPES.join(", ")}.`);
    }
    if (!args.new_status || !(WALK_PIPELINE as readonly string[]).includes(args.new_status)) {
      throw blocked(
        `scope walks nodes forward to a target: new_status must be one of ${WALK_PIPELINE.join(", ")}.`
      );
    }
    if (args.scope === "node_and_dependents" && !args.node_id) {
      throw blocked('scope "node_and_dependents" requires node_id (the node whose open dependents walk with it).');
    }
    if (args.scope === "all_open_updates" && args.node_id) {
      throw blocked('scope "all_open_updates" takes no node_id; use "node_and_dependents" for one node.');
    }
    if (args.scope === "change") {
      if (!args.change) {
        throw blocked('scope "change" requires change (the change id whose revisions walk together).');
      }
      if (args.node_id) {
        throw blocked('scope "change" takes no node_id; the change names its revisions.');
      }
    } else if (args.change !== undefined) {
      throw blocked('change is only used with scope "change".');
    }
    return { mode: "scope", items: [] };
  }
  if (args.change !== undefined && hasList) {
    throw blocked('change picks the revision of a single node (node_id + new_status) or the change of scope "change"; not a revisions list.');
  }
  if (args.skip_review === true) {
    throw blocked("skip_review only applies to a scoped walk to ship.");
  }
  if (args.skip_blocked === true) {
    throw blocked("skip_blocked only applies to a scoped walk (scope + new_status).");
  }
  if (hasList && hasSingle) {
    throw blocked(
      "update_node_status accepts either node_id + new_status, or revisions, not both."
    );
  }
  if (hasList) {
    const ids = new Set<string>();
    for (const item of list!) {
      if (!item?.node_id || !item?.new_status) {
        throw blocked("each revision needs node_id and new_status.");
      }
      if (ids.has(item.node_id)) {
        throw blocked(`duplicate node_id "${item.node_id}" in revisions.`);
      }
      ids.add(item.node_id);
    }
    return { mode: "batch", items: list! };
  }
  if (!args.node_id || args.new_status === undefined || args.new_status === "") {
    throw blocked(
      "update_node_status requires node_id and new_status, a non-empty revisions list, or a scope with new_status."
    );
  }
  return {
    mode: "single",
    items: [{ node_id: args.node_id, new_status: args.new_status, ...(args.change ? { change: args.change } : {}) }],
  };
}

function orderStatusRevisions(items: StatusRevision[]): StatusRevision[] {
  const graph = loadGraph();
  return items
    .map((item, index) => {
      const node = findNode(graph, item.node_id);
      if (node.type === "Capability") {
        throw blocked(
          "Capability states are computed automatically from their Interactions and cannot be set manually."
        );
      }
      return { item, index, tier: STATUS_TIER[node.type] ?? 99 };
    })
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((row) => row.item);
}

/** State a walk moves: the revision of `change` when given, else next while evolving, else live. */
function activeState(node: MindPlanNode, change?: string): string {
  if (change) return revisionFor(node, change)?.state ?? node.state;
  return node.next ? node.next.state : node.state;
}

/**
 * A shipped node with an open next, or a pre-ship node that is being built (in-progress or
 * in-review). A draft or ready node is a plan for later work, not an update: `all_open_updates`
 * never walks it. `node_and_dependents` names its seed on purpose, so with `includePlanned`
 * the seed's dependents may be walked from draft or ready too.
 */
function isOpenUpdate(node: MindPlanNode, includePlanned = false): boolean {
  if (!isPipelineNodeType(node.type)) return false;
  if (node.next || openChanges(node).length > 0) return true;
  if (node.shipped_at) return false;
  if (node.state === "in-progress" || node.state === "in-review") return true;
  return includePlanned && (node.state === "draft" || node.state === "ready");
}

/** A node a scoped walk moves, and which of its open revisions (undefined: live or pre-ship). */
type ScopedNode = { node: MindPlanNode; change?: string };

/**
 * Nodes a scoped call walks with the revision each row moves, in the order they must move
 * (Foundations, Interactions, Interfaces). `scope: "change"` moves each member's revision of that
 * change; the other scopes move each node's only open revision (Blocked when a node has several).
 */
function selectScopedNodes(graph: MindPlanGraph, args: StatusArgs): ScopedNode[] {
  let selected: MindPlanNode[];
  if (args.scope === "all_open_updates") {
    selected = graph.nodes.filter((n) => isOpenUpdate(n));
  } else if (args.scope === "change") {
    const change = args.change!;
    const ids = new Set(changeMembers(graph, change).map((n) => n.id));
    for (const n of graph.nodes) if (revisionFor(n, change)) ids.add(n.id);
    selected = graph.nodes.filter((n) => ids.has(n.id));
    for (const n of selected) if (!revisionFor(n, change)) assertNoLegacyNext(n, "update_node_status");
    if (selected.length === 0) {
      throw blocked(
        `change "${args.change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
      );
    }
    return orderForWalk(graph, selected).map((node) => ({
      node,
      ...(revisionFor(node, change) ? { change } : {}),
    }));
  } else {
    const seed = findNode(graph, args.node_id!);
    const ids = new Set<string>([seed.id]);
    const queue = [seed.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of graph.edges) {
        const hit =
          (edge.type === "depends_on" && edge.target === current) ||
          (edge.type === "exposes" && edge.target === current);
        if (hit && !ids.has(edge.source)) {
          ids.add(edge.source);
          queue.push(edge.source);
        }
      }
      // Edges proposed on an open revision count too: that node ships with the new edge.
      for (const other of graph.nodes) {
        if (ids.has(other.id)) continue;
        const views = [other.next, ...openChanges(other).map((c) => withRevision(other, c).next)];
        if (views.some((v) => v && ((v.depends_on ?? []).includes(current) || (v.exposes ?? []).includes(current)))) {
          ids.add(other.id);
          queue.push(other.id);
        }
      }
    }
    selected = graph.nodes.filter((n) => ids.has(n.id) && isOpenUpdate(n, true));
  }
  return orderForWalk(graph, selected).map((node) => {
    const change = revisionChangeFor(node, args.new_status!);
    return { node, ...(change ? { change } : {}) };
  });
}

/** Tier order (Foundation, Interaction, Interface), then dependency order within a tier. */
function orderForWalk(graph: MindPlanGraph, nodes: MindPlanNode[]): MindPlanNode[] {
  const inSet = new Set(nodes.map((n) => n.id));
  const done = new Set<string>();
  const out: MindPlanNode[] = [];
  const pending = [...nodes].sort(
    (a, b) =>
      (STATUS_TIER[a.type] ?? 99) - (STATUS_TIER[b.type] ?? 99) || a.id.localeCompare(b.id)
  );
  while (pending.length > 0) {
    const index = pending.findIndex((n) =>
      graph.edges.every(
        (e) =>
          !(e.source === n.id && e.type === "depends_on") ||
          !inSet.has(e.target) ||
          done.has(e.target)
      )
    );
    const [next] = pending.splice(index < 0 ? 0 : index, 1);
    done.add(next.id);
    out.push(next);
  }
  return out;
}

/** One node's walk: the revision it moves (`change`; undefined for live) and its steps. */
type WalkPlan = { node_id: string; change?: string; steps: string[] };

/** Steps from a node's active state forward to the target; empty when already there or past. */
function stepsToTarget(node: MindPlanNode, target: string, change?: string): string[] {
  const from = (WALK_PIPELINE as readonly string[]).indexOf(activeState(node, change));
  const to = (WALK_PIPELINE as readonly string[]).indexOf(target);
  if (from < 0 || to < 0 || from >= to) return [];
  return WALK_PIPELINE.slice(from + 1, to + 1);
}

/** Replace a node's outgoing edges in the in-memory graph with its current edge fields. */
function rebuildOutgoingEdges(graph: MindPlanGraph, node: MindPlanNode): void {
  graph.edges = graph.edges.filter((e) => e.source !== node.id);
  for (const type of ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "affects"] as const) {
    for (const target of node[type] ?? []) graph.edges.push({ source: node.id, target, type });
  }
}

/**
 * The in-memory effect of shipping the revision of `change`, field for field as shipRevision
 * writes it: live becomes the `withRevision` view (contract scalars, edges, claims, tests, role,
 * decisions), the revision is dropped, and sibling revisions stay (their deltas apply to the new
 * live). A validated walk sees at every later step what the real walk will see.
 */
function promoteInMemory(
  graph: MindPlanGraph,
  node: MindPlanNode,
  change: string,
  state: MindPlanNode["state"],
  shippedAt: string
): void {
  const view = withRevision(node, change);
  const next = view.next;
  if (!next) return;
  node.title = next.title;
  node.description = next.description;
  node.state = state;
  // The revision count, rate, and split, as shipRevision writes them.
  const parts = splitParts(graph, view);
  node.revisions = (node.revisions ?? 1) + 1;
  node.churn = parts.length
    ? 0
    : churnAfterShip(node.churn, node.shipped_at, shippedAt, hotspotSettings(loadProjectConfig()).half_life_days);
  if (parts.length) {
    node.split_at = node.revisions;
    node.split_into = [...new Set([...(node.split_into ?? []), ...parts])];
  }
  node.shipped_at = shippedAt;
  node.updated_at = shippedAt;
  for (const key of ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "implements"] as const) {
    const value = next[key];
    if (value && value.length > 0) node[key] = [...value];
    else delete node[key];
  }
  if (view.tests?.length) node.tests = [...view.tests];
  else delete node.tests;
  if (next.decisions?.length) node.decisions = [...next.decisions];
  else delete node.decisions;
  if (next.role) node.role = next.role;
  const rest = (node.open_revisions ?? []).filter((r) => r.change !== change);
  if (rest.length) node.open_revisions = rest;
  else delete node.open_revisions;
  // The loader's view: the only remaining revision fills `next`, none or several leave it unset.
  if (rest.length === 1) node.next = withRevision(node, rest[0].change).next;
  else delete node.next;
  rebuildOutgoingEdges(graph, node);
}

/**
 * Validates every step of a plan in memory against a loaded graph, writing nothing.
 * Returns the first Blocked reason (naming the node and step), or null.
 */
function simulateWalk(
  plan: WalkPlan[],
  decisionCtx: DecisionContext = createDecisionContext(projectRoot())
): { blocked: string | null; warnings: string[] } {
  const graph = loadGraph();
  const root = projectRoot();
  const now = new Date().toISOString();
  const warnings = new Set<string>();
  for (const row of plan) {
    const stop = simulateRow(graph, root, row, now, decisionCtx, warnings);
    if (stop) {
      return { blocked: `Blocked: ${stop.reason} (at "${row.node_id}" -> ${stop.step})`, warnings: [...warnings] };
    }
  }
  return { blocked: null, warnings: [...warnings] };
}

/**
 * One node's steps applied to `graph` in memory; the first Blocked step and its reason, or null.
 * A revision row is judged on `graphUnder(graph, change)` (live plus that change's revisions).
 */
function simulateRow(
  graph: MindPlanGraph,
  root: string,
  row: WalkPlan,
  now: string,
  decisionCtx: DecisionContext,
  warnings: Set<string>
): { step: string; reason: string } | null {
  const node = findNode(graph, row.node_id);
  for (const step of row.steps) {
    try {
      if (row.change) {
        if (step === "in-review" || step === "ship") assertNoConflicts(node, row.change, step);
        const under = graphUnder(graph, row.change);
        const view = findNode(under, row.node_id);
        // WP4: resolveRevisionStatusChange(graph, node, row.change, step) replaces this call.
        const resolved = resolveStatusChange(under, view, step);
        if (step === "in-review" || step === "ship") {
          // WP4: assertCheckCleanForRevision(graph, root, node, row.change, step) replaces this call.
          assertCheckCleanForNode(under, root, view, step);
          // WP2: decisionGapFor(graph, root, node, row.change, decisionCtx) replaces this call.
          if (step === "in-review") assertDecisionForReview(under, root, view, decisionCtx);
          for (const w of staleTextWarnings(under, root, view).warnings) warnings.add(w);
        }
        if (resolved.promote_next) {
          promoteInMemory(graph, node, row.change, resolved.state, now);
        } else {
          const rev = revisionFor(node, row.change)!;
          rev.state = resolved.state as typeof rev.state;
          if (node.next?.change === row.change) node.next.state = rev.state;
        }
        continue;
      }
      const subject = RETIRE_STATES.has(step) ? liveOnly(node) : node;
      const resolved = resolveStatusChange(graph, subject, step);
      if (step === "in-review" || step === "ship") {
        assertCheckCleanForNode(graph, root, node, step);
        if (step === "in-review") assertDecisionForReview(graph, root, node, decisionCtx);
        for (const w of staleTextWarnings(graph, root, node).warnings) warnings.add(w);
      }
      node.state = resolved.state;
      if (resolved.ship) node.shipped_at = now;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { step, reason: message.replace(/^Blocked:\s*/, "") };
    }
  }
  return null;
}

type BlockedMember = { node_id: string; step: string; reason: string };

/**
 * `skip_blocked`: each node's whole walk is validated on a copy of the graph that already holds
 * the nodes validated before it. A node blocked at any step keeps its state (no partial steps), so
 * a later node that cannot move without it is blocked by the gates in turn.
 */
function simulateSkippingBlocked(
  start: MindPlanGraph,
  plan: WalkPlan[],
  reviewSkippers: Set<string>,
  decisionCtx: DecisionContext
): { walkable: WalkPlan[]; blocked: BlockedMember[]; warnings: string[] } {
  let graph = start;
  const root = projectRoot();
  const now = new Date().toISOString();
  const warnings = new Set<string>();
  const walkable: WalkPlan[] = [];
  const blockedRows: BlockedMember[] = [];
  for (const row of plan) {
    if (reviewSkippers.has(row.node_id)) {
      blockedRows.push({
        node_id: row.node_id,
        step: "ship",
        reason:
          "not in-review yet: walk it to in-review and review it, or pass skip_review: true to walk through in-review in this call.",
      });
      continue;
    }
    const trial = structuredClone(graph);
    const rowWarnings = new Set<string>();
    const stop = simulateRow(trial, root, row, now, decisionCtx, rowWarnings);
    if (stop) {
      blockedRows.push({ node_id: row.node_id, ...stop });
      continue;
    }
    graph = trial;
    walkable.push(row);
    for (const w of rowWarnings) warnings.add(w);
  }
  return { walkable, blocked: blockedRows, warnings: [...warnings] };
}

/** Every transition a plan makes, one `id: from -> to` line per step. */
function describePlan(plan: WalkPlan[], graph: MindPlanGraph): string[] {
  const lines: string[] = [];
  for (const row of plan) {
    let from = activeState(findNode(graph, row.node_id), row.change);
    for (const step of row.steps) {
      lines.push(`${row.node_id}: ${from} -> ${step}`);
      from = step;
    }
  }
  return lines;
}

/** Nodes a walk would take to ship without stopping at in-review first. */
function nodesSkippingReview(plan: WalkPlan[], graph: MindPlanGraph): string[] {
  return plan
    .filter(
      (row) =>
        row.steps[row.steps.length - 1] === "ship" &&
        activeState(findNode(graph, row.node_id), row.change) !== "in-review"
    )
    .map((row) => row.node_id);
}

function skipReviewBlocked(ids: string[]): string {
  return (
    `Blocked: this walk would take ${ids.map((id) => `"${id}"`).join(", ")} to ship without a review stop ` +
    `(not in-review yet). Walk to in-review first and review, or pass skip_review: true to walk through ` +
    `in-progress and in-review in this call; skipped reviews are reported.`
  );
}

const WARNING_CAP = 10;

function capWarnings(warnings: Iterable<string>): string[] {
  const list = [...new Set(warnings)];
  if (list.length <= WARNING_CAP) return list;
  return [...list.slice(0, WARNING_CAP), `... ${list.length - WARNING_CAP} more warning(s); run run_check for all.`];
}

/** One line per node: `id: from -> to`, `to` being the revision's state while it is open. */
function statusLine(row: Record<string, unknown>): string {
  const to = (row.revision_state as string | undefined) ?? (row.next_state as string | null) ?? String(row.new_state);
  return `${String(row.node_id)}: ${String(row.previous_state)} -> ${to}`;
}

/** Writes a validated scoped walk, one step at a time, and returns its lines and changed files. */
function applyWalk(
  args: StatusArgs,
  graph: MindPlanGraph,
  plan: WalkPlan[],
  simWarnings: string[],
  decisionCtx: DecisionContext
): Record<string, unknown> {
  gateWrite(
    graph,
    plan.map((row) => row.node_id),
    "update_node_status",
    args.scope === "change" ? { change: args.change } : {}
  );
  const lines: string[] = [];
  const changed = new Set<string>();
  const warnings = new Set<string>(simWarnings);
  let last: Record<string, unknown> = {};
  const rebased: Record<string, unknown>[] = [];
  for (const row of plan) {
    let first: Record<string, unknown> | null = null;
    for (const step of row.steps) {
      last = applyOneStatus({ node_id: row.node_id, new_status: step, change: row.change, decisionCtx });
      first = first ?? last;
      for (const f of (last.changed_files as string[] | undefined) ?? []) changed.add(f);
      for (const r of (last.rebased as Record<string, unknown>[] | undefined) ?? []) rebased.push({ node_id: row.node_id, ...r });
    }
    lines.push(statusLine({ ...last, previous_state: first!.previous_state }));
  }
  return {
    ordered: true,
    scope: args.scope,
    ...(args.scope === "change" ? { change: args.change } : {}),
    lines,
    changed_files: [...changed],
    ...(rebased.length ? { rebased } : {}),
    ...(warnings.size ? { warnings: capWarnings(warnings) } : {}),
    ...(args.verbose === true
      ? {
          capabilities_recomputed: last.capabilities_recomputed ?? [],
          stability_recomputed: last.stability_recomputed ?? [],
        }
      : {}),
  };
}

/** A scoped walk with `skip_blocked`: walks every node that passes and lists the ones left behind. */
function walkSkippingBlocked(
  args: StatusArgs,
  graph: MindPlanGraph,
  plan: WalkPlan[],
  skipping: string[],
  decisionCtx: DecisionContext
): Record<string, unknown> {
  const reviewSkippers = new Set(args.skip_review === true ? [] : skipping);
  // Each row is tried on a clone, so `graph` stays as loaded for describePlan and the writes.
  const sim = simulateSkippingBlocked(graph, plan, reviewSkippers, decisionCtx);
  const walkedIds = new Set(sim.walkable.map((row) => row.node_id));
  const skippedReview = skipping.filter((id) => walkedIds.has(id));
  const skipped = args.skip_review === true && skippedReview.length > 0 ? { skipped_review: skippedReview } : {};
  if (args.dry_run) {
    return {
      dry_run: true,
      scope: args.scope,
      ...(args.scope === "change" ? { change: args.change } : {}),
      plan: describePlan(sim.walkable, graph),
      blocked: sim.blocked,
      ...skipped,
      ...(sim.warnings.length ? { warnings: capWarnings(sim.warnings) } : {}),
    };
  }
  if (sim.walkable.length === 0 && sim.blocked.length > 0) {
    const reasons = sim.blocked.map((b) => `- "${b.node_id}" -> ${b.step}: ${b.reason}`).join("\n");
    throw blocked(`no node of this walk can move; nothing was written.\n${reasons}`);
  }
  return {
    ...applyWalk(args, graph, sim.walkable, sim.warnings, decisionCtx),
    ...(sim.blocked.length ? { blocked: sim.blocked } : {}),
    ...skipped,
  };
}

export function updateNodeStatus(args: StatusArgs): Record<string, unknown> {
  // A ship, promotion, or retirement ends a revision's membership; a dry run writes nothing.
  return args.dry_run ? applyStatusUpdate(args) : withChangeCleanup(() => applyStatusUpdate(args));
}

function applyStatusUpdate(args: StatusArgs): Record<string, unknown> {
  const normalized = normalizeStatusArgs(args);
  const verbose = args.verbose === true;

  if (normalized.mode === "scope") {
    const graph = loadGraph();
    const nodes = selectScopedNodes(graph, args);
    const plan: WalkPlan[] = nodes
      .map(({ node: n, change }) => ({
        node_id: n.id,
        ...(change ? { change } : {}),
        steps: stepsToTarget(n, args.new_status!, change),
      }))
      .filter((row) => row.steps.length > 0);
    const skipping = nodesSkippingReview(plan, graph);
    // One decision context (config + git probe) serves the validation and every step.
    const decisionCtx = createDecisionContext(projectRoot());
    if (args.skip_blocked === true) {
      return walkSkippingBlocked(args, graph, plan, skipping, decisionCtx);
    }
    const reviewBlock =
      skipping.length > 0 && args.skip_review !== true ? skipReviewBlocked(skipping) : null;
    const sim = simulateWalk(plan, decisionCtx);
    const skipped = args.skip_review === true && skipping.length > 0 ? { skipped_review: skipping } : {};
    if (args.dry_run) {
      return {
        dry_run: true,
        scope: args.scope,
        ...(args.scope === "change" ? { change: args.change } : {}),
        plan: describePlan(plan, graph),
        blocked: reviewBlock ?? sim.blocked,
        ...skipped,
        ...(sim.warnings.length ? { warnings: capWarnings(sim.warnings) } : {}),
      };
    }
    if (reviewBlock) {
      throw new Error(`${reviewBlock} Nothing was written.`);
    }
    if (sim.blocked) {
      throw new Error(
        `${sim.blocked}. Nothing was written: the whole walk is validated before the first transition.`
      );
    }
    return {
      ...applyWalk(args, graph, plan, sim.warnings, decisionCtx),
      ...skipped,
    };
  }

  if (args.dry_run) {
    const graph = loadGraph();
    const items =
      normalized.mode === "batch" ? orderStatusRevisions(normalized.items) : normalized.items;
    const plan: WalkPlan[] = items.map((i) => {
      const change = revisionChangeFor(findNode(graph, i.node_id), i.new_status, i.change);
      return { node_id: i.node_id, ...(change ? { change } : {}), steps: [i.new_status] };
    });
    const sim = simulateWalk(plan);
    return {
      dry_run: true,
      plan: describePlan(plan, graph),
      blocked: sim.blocked,
      ...(sim.warnings.length ? { warnings: capWarnings(sim.warnings) } : {}),
    };
  }
  gateWrite(null, normalized.items.map((i) => i.node_id), "update_node_status");

  if (normalized.mode === "single") {
    return applyOneStatus({ ...normalized.items[0], verbose: args.verbose });
  }

  const ordered = orderStatusRevisions(normalized.items);
  const applied: Record<string, unknown>[] = [];
  const decisionCtx = createDecisionContext(projectRoot());
  for (const rev of ordered) {
    try {
      applied.push(applyOneStatus({ ...rev, decisionCtx }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = message.replace(/^Blocked:\s*/, "");
      const appliedSummary = applied
        .map((row) => `${String(row.node_id)} (${String(row.new_state)})`)
        .join(", ");
      throw new Error(
        `Blocked: ${reason} Ordered status stopped on "${rev.node_id}"` +
          (appliedSummary
            ? ` after applying: ${appliedSummary}. Earlier nodes stay transitioned.`
            : " before any node in the revision was transitioned.")
      );
    }
  }
  const changed = new Set<string>();
  const warnings = new Set<string>();
  for (const row of applied) {
    const files = row.changed_files;
    if (Array.isArray(files)) {
      for (const file of files) changed.add(String(file));
    }
    const rowWarnings = row.warnings;
    if (Array.isArray(rowWarnings)) {
      for (const w of rowWarnings) warnings.add(String(w));
    }
  }
  const last = applied[applied.length - 1] ?? {};
  return {
    ordered: true,
    lines: applied.map(statusLine),
    changed_files: [...changed],
    ...(warnings.size ? { warnings: capWarnings(warnings) } : {}),
    ...(verbose
      ? {
          applied,
          stopped_on: null,
          capabilities_recomputed: last.capabilities_recomputed ?? [],
          stability_recomputed: last.stability_recomputed ?? [],
        }
      : {}),
  };
}

/**
 * The parts a revision split out of its node: the ids its next slot marks in `split_into`
 * (patch_node_territory) beyond the live list, kept only where the edge that keeps imports legal is
 * in place by now (`splitPartLinked`: a Foundation depends_on them, an Interaction shares a Capability,
 * an Interface exposes them). A split is declared, not guessed.
 */
function splitParts(graph: MindPlanGraph, node: MindPlanNode): string[] {
  if (!node.next) return [];
  const live = new Set(node.split_into ?? []);
  return (node.next.split_into ?? []).filter((id) => !live.has(id) && splitPartLinked(graph, node, id)).sort();
}

function applyOneStatus(args: {
  verbose?: boolean;
  node_id: string;
  new_status: string;
  /** Which open revision moves (optional when the node has at most one). */
  change?: string;
  /** Shared by the steps of one call so config and the git probe are read once. */
  decisionCtx?: DecisionContext;
}): Record<string, unknown> {
  const { node_id, new_status } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const change = revisionChangeFor(node, new_status, args.change);
  if (change) return applyRevisionStatus({ ...args, change }, graph, node);

  const resolved = resolveStatusChange(graph, RETIRE_STATES.has(new_status) ? liveOnly(node) : node, new_status);
  // Moves to in-review and ship run the check's import and ownership rules on this node's files.
  let warnings: string[] = [];
  if (new_status === "in-review" || new_status === "ship") {
    assertCheckCleanForNode(graph, projectRoot(), node, new_status);
    // A decision-worthy revision needs its decision recorded before review.
    if (new_status === "in-review") {
      assertDecisionForReview(graph, projectRoot(), node, args.decisionCtx);
    }
    warnings = staleTextWarnings(graph, projectRoot(), node).warnings;
  }

  const previous = node.state;
  const now = new Date().toISOString();
  let removed: string[] = [];

  if (resolved.ship) {
    // A shipped node is no longer an open revision: its change membership ends here.
    writeChangeFrontmatter(node, {
      change: node.change ? "" : undefined,
      change_ref: node.change_ref ? "" : undefined,
    });
    // A reship after force_unship carries the rate force_unship stored as of `churn_at`.
    const rateAt = node.churn_at;
    node.shipped_at = now;
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
    writeRevisionFields(node, {
      revisions: (node.revisions ?? 0) + 1,
      churn: churnAfterShip(node.churn, rateAt, now, hotspotSettings(loadProjectConfig()).half_life_days),
      churn_at: null,
    });
    // The shipped node shows its current state; its Atomic Ops ledger stays in git.
    stripLiveAtomicOps(node);
    // Once shipped, an attributed file is simply part of its owner's folder.
    if (node.attributed?.length) clearAttributed(node);
  } else {
    const retiring = RETIRE_STATES.has(resolved.state);
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
    if (retiring && isPipelineNodeType(node.type)) {
      // A retired node keeps no open revision: every revision folder goes with it.
      for (const c of openChanges(node)) removed.push(...discardRevision(node, c).changed_files);
      removed = [...removed, ...deleteNextSlotFiles(node)];
    }
  }

  const changedStability = recomputeStability(graph);
  const changedCapabilities = recomputeCapabilityStates(graph);
  const synced = syncNodes([...changedStability, ...changedCapabilities]);
  refreshPersistedMap();

  const files = [territoryPath(node, "current"), ...removed, ...synced];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    next_state: null,
    shipped_at: node.shipped_at,
    promoted_next: false,
    ...(warnings.length ? { warnings: capWarnings(warnings) } : {}),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    capabilities_recomputed: changedCapabilities.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

/**
 * A build-pipeline move of the revision of `change`: judged on `graphUnder(graph, change)` (live
 * plus that change's revisions), written with writeRevisionState, or shipped with shipRevision
 * (siblings rebased; `rebased` lists each with the conflicts it holds).
 */
function applyRevisionStatus(
  args: { verbose?: boolean; node_id: string; new_status: string; change: string; decisionCtx?: DecisionContext },
  graph: MindPlanGraph,
  node: MindPlanNode
): Record<string, unknown> {
  const { node_id, new_status, change } = args;
  const root = projectRoot();
  if (new_status === "in-review" || new_status === "ship") assertNoConflicts(node, change, new_status);
  const under = graphUnder(graph, change);
  const view = findNode(under, node_id);
  // WP4: resolveRevisionStatusChange(graph, node, change, new_status) replaces this call.
  const resolved = resolveStatusChange(under, view, new_status);
  let warnings: string[] = [];
  if (new_status === "in-review" || new_status === "ship") {
    // WP4: assertCheckCleanForRevision(graph, root, node, change, new_status) replaces this call.
    assertCheckCleanForNode(under, root, view, new_status);
    // WP2: decisionGapFor(graph, root, node, change, ctx) replaces this call.
    if (new_status === "in-review") assertDecisionForReview(under, root, view, args.decisionCtx);
    warnings = staleTextWarnings(under, root, view).warnings;
  }

  const previous = revisionFor(node, change)!.state;
  const now = new Date().toISOString();
  let files: string[];
  let rebased: { change: string; conflicts: string[] }[] = [];
  let promoted = false;
  if (resolved.promote_next) {
    const shipped = shipRevision(graph, node, change, { now, newState: resolved.state as ProductionState });
    files = shipped.changed_files;
    rebased = shipped.rebased.map((r) => ({ change: r.change, conflicts: r.conflicts.map(conflictLabel) }));
    promoted = true;
    rebuildOutgoingEdges(graph, node);
  } else if (isNextPipelineState(resolved.state)) {
    files = writeRevisionState(node, change, resolved.state).changed_files;
  } else {
    throw blocked(`"${resolved.state}" is not a revision state; a revision moves draft -> ready -> in-progress -> in-review -> ship.`);
  }

  const changedStability = recomputeStability(graph);
  const changedCapabilities = recomputeCapabilityStates(graph);
  const synced = syncNodes([...changedStability, ...changedCapabilities]);
  refreshPersistedMap();

  const revisionState = revisionFor(node, change)?.state;
  return {
    node_id,
    change,
    previous_state: previous,
    new_state: node.state,
    ...(revisionState ? { revision_state: revisionState } : {}),
    shipped_at: node.shipped_at,
    promoted_next: promoted,
    ...(rebased.length ? { rebased } : {}),
    ...(warnings.length ? { warnings: capWarnings(warnings) } : {}),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    capabilities_recomputed: changedCapabilities.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles([...files, ...synced]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function forceUnship(args: {
  verbose?: boolean;
  node_id: string;
  confirm: string;
  new_status?: "draft" | "ready" | "in-progress" | "in-review";
}): Record<string, unknown> {
  const { node_id, confirm, new_status } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  gateWrite(graph, [node_id], "force_unship");
  const open = openChanges(node);
  if (open.length > 0) {
    throw blocked(
      `"${node_id}" has open revisions (${open.map((c) => `"${c}"`).join(", ")}); ship or discard_next each before force_unship.`
    );
  }
  const target = new_status ?? "ready";
  const previous = node.state;

  // Ship dropped the ledger; the unshipped node needs one again, and the target's shape rules
  // must see it. An unship that fails before the live file is unshipped puts that file back as it
  // was, so a still-shipped node never keeps ops it did not ship with.
  const liveBefore = readMarkdown(node, "current");
  const freshOps = freshLiveAtomicOps(node);
  const now = new Date().toISOString();
  let wroteRate = false;
  const rateBefore = { revisions: node.revisions, churn: node.churn, churn_at: node.churn_at };
  try {
    resolveForceUnship(graph, node, target, confirm);

    // The in-place claim marker belongs to shipped nodes only.
    if (node.added_claims?.length) clearAddedClaims(node);
    // The node keeps its count (at least the ship being undone); shipped_at, the rate's reference
    // time, goes away, so the rate is kept as of now, with now.
    if (node.shipped_at) {
      const halfLife = hotspotSettings(loadProjectConfig()).half_life_days;
      const decayed = node.churn !== undefined ? decayChurn(node.churn, node.shipped_at, now, halfLife) : undefined;
      wroteRate = writeRevisionFields(node, {
        revisions: node.revisions ?? 1,
        ...(decayed !== undefined ? { churn: Math.round(decayed * 1000) / 1000, churn_at: now } : {}),
      });
    }

    delete node.shipped_at;
    node.state = target;
    node.updated_at = now;
    patchFrontmatter(node, "current", { clearShippedAt: true });
  } catch (err) {
    if (freshOps || wroteRate) writeMarkdown(node, liveBefore, "current");
    Object.assign(node, rateBefore);
    throw err;
  }
  const removedNext = deleteNextSlotFiles(node);

  const changedStability = recomputeStability(graph);
  const changedCapabilities = recomputeCapabilityStates(graph);
  const synced = syncNodes([...changedStability, ...changedCapabilities]);
  refreshPersistedMap();

  const files = [territoryPath(node), ...removedNext, ...synced];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    shipped_at: null,
    force_unship: true,
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    capabilities_recomputed: changedCapabilities.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}
