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
} from "../../foundations/f-domain-model/types.js";
import {
  ATTACHMENTS_DIR,
  NEXT_ATTACHMENTS_DIR,
  deleteNextSlotFiles,
  entityRelativePath,
  loadGraph,
  markdownRelativePath,
  loadProjectConfig,
  nextAttachmentsDir,
  projectRoot,
  patchFrontmatter,
  promoteNextSlot,
  writeRevisionFields,
  readMarkdown,
  writeMarkdown,
  clearAddedClaims,
  writeChangeFrontmatter,
  clearAttributed,
  stripLiveAtomicOps,
  freshLiveAtomicOps,
} from "../../foundations/f-territory-store/store.js";
import { hotspotSettings } from "../../foundations/f-source-index/config.js";
import {
  blocked,
  changeMembers,
  changeNeighbors,
  findNode,
  recomputeJourneyStates,
  recomputeStability,
  resolveForceUnship,
  resolveStatusChange,
} from "../../foundations/f-compiler-rules/rules.js";
import { assertCheckCleanForNode, staleTextWarnings } from "../../foundations/f-compiler-rules/integrity.js";
import { assertDecisionForReview, createDecisionContext, type DecisionContext } from "../../foundations/f-compiler-rules/decisions.js";
import * as fs from "fs";
import {
  changedFiles,
  clearOrphanedNeighbors,
  gateWrite,
  mutationTail,
  refreshPersistedMap,
  syncNodes,
  territoryPath,
  withNeighborCleanup,
} from "../../foundations/f-plan-writes/writes.js";

/**
 * Paths touched when discarding or promoting a next slot.
 * When `includeCopiedAttachments` is true (promote), also lists
 * `attachments/<file>` targets for each non-.gitkeep next-attachment file.
 */
export function nextSlotFsChangedFiles(
  node: Pick<MindPlanNode, "id" | "type">,
  opts: { includeCopiedAttachments: boolean }
): string[] {
  const rel = entityRelativePath(node);
  const nextAttRel = `${rel}/${NEXT_ATTACHMENTS_DIR}`;
  const attRel = `${rel}/${ATTACHMENTS_DIR}`;
  const files = [markdownRelativePath(node, "next"), nextAttRel];
  const abs = nextAttachmentsDir(node);
  if (fs.existsSync(abs)) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files.push(`${nextAttRel}/${entry.name}`);
      if (opts.includeCopiedAttachments && entry.name !== ".gitkeep") {
        files.push(`${attRel}/${entry.name}`);
      }
    }
  }
  return files;
}

function clearedFields(cleared: string[]): Record<string, unknown> {
  return cleared.length ? { cleared_neighbors: cleared } : {};
}

const STATUS_TIER: Record<string, number> = {
  Foundation: 0,
  Interaction: 1,
  Interface: 2,
  Bug: 3,
};

type StatusRevision = { node_id: string; new_status: string };

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
  /** Change id walked by `scope: "change"`. */
  change?: string;
  /** Let a scoped walk to `ship` move nodes that have not reached in-review. Reported in the result. */
  skip_review?: boolean;
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
  if (args.change !== undefined) {
    throw blocked('change is only used with scope "change".');
  }
  if (args.skip_review === true) {
    throw blocked("skip_review only applies to a scoped walk to ship.");
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
    items: [{ node_id: args.node_id, new_status: args.new_status }],
  };
}

function orderStatusRevisions(items: StatusRevision[]): StatusRevision[] {
  const graph = loadGraph();
  return items
    .map((item, index) => {
      const node = findNode(graph, item.node_id);
      if (node.type === "Journey") {
        throw blocked(
          "Journey states are computed automatically from their Interactions and cannot be set manually."
        );
      }
      return { item, index, tier: STATUS_TIER[node.type] ?? 99 };
    })
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((row) => row.item);
}

/** Active-slot state of a pipeline node: next while evolving, else live. */
function activeState(node: MindPlanNode): string {
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
  if (node.next) return true;
  if (node.shipped_at) return false;
  if (node.state === "in-progress" || node.state === "in-review") return true;
  return includePlanned && (node.state === "draft" || node.state === "ready");
}

/** Nodes a scoped call walks, in the order they must move (Foundations, Interactions, Interfaces). */
function selectScopedNodes(graph: MindPlanGraph, args: StatusArgs): MindPlanNode[] {
  let selected: MindPlanNode[];
  if (args.scope === "all_open_updates") {
    selected = graph.nodes.filter((n) => isOpenUpdate(n));
  } else if (args.scope === "change") {
    // Revisions only: neighbors have nothing to transition (a walk to ship clears their labels).
    selected = changeMembers(graph, args.change!);
    if (selected.length === 0 && changeNeighbors(graph, args.change!).length === 0) {
      throw blocked(
        `change "${args.change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
      );
    }
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
      // Edges proposed on an open next slot count too: that node ships with the new edge.
      for (const other of graph.nodes) {
        if (ids.has(other.id) || !other.next) continue;
        if (
          (other.next.depends_on ?? []).includes(current) ||
          (other.next.exposes ?? []).includes(current)
        ) {
          ids.add(other.id);
          queue.push(other.id);
        }
      }
    }
    selected = graph.nodes.filter((n) => ids.has(n.id) && isOpenUpdate(n, true));
  }
  return orderForWalk(graph, selected);
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

type WalkPlan = { node_id: string; steps: string[] };

/** Steps from a node's active state forward to the target; empty when already there or past. */
function stepsToTarget(node: MindPlanNode, target: string): string[] {
  const from = (WALK_PIPELINE as readonly string[]).indexOf(activeState(node));
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
 * The in-memory effect of promoting next over live, field for field as promoteNextSlot writes it
 * (contract scalars, edges, claims, role, decisions; the change id is dropped), so a validated walk
 * sees at every later step what the real walk will see.
 */
function promoteInMemory(
  graph: MindPlanGraph,
  node: MindPlanNode,
  state: MindPlanNode["state"],
  shippedAt: string
): void {
  const next = node.next;
  if (!next) return;
  node.title = next.title;
  node.description = next.description;
  node.state = state;
  // The revision count, rate, and split, as promoteNextSlot writes them.
  const parts = splitParts(graph, node);
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
  const assign = <K extends "belongs_to" | "depends_on" | "exposes" | "leads_to" | "mounts" | "implements">(
    key: K
  ) => {
    const value = next[key];
    if (value && value.length > 0) node[key] = [...value];
    else delete node[key];
  };
  for (const key of ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "implements"] as const) {
    assign(key);
  }
  if (next.decisions?.length) node.decisions = [...next.decisions];
  else delete node.decisions;
  if (next.role) node.role = next.role;
  delete node.change;
  delete node.change_ref;
  delete node.next;
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
    const node = findNode(graph, row.node_id);
    for (const step of row.steps) {
      try {
        const resolved = resolveStatusChange(graph, node, step);
        if (step === "in-review" || step === "ship") {
          assertCheckCleanForNode(graph, root, node, step);
          if (step === "in-review") assertDecisionForReview(graph, root, node, decisionCtx);
          for (const w of staleTextWarnings(graph, root, node).warnings) warnings.add(w);
        }
        if (resolved.promote_next) {
          promoteInMemory(graph, node, resolved.state, now);
        } else if (resolved.ship) {
          node.state = resolved.state;
          node.shipped_at = now;
        } else if (node.next && isNextPipelineState(resolved.state)) {
          node.next.state = resolved.state;
        } else {
          node.state = resolved.state;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = message.replace(/^Blocked:\s*/, "");
        return { blocked: `Blocked: ${reason} (at "${row.node_id}" -> ${step})`, warnings: [...warnings] };
      }
    }
  }
  return { blocked: null, warnings: [...warnings] };
}

/** Every transition a plan makes, one `id: from -> to` line per step. */
function describePlan(plan: WalkPlan[], graph: MindPlanGraph): string[] {
  const lines: string[] = [];
  for (const row of plan) {
    let from = activeState(findNode(graph, row.node_id));
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
        activeState(findNode(graph, row.node_id)) !== "in-review"
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

/** One line per node: `id: from -> to`, `to` being the next slot state while evolving. */
function statusLine(row: Record<string, unknown>): string {
  const to = (row.next_state as string | null) ?? String(row.new_state);
  return `${String(row.node_id)}: ${String(row.previous_state)} -> ${to}`;
}

export function updateNodeStatus(args: StatusArgs): Record<string, unknown> {
  // A ship, promotion, or retirement ends a revision's membership; a dry run writes nothing.
  return args.dry_run ? applyStatusUpdate(args) : withNeighborCleanup(() => applyStatusUpdate(args));
}

function applyStatusUpdate(args: StatusArgs): Record<string, unknown> {
  const normalized = normalizeStatusArgs(args);
  const verbose = args.verbose === true;

  if (normalized.mode === "scope") {
    const graph = loadGraph();
    const nodes = selectScopedNodes(graph, args);
    const plan: WalkPlan[] = nodes
      .map((n) => ({ node_id: n.id, steps: stepsToTarget(n, args.new_status!) }))
      .filter((row) => row.steps.length > 0);
    const skipping = nodesSkippingReview(plan, graph);
    const reviewBlock =
      skipping.length > 0 && args.skip_review !== true ? skipReviewBlocked(skipping) : null;
    // One decision context (config + git probe) serves the validation and every step.
    const decisionCtx = createDecisionContext(projectRoot());
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
    gateWrite(
      graph,
      plan.map((row) => row.node_id),
      "update_node_status",
      args.scope === "change" ? { change: args.change } : {}
    );
    const lines: string[] = [];
    const changed = new Set<string>();
    const cleared = new Set<string>();
    const warnings = new Set<string>(sim.warnings);
    let last: Record<string, unknown> = {};
    for (const row of plan) {
      let first: Record<string, unknown> | null = null;
      for (const step of row.steps) {
        last = applyOneStatus({ node_id: row.node_id, new_status: step, decisionCtx });
        first = first ?? last;
        for (const f of (last.changed_files as string[] | undefined) ?? []) changed.add(f);
      }
      lines.push(statusLine({ ...last, previous_state: first!.previous_state }));
    }
    // A change walked to ship is done. A change that had revisions is cleaned up by
    // withNeighborCleanup; a neighbor-only change never had one, so close it here.
    const plannedCleared: string[] = [];
    if (args.scope === "change" && args.new_status === "ship") {
      const orphaned = clearOrphanedNeighbors(loadGraph(), [args.change!]);
      for (const f of orphaned.files) changed.add(f);
      for (const id of orphaned.cleared) cleared.add(id);
      plannedCleared.push(...orphaned.planned);
    }
    return {
      ordered: true,
      scope: args.scope,
      ...(args.scope === "change" ? { change: args.change } : {}),
      lines,
      ...skipped,
      ...clearedFields([...cleared]),
      ...(plannedCleared.length ? { cleared_planned: plannedCleared } : {}),
      changed_files: [...changed],
      ...(warnings.size ? { warnings: capWarnings(warnings) } : {}),
      ...(verbose
        ? {
            journeys_recomputed: last.journeys_recomputed ?? [],
            stability_recomputed: last.stability_recomputed ?? [],
          }
        : {}),
    };
  }

  if (args.dry_run) {
    const graph = loadGraph();
    const items =
      normalized.mode === "batch" ? orderStatusRevisions(normalized.items) : normalized.items;
    const plan: WalkPlan[] = items.map((i) => ({ node_id: i.node_id, steps: [i.new_status] }));
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
          journeys_recomputed: last.journeys_recomputed ?? [],
          stability_recomputed: last.stability_recomputed ?? [],
        }
      : {}),
  };
}

/**
 * The parts a revision split out of its node: the ids its next slot marks in `split_into`
 * (patch_node_territory) beyond the live list, kept only where the edge that keeps imports legal is
 * in place by now (`splitPartLinked`: a Foundation depends_on them, an Interaction shares a Journey,
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
  /** Shared by the steps of one call so config and the git probe are read once. */
  decisionCtx?: DecisionContext;
}): Record<string, unknown> {
  const { node_id, new_status } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);

  const resolved = resolveStatusChange(graph, node, new_status);
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

  const previous = node.next ? node.next.state : node.state;
  const now = new Date().toISOString();
  let promoted = false;
  let promoteSlotFiles: string[] = [];
  let removedNext: string[] = [];
  let clearedLabel: string | undefined;

  if (resolved.promote_next) {
    promoteSlotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: true });
    promoteNextSlot(node, resolved.state, now, { splitInto: splitParts(graph, node) });
    promoted = true;
    rebuildOutgoingEdges(graph, node);
  } else if (resolved.ship) {
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
  } else if (node.next && isNextPipelineState(resolved.state)) {
    node.next.state = resolved.state;
    node.next.updated_at = now;
    patchFrontmatter(
      {
        id: node.id,
        type: node.type,
        state: resolved.state,
        updated_at: now,
      },
      "next"
    );
  } else {
    const retiring =
      resolved.state === "deprecated" || resolved.state === "cancelled";
    // A retired shipped node is nobody's neighbor: drop its live label.
    if (retiring && node.shipped_at && node.change) {
      clearedLabel = node.change;
      writeChangeFrontmatter(node, { change: "" }, "current");
    }
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
    if (retiring && isPipelineNodeType(node.type)) {
      removedNext = deleteNextSlotFiles(node);
    }
  }

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  const synced = syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const primaryPaths: string[] = [];
  if (promoted) {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(...promoteSlotFiles);
  } else if (resolved.ship) {
    primaryPaths.push(territoryPath(node, "current"));
  } else if (node.next && isNextPipelineState(resolved.state)) {
    primaryPaths.push(territoryPath(node, "next"));
  } else {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(...removedNext);
  }
  const files = [...primaryPaths, ...synced];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    next_state: node.next?.state ?? null,
    shipped_at: node.shipped_at,
    promoted_next: promoted,
    ...(clearedLabel ? { cleared_change: clearedLabel } : {}),
    ...(warnings.length ? { warnings: capWarnings(warnings) } : {}),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files, true),
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
  const target = new_status ?? "ready";
  const previous = node.state;

  // Ship dropped the ledger; the unshipped node needs one again, and the target's shape rules
  // must see it. An unship that fails before the live file is unshipped puts that file back as it
  // was, so a still-shipped node never keeps ops it did not ship with.
  const liveBefore = readMarkdown(node, "current");
  const freshOps = freshLiveAtomicOps(node);
  const clearedChange = node.change;
  const now = new Date().toISOString();
  let wroteRate = false;
  const rateBefore = { revisions: node.revisions, churn: node.churn, churn_at: node.churn_at };
  try {
    resolveForceUnship(graph, node, target, confirm);

    // A pre-ship node's live `change` is a revision's membership: drop the shipped node's neighbor
    // label so the unshipped node is not silently a revision of that change. The in-place claim
    // marker belongs to shipped nodes only.
    if (clearedChange) writeChangeFrontmatter(node, { change: "" }, "current");
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
    if (freshOps || clearedChange || wroteRate) writeMarkdown(node, liveBefore, "current");
    Object.assign(node, rateBefore);
    throw err;
  }
  const removedNext = deleteNextSlotFiles(node);

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  const synced = syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const files = [territoryPath(node), ...removedNext, ...synced];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    shipped_at: null,
    force_unship: true,
    ...(clearedChange ? { cleared_change: clearedChange } : {}),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}
