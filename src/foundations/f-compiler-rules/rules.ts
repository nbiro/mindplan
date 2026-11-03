/**
 * The Compiler Rules — strict validation for MindPlan state mutations.
 * Every violation throws an Error whose message starts with "Blocked: ".
 */

import type {
  BugState,
  EdgeType,
  ExecutionState,
  FoundationRole,
  CapabilityState,
  MindPlanGraph,
  MindPlanNode,
  NextPipelineState,
  NodeState,
  ProductionState,
} from "../f-domain-model/types.js";
import {
  BUG_STATES,
  BUG_TRANSITIONS,
  EXECUTION_STATES,
  EXECUTION_TRANSITIONS,
  isBugState,
  isExecutionState,
  isNextPipelineState,
  isOpenBugState,
  isPipelineNodeType,
  isProductionState,
  PRE_SHIP_STATES,
  PRODUCTION_TRANSITIONS,
  SHIP_TRANSITION,
} from "../f-domain-model/types.js";
import {
  claimEntryExists,
  expandClaims,
} from "../f-source-index/claims.js";
import { listResolvedImports } from "../f-source-index/imports.js";
import { parseChecklistItems, type ChecklistItem } from "../f-territory-store/checklist.js";
import { countCheckboxesInText } from "../f-territory-store/store.js";
import {
  graphUnder,
  openChanges,
  resolveRevisionChange,
  revisionFor,
  withRevision,
} from "../f-revision-model/index.js";
import { assertMinimumTerritoryShape, slotSource } from "./shape.js";
import { dependencyGate } from "./checklist-gates.js";

export { openHumanItems, type OpenHumanItem } from "./checklist-gates.js";

/** How a dependency stops holding up its dependents' ship. */
const DEPENDENCY_READY =
  "A dependency counts once stable, or in-review with at least one checklist item, every build item ticked, and its own dependencies counting the same way.";

export function blocked(message: string): Error {
  return new Error(`Blocked: ${message}`);
}

export { assertMinimumTerritoryShape } from "./shape.js";

function runMinimumTerritoryShape(
  node: MindPlanNode,
  newStatus: string,
  slot: "current" | "next" = "current"
): void {
  if (
    newStatus === "ready" ||
    newStatus === "in-review" ||
    newStatus === SHIP_TRANSITION ||
    newStatus === "resolved"
  ) {
    assertMinimumTerritoryShape(node, slot);
  }
}

/** True when the node's `next` is the view of one of its open revisions. */
function nextIsRevisionView(n: MindPlanNode): boolean {
  return Boolean(n.next?.change && revisionFor(n, n.next.change));
}

/**
 * The graph with every `next` view the loader filled from a single open revision removed: live
 * only, so no change's revision is visible.
 */
export function liveGraph(graph: MindPlanGraph): MindPlanGraph {
  if (!graph.nodes.some(nextIsRevisionView)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (!nextIsRevisionView(n)) return n;
      const copy = { ...n };
      delete copy.next;
      return copy;
    }),
  };
}

/**
 * The graph a revision of `change` is judged against: live with only that change's revisions applied (`graphUnder` over `liveGraph`). A next view the loader filled from a
 * revision of another change is invisible here.
 */
export function revisionGraph(graph: MindPlanGraph, change: string): MindPlanGraph {
  return graphUnder(liveGraph(graph), change);
}

/**
 * The node as change `change` sees it: live plus its revision of `change` (`withRevision`), or the
 * node as is when it has none.
 */
export function nodeUnder(node: MindPlanNode, change: string): MindPlanNode {
  return revisionFor(node, change) ? withRevision(node, change) : node;
}

/** True when `n` is a member of change `change` (see `changeMembers`). */
export function isRevisionOf(n: MindPlanNode, change: string): boolean {
  if (!isPipelineNodeType(n.type)) return false;
  if (n.shipped_at) return Boolean(revisionFor(n, change));
  return n.change === change && n.state !== "cancelled" && n.state !== "deprecated";
}

/**
 * Open revisions in a change: Foundations, Interactions, and Interfaces that belong to `change` —
 * a shipped node with an open revision of it, or a pre-ship node
 * whose live `change` it is and that is not retired. Draft and ready revisions belong too. A
 * shipped member is returned as `nodeUnder(node, change)`: a view whose `next` is that change's
 * revision, so slot-reading code judges this change only. Views are copies: write through the
 * graph's own node (find it by id).
 */
export function changeMembers(graph: MindPlanGraph, change: string): MindPlanNode[] {
  return graph.nodes.filter((n) => isRevisionOf(n, change)).map((n) => nodeUnder(n, change));
}

/** Every change a node is an open revision of: its open revisions, or its pre-ship change. */
export function nodeChanges(n: MindPlanNode): string[] {
  if (!isPipelineNodeType(n.type)) return [];
  if (n.shipped_at) return [...new Set(openChanges(n))].sort();
  if (!n.change || n.state === "cancelled" || n.state === "deprecated") return [];
  return [n.change];
}

/** Every change id that has at least one open revision. */
export function changesWithRevisions(graph: MindPlanGraph): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) for (const c of nodeChanges(n)) out.add(c);
  return out;
}

/** Every open revision of a node as a view each (`nodeUnder`). Empty when none is open. */
export function revisionViews(n: MindPlanNode): MindPlanNode[] {
  return openChanges(n).map((c) => nodeUnder(n, c));
}

export function findNode(graph: MindPlanGraph, id: string): MindPlanNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) {
    throw blocked(`node "${id}" does not exist in mindplan territory.`);
  }
  return node;
}

function edgesFrom(graph: MindPlanGraph, sourceId: string, type: EdgeType): MindPlanNode[] {
  return graph.edges
    .filter((e) => e.source === sourceId && e.type === type)
    .map((e) => findNode(graph, e.target));
}

/** Interactions linked to a Capability via belongs_to edges. */
export function interactionsOfCapability(graph: MindPlanGraph, capabilityId: string): MindPlanNode[] {
  return graph.edges
    .filter((e) => e.type === "belongs_to" && e.target === capabilityId)
    .map((e) => findNode(graph, e.source))
    .filter((n) => n.type === "Interaction");
}

function isShipped(node: MindPlanNode): boolean {
  return isPipelineNodeType(node.type) && !!node.shipped_at;
}

/** Open Bugs with an affects edge pointing at targetId. */
export function openBugsAffecting(graph: MindPlanGraph, targetId: string): MindPlanNode[] {
  return graph.edges
    .filter((e) => e.type === "affects" && e.target === targetId)
    .map((e) => findNode(graph, e.source))
    .filter((n) => n.type === "Bug" && isOpenBugState(n.state));
}

/** Nodes with a direct depends_on edge pointing at targetId. */
export function dependentsOf(graph: MindPlanGraph, targetId: string): MindPlanNode[] {
  return graph.edges
    .filter((e) => e.type === "depends_on" && e.target === targetId)
    .map((e) => findNode(graph, e.source))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function computeProductionState(
  graph: MindPlanGraph,
  nodeId: string
): ProductionState {
  return openBugsAffecting(graph, nodeId).length > 0 ? "unstable" : "stable";
}

function runCompletionCheck(
  node: MindPlanNode,
  targetLabel: string,
  slot: "current" | "next" = "current"
): void {
  const source = slotSource(node, slot);
  if (source.text === null) {
    throw blocked(`${slot} file not found for node "${node.id}" (expected at ${source.relPath}).`);
  }
  const unchecked = countCheckboxesInText(source.text).unchecked;
  const file = source.file;
  if (unchecked > 0) {
    throw blocked(
      `Completion Check. ${unchecked} unchecked checkbox(es) remain in ${node.id}/${file}. All [ ] items must be [x] before moving to "${targetLabel}".`
    );
  }
}

/** Pre-ship Interaction/Interface/Foundation title/description/role edits; shipped scope changes use open_next. */
export function assertPipelineTerritoryScalarsEditable(
  node: MindPlanNode,
  field: "title" | "description" | "role",
  slot: "current" | "next" = "current"
): void {
  if (field === "role") {
    if (node.type !== "Foundation") {
      throw blocked(`role only applies to Foundations; "${node.id}" is a ${node.type}.`);
    }
  } else if (node.type !== "Interaction" && node.type !== "Interface" && node.type !== "Foundation") {
    return;
  }
  if (slot === "next") {
    if (!node.next) {
      throw blocked(
        `cannot edit ${field} on next: "${node.id}" has no open revision. Open one with open_next({ node_id: "${node.id}", change }).`
      );
    }
    return;
  }
  if (isProductionState(node.state) || node.state === "deprecated" || node.state === "cancelled") {
    throw blocked(
      `${field} cannot be changed on ${node.type} "${node.id}" (${node.state}). ` +
        (node.state === "cancelled"
          ? `Cancelled ${node.type}s are terminal.`
          : "Use open_next for material scope changes on live work.")
    );
  }
  if (!(PRE_SHIP_STATES as readonly string[]).includes(node.state)) {
    throw blocked(
      `${field} cannot be changed on ${node.type} "${node.id}" in state "${node.state}". ` +
        `Allowed pre-ship states: ${PRE_SHIP_STATES.join(", ")}.`
    );
  }
}

/** @deprecated Use assertPipelineTerritoryScalarsEditable */
export function assertWorkflowTerritoryScalarsEditable(
  node: MindPlanNode,
  field: "title" | "description",
  slot: "current" | "next" = "current"
): void {
  assertPipelineTerritoryScalarsEditable(node, field, slot);
}

/**
 * Active-slot implements must be non-empty and every entry must exist on disk
 * when entering in-review or ship.
 */
export function assertImplementsForReviewOrShip(
  node: MindPlanNode,
  slot: "current" | "next" = "current",
  root?: string
): void {
  if (!isPipelineNodeType(node.type)) return;
  const entries =
    slot === "next" && node.next ? node.next.implements ?? [] : node.implements ?? [];
  if (entries.length === 0) {
    throw blocked(
      `Implements required. "${node.id}" ${slot === "next" ? "next " : ""}must declare a non-empty ` +
        `implements list via set_implementation_files before in-review / ship.`
    );
  }
  const missing: string[] = [];
  for (const entry of entries) {
    if (!claimEntryExists(entry, root)) missing.push(entry);
  }
  if (missing.length > 0) {
    throw blocked(
      `Implements presence. "${node.id}" ${slot === "next" ? "next " : ""}implements entries ` +
        `missing on disk: ${missing.map((m) => `"${m}"`).join(", ")}.`
    );
  }
}

function runImplementsGate(
  node: MindPlanNode,
  newStatus: string,
  slot: "current" | "next" = "current"
): void {
  if (newStatus === "in-review" || newStatus === SHIP_TRANSITION) {
    assertImplementsForReviewOrShip(node, slot);
  }
}

/**
 * Effective Foundation role (next.role while evolving, else live role, else description tag).
 */
export function effectiveRole(node: MindPlanNode): FoundationRole | undefined {
  if (node.type !== "Foundation") return undefined;
  if (node.next?.role) return node.next.role;
  if (node.role) return node.role;
  const desc = node.next?.description ?? node.description ?? "";
  if (/^Assembler\b/i.test(desc)) return "assembler";
  if (/^Infra\b/i.test(desc)) return "infra";
  if (/^Design system\b/i.test(desc)) return "design-system";
  if (/^Adapter\b/i.test(desc)) return "adapter";
  return undefined;
}

/**
 * Transitive depends_on Foundations. Stops at assembler (does not continue past it).
 * While next is open, live and next edges both count (union of targets).
 */
export function reachableFoundations(
  node: MindPlanNode,
  graph: MindPlanGraph
): MindPlanNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const result: MindPlanNode[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];

  function pushDeps(n: MindPlanNode): void {
    const ids = new Set<string>(n.depends_on ?? []);
    if (n.next?.depends_on) {
      for (const id of n.next.depends_on) ids.add(id);
    }
    for (const id of ids) stack.push(id);
  }

  pushDeps(node);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const target = byId.get(id);
    if (!target || target.type !== "Foundation") continue;
    result.push(target);
    if (effectiveRole(target) === "assembler") continue;
    pushDeps(target);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Import matrix: may `fromOwner` import a file owned by `toOwner`?
 */
export function importAllowed(
  fromOwner: MindPlanNode,
  toOwner: MindPlanNode,
  graph: MindPlanGraph
): boolean {
  if (fromOwner.id === toOwner.id) return true;

  const reachableIds = new Set(reachableFoundations(fromOwner, graph).map((n) => n.id));

  if (fromOwner.type === "Interaction") {
    return toOwner.type === "Foundation" && reachableIds.has(toOwner.id);
  }

  if (fromOwner.type === "Interface") {
    if (toOwner.type === "Foundation" && reachableIds.has(toOwner.id)) return true;
    if (toOwner.type === "Interaction") {
      return effectiveExposes(fromOwner).includes(toOwner.id);
    }
    return false;
  }

  if (fromOwner.type === "Foundation") {
    if (toOwner.type === "Foundation" && reachableIds.has(toOwner.id)) return true;
    // A composition root: a Foundation may import exactly the Interfaces it mounts.
    if (toOwner.type === "Interface" && effectiveMounts(fromOwner).includes(toOwner.id)) {
      return true;
    }
    if (effectiveRole(fromOwner) === "assembler") {
      // Assembler may import Interfaces/Interactions that depends_on it (live or next).
      if (toOwner.type === "Interface" || toOwner.type === "Interaction") {
        const deps = new Set<string>(toOwner.depends_on ?? []);
        if (toOwner.next?.depends_on) {
          for (const id of toOwner.next.depends_on) deps.add(id);
        }
        return deps.has(fromOwner.id);
      }
    }
    return false;
  }

  return false;
}

/**
 * Taxonomy rules for link_nodes:
 *   Interaction --belongs_to--> Capability
 *   Interaction|Interface --depends_on--> Foundation
 *   Foundation --depends_on--> Foundation
 *   Interface --exposes--> Interaction
 *   Foundation --mounts--> Interface
 *   Interaction --leads_to--> Interaction
 *   Bug --affects--> Interaction|Interface|Foundation
 *
 * Interaction → Interaction depends_on is illegal (Interaction Independence).
 */
export function validateLink(source: MindPlanNode, target: MindPlanNode, edgeType: EdgeType): void {
  if (source.id === target.id) {
    throw blocked(`cannot link node "${source.id}" to itself.`);
  }
  if (edgeType === "affects") {
    if (source.type !== "Bug") {
      throw blocked(
        `affects edges must originate from a Bug. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}".`
      );
    }
    if (
      target.type !== "Interaction" &&
      target.type !== "Interface" &&
      target.type !== "Foundation"
    ) {
      throw blocked(
        `affects edges must target an Interaction, Interface, or Foundation. Got Bug "${source.id}" -> ${target.type} "${target.id}".`
      );
    }
    return;
  }
  if (edgeType === "mounts") {
    if (source.type !== "Foundation" || target.type !== "Interface") {
      throw blocked(
        `mounts edges must go Foundation -> Interface. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}". ` +
          `A composition root (registry, route dispatcher) is a Foundation that mounts the Interfaces it imports.`
      );
    }
    return;
  }
  if (edgeType === "belongs_to") {
    if (source.type !== "Interaction" || target.type !== "Capability") {
      throw blocked(
        `belongs_to edges must go Interaction -> Capability. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}".`
      );
    }
    return;
  }
  if (edgeType === "exposes") {
    if (source.type !== "Interface" || target.type !== "Interaction") {
      throw blocked(
        `exposes edges must go Interface -> Interaction. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}".`
      );
    }
    return;
  }
  if (edgeType === "leads_to") {
    if (source.type !== "Interaction" || target.type !== "Interaction") {
      throw blocked(
        `leads_to edges must go Interaction -> Interaction. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}".`
      );
    }
    return;
  }
  // depends_on
  if (source.type === "Interaction" && target.type === "Interaction") {
    throw blocked(
      `Interaction Independence. Interactions must not depend_on each other. ` +
        `"${source.id}" -> "${target.id}" is illegal — share application state through a Foundation instead. ` +
        `Use leads_to for Capability navigation/progression only.`
    );
  }
  if (target.type !== "Foundation") {
    throw blocked(
      `depends_on edges must target a Foundation. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}".`
    );
  }
  if (
    source.type !== "Interaction" &&
    source.type !== "Interface" &&
    source.type !== "Foundation"
  ) {
    throw blocked(
      `depends_on edges must originate from an Interaction, Interface, or Foundation. Got ${source.type} "${source.id}" -> Foundation "${target.id}".`
    );
  }
}

/**
 * Outgoing depends_on for cycle/closure checks: proposed next.depends_on while
 * evolving a shipped pipeline node, otherwise live depends_on.
 */
export function effectiveDependsOn(node: MindPlanNode): string[] {
  if (node.next && isPipelineNodeType(node.type)) {
    return node.next.depends_on ?? [];
  }
  return node.depends_on ?? [];
}

/**
 * Outgoing belongs_to: proposed next.belongs_to while evolving a shipped Interaction,
 * otherwise live belongs_to.
 */
export function effectiveBelongsTo(node: MindPlanNode): string[] {
  if (node.next && node.type === "Interaction") {
    return node.next.belongs_to ?? [];
  }
  return node.belongs_to ?? [];
}

/** Outgoing exposes: proposed next.exposes while evolving a shipped Interface. */
export function effectiveExposes(node: MindPlanNode): string[] {
  if (node.next && node.type === "Interface") {
    return node.next.exposes ?? [];
  }
  return node.exposes ?? [];
}

/** Outgoing mounts: proposed next.mounts while evolving a shipped Foundation. */
export function effectiveMounts(node: MindPlanNode): string[] {
  if (node.next && node.type === "Foundation") {
    return node.next.mounts ?? [];
  }
  return node.mounts ?? [];
}

/** Outgoing leads_to: proposed next.leads_to while evolving a shipped Interaction. */
export function effectiveLeadsTo(node: MindPlanNode): string[] {
  if (node.next && node.type === "Interaction") {
    return node.next.leads_to ?? [];
  }
  return node.leads_to ?? [];
}

/** Outgoing depends_on targets for a node id, optionally including a proposed edge. */
function dependsOnTargets(
  graph: MindPlanGraph,
  nodeId: string,
  proposed?: { source: string; target: string }
): string[] {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const targets = node ? [...effectiveDependsOn(node)] : [];
  if (
    proposed &&
    proposed.source === nodeId &&
    !targets.includes(proposed.target)
  ) {
    targets.push(proposed.target);
  }
  return targets;
}

/** Returns true if targetId is reachable from startId via effective depends_on edges. */
function hasDependsOnPath(
  graph: MindPlanGraph,
  startId: string,
  targetId: string,
  proposed?: { source: string; target: string }
): boolean {
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const t of dependsOnTargets(graph, current, proposed)) {
      stack.push(t);
    }
  }
  return false;
}

/** Rejects depends_on edges that would create a cycle in the effective dependency graph. */
export function assertAcyclicDependsOn(
  graph: MindPlanGraph,
  sourceId: string,
  targetId: string
): void {
  if (sourceId === targetId) {
    throw blocked(
      `depends_on edge ${sourceId} -> ${targetId} would create a dependency cycle.`
    );
  }
  const proposed = { source: sourceId, target: targetId };
  if (hasDependsOnPath(graph, targetId, sourceId, proposed)) {
    throw blocked(
      `depends_on edge ${sourceId} -> ${targetId} would create a dependency cycle.`
    );
  }
}

/**
 * Rejects a cyclic effective depends_on DAG (live + next.depends_on).
 * Used as a ship-promote safety net after link-time checks.
 */
export function assertEffectiveDependsOnAcyclic(graph: MindPlanGraph): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.nodes) color.set(n.id, WHITE);

  function visit(id: string): string | null {
    color.set(id, GRAY);
    for (const t of dependsOnTargets(graph, id)) {
      const c = color.get(t) ?? WHITE;
      if (c === GRAY) return id;
      if (c === WHITE) {
        const hit = visit(t);
        if (hit) return hit;
      }
    }
    color.set(id, BLACK);
    return null;
  }

  for (const n of graph.nodes) {
    if ((color.get(n.id) ?? WHITE) !== WHITE) continue;
    const hit = visit(n.id);
    if (hit) {
      throw blocked(
        `depends_on graph contains a cycle involving proposed next edges (detected near "${hit}").`
      );
    }
  }
}

/**
 * Validates open_next preconditions (Rule 9). With `change`, a shipped node may hold several open
 * revisions: only a second revision of the same change is
 * Blocked. Without `change` (legacy callers), any open evolution Blocks.
 */
export function validateOpenNext(node: MindPlanNode, change?: string): void {
  if (!isPipelineNodeType(node.type)) {
    throw blocked(`only Foundations, Interactions, and Interfaces open revisions. Got ${node.type} "${node.id}".`);
  }
  if (node.state !== "stable" && node.state !== "unstable") {
    throw blocked(
      `only shipped Foundations/Interactions/Interfaces (stable or unstable) open revisions. "${node.id}" is currently "${node.state}".`
    );
  }
  if (change !== undefined) {
    const open = revisionFor(node, change);
    if (open) {
      throw blocked(
        `"${node.id}" already has an open revision of change "${change}" in state "${open.state}". ` +
          `Edit it (pass change: "${change}"), ship it, or discard_next({ node_id: "${node.id}", change: "${change}" }).`
      );
    }
    return;
  }
  if (node.next) {
    throw blocked(
      `"${node.id}" already has an open revision in state "${node.next.state}". Ship or discard_next before opening another.`
    );
  }
  if (node.open_revisions?.length) {
    throw blocked(
      `"${node.id}" already has open revisions ${openChanges(node).map((c) => `"${c}"`).join(", ")}; pass change to open another.`
    );
  }
  // A shipped node has no next file until open_next writes one.
}

export type DependentEntry = { node: MindPlanNode; distance: number };

/** Transitive dependents via reverse depends_on (BFS) from a single seed. */
export function transitiveDependents(
  graph: MindPlanGraph,
  nodeId: string
): DependentEntry[] {
  return reverseDependsOnClosure(graph, [nodeId]);
}

/** Blast-radius dependents: reverse-`depends_on` BFS from `nodeId`. */
export function blastRadiusDependents(
  graph: MindPlanGraph,
  nodeId: string
): { affected: DependentEntry[] } {
  return {
    affected: reverseDependsOnClosure(graph, [nodeId]),
  };
}

/** Reverse-depends_on BFS from one or more distance-0 seeds (seeds omitted from results). */
function reverseDependsOnClosure(
  graph: MindPlanGraph,
  seeds: string[]
): DependentEntry[] {
  const result: DependentEntry[] = [];
  const seen = new Set<string>(seeds);
  const queue: { id: string; distance: number }[] = seeds.map((id) => ({
    id,
    distance: 0,
  }));

  while (queue.length > 0) {
    const { id: current, distance } = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.target !== current || edge.type !== "depends_on") continue;
      const sourceId = edge.source;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const node = findNode(graph, sourceId);
      const d = distance + 1;
      result.push({ node, distance: d });
      queue.push({ id: sourceId, distance: d });
    }
  }

  return result.sort(
    (a, b) => a.distance - b.distance || a.node.id.localeCompare(b.node.id)
  );
}

export type ReachabilityEntry = { node: MindPlanNode; distance: number };

/** Downstream Interactions reachable via leads_to (BFS). Cycles allowed; each node once. */
export function leadsToDownstream(
  graph: MindPlanGraph,
  interactionId: string
): ReachabilityEntry[] {
  const result: ReachabilityEntry[] = [];
  const seen = new Set<string>([interactionId]);
  const queue: { id: string; distance: number }[] = [{ id: interactionId, distance: 0 }];

  while (queue.length > 0) {
    const { id: current, distance } = queue.shift()!;
    const currentNode = graph.nodes.find((n) => n.id === current);
    const targets = currentNode ? effectiveLeadsTo(currentNode) : [];
    // Also walk live edges in case frontmatter arrays and edges diverge
    for (const edge of graph.edges) {
      if (edge.source === current && edge.type === "leads_to" && !targets.includes(edge.target)) {
        targets.push(edge.target);
      }
    }
    for (const targetId of targets) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      const node = findNode(graph, targetId);
      if (node.type !== "Interaction") continue;
      const d = distance + 1;
      result.push({ node, distance: d });
      queue.push({ id: targetId, distance: d });
    }
  }

  return result.sort(
    (a, b) => a.distance - b.distance || a.node.id.localeCompare(b.node.id)
  );
}

/** Interfaces that expose the given Interaction (via exposes edges / effectiveExposes). */
export function interfacesExposing(
  graph: MindPlanGraph,
  interactionId: string
): MindPlanNode[] {
  const result: MindPlanNode[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type !== "exposes" || edge.target !== interactionId) continue;
    if (seen.has(edge.source)) continue;
    seen.add(edge.source);
    const node = findNode(graph, edge.source);
    if (node.type === "Interface") result.push(node);
  }
  for (const node of graph.nodes) {
    if (node.type !== "Interface") continue;
    if (effectiveExposes(node).includes(interactionId) && !seen.has(node.id)) {
      seen.add(node.id);
      result.push(node);
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Capabilities that contain the given Interaction via belongs_to. */
export function capabilitiesContaining(
  graph: MindPlanGraph,
  interactionId: string
): MindPlanNode[] {
  const interaction = findNode(graph, interactionId);
  const capabilityIds = effectiveBelongsTo(interaction);
  const fromEdges = graph.edges
    .filter((e) => e.type === "belongs_to" && e.source === interactionId)
    .map((e) => e.target);
  const all = new Set([...capabilityIds, ...fromEdges]);
  return [...all]
    .map((id) => findNode(graph, id))
    .filter((n) => n.type === "Capability")
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reachability impact analysis for an Interaction focus. */
export function interactionReachability(
  graph: MindPlanGraph,
  interactionId: string
): {
  exposing_interfaces: MindPlanNode[];
  containing_capabilities: MindPlanNode[];
  leads_to_downstream: ReachabilityEntry[];
} {
  return {
    exposing_interfaces: interfacesExposing(graph, interactionId),
    containing_capabilities: capabilitiesContaining(graph, interactionId),
    leads_to_downstream: leadsToDownstream(graph, interactionId),
  };
}

export type StatusChangeResult = {
  state: NodeState;
  /** When true, caller must set shipped_at before persisting (first ship or promote next). */
  ship: boolean;
  /** When true, ship promotes `<id>.next.mdx` over `<id>.mdx`. */
  promote_next: boolean;
};

function validateShipTransition(graph: MindPlanGraph, node: MindPlanNode): ProductionState {
  if (!isPipelineNodeType(node.type)) {
    throw blocked(`only Foundations, Interactions, and Interfaces can ship to production.`);
  }
  const dependencySatisfied = dependencyGate(graph);

  if (node.next) {
    if (node.next.state !== "in-review") {
      throw blocked(
        `ship is only allowed from a revision in-review. "${node.id}" revision is currently "${node.next.state}".`
      );
    }
    runCompletionCheck(node, SHIP_TRANSITION, "next");
    runMinimumTerritoryShape(node, SHIP_TRANSITION, "next");
    runImplementsGate(node, SHIP_TRANSITION, "next");
    assertEffectiveDependsOnAcyclic(graph);

    if (node.type === "Interaction") {
      const depIds = node.next.depends_on ?? [];
      const deps = depIds.map((id) => findNode(graph, id));
      const foundations = deps.filter((n) => n.type === "Foundation");
      const notStable = foundations.filter((n) => !dependencySatisfied(n));
      if (notStable.length > 0) {
        const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
        throw blocked(
          `Infrastructure First. Interaction "${node.id}" next cannot ship while linked Foundations are not stable: ${list}. ${DEPENDENCY_READY}`
        );
      }
    }

    if (node.type === "Interface") {
      const exposedIds = node.next.exposes ?? [];
      const exposed = exposedIds.map((id) => findNode(graph, id));
      const notStable = exposed.filter((n) => !dependencySatisfied(n));
      if (notStable.length > 0) {
        const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
        throw blocked(
          `Behavior First. Interface "${node.id}" next cannot ship while exposed Interactions are not stable: ${list}. ${DEPENDENCY_READY}`
        );
      }
      const depIds = node.next.depends_on ?? [];
      const foundations = depIds
        .map((id) => findNode(graph, id))
        .filter((n) => n.type === "Foundation");
      const foundationsNotStable = foundations.filter((n) => !dependencySatisfied(n));
      if (foundationsNotStable.length > 0) {
        const list = foundationsNotStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
        throw blocked(
          `Infrastructure First. Interface "${node.id}" next cannot ship while linked Foundations are not stable: ${list}. ${DEPENDENCY_READY}`
        );
      }
    }

    return computeProductionState(graph, node.id);
  }

  if (node.state !== "in-review") {
    throw blocked(
      `ship is only allowed from in-review. "${node.id}" is currently "${node.state}".`
    );
  }
  runCompletionCheck(node, SHIP_TRANSITION, "current");
  runMinimumTerritoryShape(node, SHIP_TRANSITION, "current");
  runImplementsGate(node, SHIP_TRANSITION, "current");

  if (node.type === "Interaction") {
    const foundations = edgesFrom(graph, node.id, "depends_on").filter(
      (n) => n.type === "Foundation"
    );
    const notStable = foundations.filter((n) => !dependencySatisfied(n));
    if (notStable.length > 0) {
      const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
      throw blocked(
        `Infrastructure First. Interaction "${node.id}" cannot ship while linked Foundations are not stable: ${list}. ${DEPENDENCY_READY}`
      );
    }
  }

  if (node.type === "Interface") {
    const exposed = edgesFrom(graph, node.id, "exposes");
    const notStable = exposed.filter((n) => !dependencySatisfied(n));
    if (notStable.length > 0) {
      const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
      throw blocked(
        `Behavior First. Interface "${node.id}" cannot ship while exposed Interactions are not stable: ${list}. ${DEPENDENCY_READY}`
      );
    }
    const foundations = edgesFrom(graph, node.id, "depends_on").filter(
      (n) => n.type === "Foundation"
    );
    const foundationsNotStable = foundations.filter((n) => !dependencySatisfied(n));
    if (foundationsNotStable.length > 0) {
      const list = foundationsNotStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
      throw blocked(
        `Infrastructure First. Interface "${node.id}" cannot ship while linked Foundations are not stable: ${list}. ${DEPENDENCY_READY}`
      );
    }
  }

  return computeProductionState(graph, node.id);
}

function validateBugRules(graph: MindPlanGraph, bug: MindPlanNode, newStatus: BugState): void {
  const targets = edgesFrom(graph, bug.id, "affects");

  if (newStatus === "triaged" || newStatus === "fixing") {
    if (targets.length === 0) {
      throw blocked(
        `Ghost Bug. "${bug.id}" has no affects edge to an Interaction, Interface, or Foundation. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
  }

  if (newStatus === "in-review" || newStatus === "resolved") {
    if (newStatus === "resolved") {
      runCompletionCheck(bug, newStatus, "current");
    }
    runMinimumTerritoryShape(bug, newStatus, "current");
  }
}

function validateInteractionRulesForEdges(
  interaction: MindPlanNode,
  newStatus: ExecutionState | NextPipelineState,
  belongsTo: string[],
  dependsOn: string[],
  graph: MindPlanGraph
): void {
  if (newStatus === "ready" || newStatus === "in-progress") {
    if (belongsTo.length === 0) {
      throw blocked(
        `Ghost Interaction. "${interaction.id}" has no belongs_to edge to a Capability. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
    const foundations = dependsOn
      .map((id) => findNode(graph, id))
      .filter((n) => n.type === "Foundation");
    if (foundations.length === 0) {
      throw blocked(
        `Ghost Interaction. "${interaction.id}" has no depends_on edge to a Foundation. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
  }
}

function validateInterfaceRulesForEdges(
  iface: MindPlanNode,
  newStatus: ExecutionState | NextPipelineState,
  exposes: string[],
  graph: MindPlanGraph
): void {
  if (newStatus === "ready" || newStatus === "in-progress") {
    if (exposes.length === 0) {
      throw blocked(
        `Ghost Interface. "${iface.id}" has no exposes edge to an Interaction. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
    for (const id of exposes) {
      const target = findNode(graph, id);
      if (target.type !== "Interaction") {
        throw blocked(
          `Ghost Interface. "${iface.id}" exposes target "${id}" is a ${target.type}, not an Interaction.`
        );
      }
    }
  }
}

function validateInteractionRules(
  graph: MindPlanGraph,
  interaction: MindPlanNode,
  newStatus: ExecutionState
): void {
  const capabilities = graph.edges
    .filter((e) => e.source === interaction.id && e.type === "belongs_to")
    .map((e) => e.target);

  const dependsOn = graph.edges
    .filter((e) => e.source === interaction.id && e.type === "depends_on")
    .map((e) => e.target);

  validateInteractionRulesForEdges(interaction, newStatus, capabilities, dependsOn, graph);
  runMinimumTerritoryShape(interaction, newStatus, "current");
  runImplementsGate(interaction, newStatus, "current");
}

function validateInterfaceRules(
  graph: MindPlanGraph,
  iface: MindPlanNode,
  newStatus: ExecutionState
): void {
  const exposes = graph.edges
    .filter((e) => e.source === iface.id && e.type === "exposes")
    .map((e) => e.target);

  validateInterfaceRulesForEdges(iface, newStatus, exposes, graph);
  runMinimumTerritoryShape(iface, newStatus, "current");
  runImplementsGate(iface, newStatus, "current");
}

/** Terminal states that do not block cancelling a dependency target. */
const RETIRED_OR_CLOSED = new Set([
  "cancelled",
  "deprecated",
  "resolved",
  "wontfix",
]);

/**
 * The stable/unstable nodes that may have shipped on the relaxed dependency rule, relying on `node`
 * while it was only in review: those with a live depends_on edge to it (or, for an Interaction, a
 * live exposes edge from an Interface), while `node` is not stable. Sorted by id; none once stable.
 */
export function shippedDependentsRelying(graph: MindPlanGraph, node: MindPlanNode): MindPlanNode[] {
  if (node.state === "stable") return [];
  const byId = new Map<string, MindPlanNode>();
  for (const e of graph.edges) {
    if (e.target !== node.id || (e.type !== "depends_on" && e.type !== "exposes")) continue;
    const source = graph.nodes.find((n) => n.id === e.source);
    if (source && source.id !== node.id && isProductionState(source.state)) byId.set(source.id, source);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const RELYING_FIX =
  'or move those dependents back with force_unship (ask the user; confirm: "unship:<id>").';

/**
 * A shipped node may have shipped on the relaxed dependency rule, relying on a dependency that was
 * only in review. Cancelling that dependency (pre-ship), or taking back what made it count, would
 * leave the dependent relying on something that never ships, so it is Blocked while `node` is not
 * stable and a stable/unstable node depends on it (`shippedDependentsRelying`). `what` names the
 * act, e.g. `cancel "f-x"`.
 */
export function assertNoShippedDependentsRelying(graph: MindPlanGraph, node: MindPlanNode, what: string): void {
  const ids = shippedDependentsRelying(graph, node).map((n) => n.id);
  if (ids.length === 0) return;
  throw blocked(
    `cannot ${what}: shipped nodes rely on "${node.id}" (${ids.map((id) => `"${id}"`).join(", ")}), and it is not stable yet. ` +
      `Ship "${node.id}" first, ${RELYING_FIX}`
  );
}

/**
 * The relied-on slot may not lose what made it count: a move of `node`'s active slot back from
 * in-review (to in-progress, the only step back) is Blocked while stable/unstable nodes rely on it.
 */
export function assertNoRetreatUnderShippedDependents(
  graph: MindPlanGraph,
  node: MindPlanNode,
  from: string,
  to: string
): void {
  if (from !== "in-review" || to === SHIP_TRANSITION || to === "cancelled" || to === "in-review") return;
  assertNoShippedDependentsRelying(graph, node, `move "${node.id}" back from in-review to "${to}"`);
}

/**
 * Undoing a build item of `node`'s active slot while it is in review is Blocked while
 * stable/unstable nodes rely on it: they shipped on every build item being ticked. `before` and
 * `after` are the slot text before and after every edit of one call (toggles, added items, body,
 * section, and replace edits, conflict resolution), so no edit path can take a tick back. Items
 * are counted, not matched by label: a call may not raise the number of build items not done (an
 * untick, or an added unticked item) nor lower the number done (done work removed). A ticked item
 * reworded in place passes, and so does ticking an open one.
 */
export function assertNoUntickUnderShippedDependents(
  graph: MindPlanGraph,
  node: MindPlanNode,
  slotState: string | undefined,
  before: string,
  after: string
): void {
  if (slotState !== "in-review" || before === after) return;
  const undone = undoneBuildItems(before, after);
  if (!undone) return;
  assertNoShippedDependentsRelying(
    graph,
    node,
    `untick, remove, or add unticked build items of "${node.id}" in review (${undone})`
  );
}

/**
 * What one call undoes among the build items, by count: `null` when the number not done did not
 * rise and the number done did not fall; otherwise a phrase naming the offending items.
 */
function undoneBuildItems(before: string, after: string): string | null {
  const label = (i: ChecklistItem): string => `"${i.id ?? i.text}"`;
  const build = (body: string): ChecklistItem[] => parseChecklistItems(body).filter((i) => i.kind === "build");
  const beforeItems = build(before);
  const afterItems = build(after);
  const openBefore = beforeItems.filter((i) => !i.done);
  const openAfter = afterItems.filter((i) => !i.done);
  const doneBefore = beforeItems.filter((i) => i.done);
  const doneAfter = afterItems.filter((i) => i.done);
  const parts: string[] = [];
  if (openAfter.length > openBefore.length) {
    const wasOpen = new Set(openBefore.map(label));
    const fresh = openAfter.filter((i) => !wasOpen.has(label(i)));
    const named = [...new Set((fresh.length > 0 ? fresh : openAfter).map(label))].join(", ");
    parts.push(`build items not done would rise from ${openBefore.length} to ${openAfter.length}: ${named}`);
  }
  if (doneAfter.length < doneBefore.length) {
    const stillDone = new Set(doneAfter.map(label));
    const lost = doneBefore.filter((i) => !stillDone.has(label(i)));
    const named = [...new Set((lost.length > 0 ? lost : doneBefore).map(label))].join(", ");
    parts.push(`done build items would fall from ${doneBefore.length} to ${doneAfter.length}: ${named}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Discarding revision `change` of a shipped node is Blocked when a stable/unstable dependent relied
 * on that revision's view: one of its owned files imports a file that only the revision claims
 * (live does not). A dependent that rests on live alone does not hold the discard.
 */
export function assertNoShippedDependentsOnRevision(graph: MindPlanGraph, node: MindPlanNode, change: string): void {
  if (!node.shipped_at) return;
  const dependents = shippedDependentsRelying(graph, node);
  if (dependents.length === 0) return;
  const liveFiles = new Set(expandClaims(node.implements));
  const onlyRevision = new Set(
    expandClaims(withRevision(node, change).next?.implements).filter((f) => !liveFiles.has(f))
  );
  if (onlyRevision.size === 0) return;
  const relying: string[] = [];
  for (const dep of dependents) {
    for (const file of expandClaims(dep.implements)) {
      const hit = listResolvedImports(file).find((imp) => onlyRevision.has(imp.to));
      if (hit) {
        relying.push(`"${dep.id}" (${hit.from} imports ${hit.to})`);
        break;
      }
    }
  }
  if (relying.length === 0) return;
  throw blocked(
    `cannot discard revision "${change}" of "${node.id}": shipped nodes rely on files only that revision claims: ` +
      `${relying.join(", ")}. Ship the revision first, ${RELYING_FIX}`
  );
}

/**
 * Pre-ship abandon: cancel is blocked while `<id>.next.mdx` is open or any active
 * (non-retired) node still depends_on this node — including proposed
 * depends_on on another node's open `<id>.next.mdx`.
 */
function validateCancelTransition(graph: MindPlanGraph, node: MindPlanNode): void {
  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `cancelled only applies to Foundations, Interactions, and Interfaces. Got ${node.type} "${node.id}".`
    );
  }
  if (node.next) {
    throw blocked(
      `cannot cancel "${node.id}" while an open revision exists (state "${node.next.state}"). Call discard_next first.`
    );
  }
  assertNoShippedDependentsRelying(graph, node, `cancel "${node.id}"`);
  const byId = new Map<string, MindPlanNode>();
  for (const dep of dependentsOf(graph, node.id)) {
    if (!RETIRED_OR_CLOSED.has(dep.state)) byId.set(dep.id, dep);
  }
  const viaRevision = new Map<string, string>();
  for (const other of graph.nodes) {
    if (other.id === node.id) continue;
    if (RETIRED_OR_CLOSED.has(other.state)) continue;
    for (const view of other.next ? [other, ...revisionViews(other)] : revisionViews(other)) {
      if (view.next?.depends_on?.includes(node.id)) {
        byId.set(other.id, other);
        viaRevision.set(other.id, view.next.state);
        break;
      }
    }
  }
  if (node.type === "Interface") {
    for (const other of graph.nodes) {
      if (other.id === node.id || RETIRED_OR_CLOSED.has(other.state)) continue;
      if (effectiveMounts(other).includes(node.id) || (other.mounts ?? []).includes(node.id)) {
        byId.set(other.id, other);
      }
    }
  }
  const activeDependents = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (activeDependents.length > 0) {
    const list = activeDependents
      .map((n) =>
        viaRevision.has(n.id)
          ? `"${n.id}" (next depends_on, next: ${viaRevision.get(n.id)})`
          : `"${n.id}" (${n.state})`
      )
      .join(", ");
    throw blocked(
      `cannot cancel "${node.id}" while active dependents exist: ${list}. ` +
        `Cancel or deprecate those first, unlink depends_on, or discard_next / change next edges.`
    );
  }
}

function resolveNextStatusChange(
  graph: MindPlanGraph,
  node: MindPlanNode,
  newStatus: string
): StatusChangeResult {
  const next = node.next!;
  if (newStatus === "in-review" || newStatus === SHIP_TRANSITION) assertNoRevisionConflicts(node, next.change);
  if (newStatus === "deprecated" || newStatus === "cancelled") {
    throw blocked(
      `cannot set "${newStatus}" on "${node.id}" while an open revision exists. Call discard_next first, or ship the revision.`
    );
  }

  if (newStatus === SHIP_TRANSITION) {
    const productionState = validateShipTransition(graph, node);
    return { state: productionState, ship: true, promote_next: true };
  }

  if (!isExecutionState(newStatus) || newStatus === "deprecated" || newStatus === "cancelled") {
    throw blocked(
      `"${newStatus}" is not a valid next pipeline state. Valid: draft, ready, in-progress, in-review, or ship from in-review.`
    );
  }

  const current = next.state;
  if (newStatus === current) {
    throw blocked(`the revision of "${node.id}" is already in state "${current}".`);
  }
  if (!EXECUTION_TRANSITIONS[current]?.includes(newStatus)) {
    throw blocked(
      `illegal next transition "${current}" -> "${newStatus}" for node "${node.id}". ` +
        `Allowed from "${current}": ${EXECUTION_TRANSITIONS[current]?.join(", ") || "(none)"}.`
    );
  }
  assertNoRetreatUnderShippedDependents(graph, node, current, newStatus);

  if (node.type === "Interaction") {
    validateInteractionRulesForEdges(
      node,
      newStatus,
      next.belongs_to ?? [],
      next.depends_on ?? [],
      graph
    );
    runMinimumTerritoryShape(node, newStatus, "next");
    runImplementsGate(node, newStatus, "next");
  } else if (node.type === "Interface") {
    validateInterfaceRulesForEdges(node, newStatus, next.exposes ?? [], graph);
    runMinimumTerritoryShape(node, newStatus, "next");
    runImplementsGate(node, newStatus, "next");
  } else if (node.type === "Foundation") {
    runMinimumTerritoryShape(node, newStatus, "next");
    runImplementsGate(node, newStatus, "next");
  }

  return { state: newStatus, ship: false, promote_next: false };
}

/**
 * Blocked while the node's open revision of `change` holds unresolved rebase conflicts: it may not
 * move to in-review or ship until each is resolved.
 */
export function assertNoRevisionConflicts(node: MindPlanNode, change: string | undefined): void {
  if (!change) return;
  const conflicts = revisionFor(node, change)?.conflicts ?? [];
  if (conflicts.length === 0) return;
  const list = conflicts
    .map((c) =>
      c.kind === "section"
        ? `section "${c.section}"`
        : c.kind === "scalar"
          ? `${c.field}`
          : `claim "${c.path}" (owned by "${c.owner}")`
    )
    .join(", ");
  const target = (c: (typeof conflicts)[number]): string =>
    c.kind === "section" ? `section: "${c.section}"` : c.kind === "scalar" ? `field: "${c.field}"` : `claim: "${c.path}"`;
  throw blocked(
    `"${node.id}" revision "${change}" has ${conflicts.length} unresolved rebase conflict(s): ${list}. ` +
      `Resolve each with resolve_conflict({ node_id, change, ... }). Fix: ` +
      conflicts
        .map((c) => `resolve_conflict({ node_id: "${node.id}", change: "${change}", ${target(c)}, take: "revision" | "live" | "text" })`)
        .join(", ") +
      `.`
  );
}

/**
 * Resolves and validates a status mutation of one open revision: the node's revision of `change`,
 * judged against `revisionGraph(graph, change)` (live plus that change only). Blocked when the node
 * has no revision of `change`, and at in-review / ship while the revision has rebase conflicts.
 */
export function resolveRevisionStatusChange(
  graph: MindPlanGraph,
  node: MindPlanNode,
  change: string,
  newStatus: string
): StatusChangeResult {
  if (!revisionFor(node, change)) resolveRevisionChange(node, change);
  const under = revisionGraph(graph, change);
  return resolveNextStatusChange(under, findNode(under, node.id), newStatus);
}

/**
 * Resolves and validates a status mutation. Throws "Blocked: ..." on violation. A shipped node
 * with several open revisions and no next view needs `resolveRevisionStatusChange` (Blocked here,
 * naming them).
 */
export function resolveStatusChange(
  graph: MindPlanGraph,
  node: MindPlanNode,
  newStatus: string
): StatusChangeResult {
  if (node.type === "Capability") {
    throw blocked(
      `Capability states are computed automatically from their Interactions and cannot be set manually.`
    );
  }

  if (node.next) {
    return resolveNextStatusChange(graph, node, newStatus);
  }

  if ((node.open_revisions?.length ?? 0) > 1) {
    if (newStatus === "deprecated" || newStatus === "cancelled") {
      throw blocked(
        `cannot set "${newStatus}" on "${node.id}" while open revisions exist (${openChanges(node).map((c) => `"${c}"`).join(", ")}). Call discard_next for each first, or ship them.`
      );
    }
    resolveRevisionChange(node);
  }

  if (isProductionState(node.state)) {
    if (newStatus === "deprecated") {
      return { state: "deprecated", ship: false, promote_next: false };
    }
    const allowed = PRODUCTION_TRANSITIONS[node.state];
    throw blocked(
      `illegal transition "${node.state}" -> "${newStatus}" for node "${node.id}". ` +
        `Allowed from "${node.state}": ${allowed.join(", ") || "(none)"}. ` +
        `Production posture (stable/unstable) is computed automatically from open Bugs. ` +
        `Use open_next to evolve a shipped Foundation/Interaction/Interface. ` +
        `To undo a mistaken ship, ask the user then call force_unship with confirm: "unship:${node.id}".`
    );
  }

  if (node.type === "Bug") {
    if (!isBugState(newStatus)) {
      throw blocked(
        `"${newStatus}" is not a valid Bug state. Valid states: ${BUG_STATES.join(" -> ")}.`
      );
    }
    const current = node.state as BugState;
    if (newStatus === current) {
      throw blocked(`node "${node.id}" is already in state "${current}".`);
    }
    if (!BUG_TRANSITIONS[current]?.includes(newStatus)) {
      throw blocked(
        `illegal transition "${current}" -> "${newStatus}" for node "${node.id}". ` +
          `Allowed from "${current}": ${BUG_TRANSITIONS[current]?.join(", ") || "(none)"}.`
      );
    }
    validateBugRules(graph, node, newStatus);
    return { state: newStatus, ship: false, promote_next: false };
  }

  // Foundation / Interaction / Interface (first build, no next)
  if (newStatus === SHIP_TRANSITION) {
    const productionState = validateShipTransition(graph, node);
    return { state: productionState, ship: true, promote_next: false };
  }

  if (!isExecutionState(newStatus)) {
    throw blocked(
      `"${newStatus}" is not a valid state. Valid manual states: ${EXECUTION_STATES.join(", ")}, or "${SHIP_TRANSITION}" from in-review. ` +
        `Production states stable/unstable are computed automatically after shipping.`
    );
  }

  const current = node.state as ExecutionState;
  if (newStatus === current) {
    throw blocked(`node "${node.id}" is already in state "${current}".`);
  }
  if (isShipped(node)) {
    throw blocked(
      `node "${node.id}" has already shipped (shipped_at: ${node.shipped_at}). Use deprecated to retire it; stable/unstable are computed from Bugs. Use open_next to evolve.`
    );
  }
  if (!EXECUTION_TRANSITIONS[current]?.includes(newStatus)) {
    throw blocked(
      `illegal transition "${current}" -> "${newStatus}" for node "${node.id}". ` +
        `Allowed from "${current}": ${EXECUTION_TRANSITIONS[current]?.join(", ") || "(none)"}.`
    );
  }

  if (newStatus === "cancelled") {
    validateCancelTransition(graph, node);
  }
  assertNoRetreatUnderShippedDependents(graph, node, current, newStatus);

  if (node.type === "Interaction") {
    validateInteractionRules(graph, node, newStatus);
  } else if (node.type === "Interface") {
    validateInterfaceRules(graph, node, newStatus);
  } else if (node.type === "Foundation") {
    runMinimumTerritoryShape(node, newStatus, "current");
    runImplementsGate(node, newStatus, "current");
  }

  return { state: newStatus, ship: false, promote_next: false };
}

/** Exact confirm token required by force_unship (Rule 10). */
export function forceUnshipConfirmToken(nodeId: string): string {
  return `unship:${nodeId}`;
}

/**
 * Rule 10 — Force Unship (mistaken ship recovery).
 * Validates and returns the pre-ship target state. Caller clears shipped_at and persists.
 */
export function resolveForceUnship(
  graph: MindPlanGraph,
  node: MindPlanNode,
  newStatus: string,
  confirm: string
): NextPipelineState {
  if (confirm !== forceUnshipConfirmToken(node.id)) {
    throw blocked(
      `force_unship requires confirm: "${forceUnshipConfirmToken(node.id)}". ` +
        `Ask the user to confirm the unship, then pass that exact token. Do not invent confirmation.`
    );
  }

  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `force_unship only applies to Foundations, Interactions, and Interfaces. Got ${node.type} "${node.id}".`
    );
  }

  if (!isProductionState(node.state)) {
    throw blocked(
      `force_unship only applies to stable/unstable nodes. "${node.id}" is currently "${node.state}".`
    );
  }

  if (node.next) {
    throw blocked(
      `cannot force_unship "${node.id}" while an open revision exists (state "${node.next.state}"). Call discard_next first.`
    );
  }
  if (node.open_revisions?.length) {
    throw blocked(
      `cannot force_unship "${node.id}" while open revisions exist (${openChanges(node).map((c) => `"${c}"`).join(", ")}). Call discard_next for each first.`
    );
  }

  const shippedDependents = dependentsOf(graph, node.id).filter((n) =>
    isProductionState(n.state)
  );
  if (shippedDependents.length > 0) {
    const list = shippedDependents.map((n) => `"${n.id}" (${n.state})`).join(", ");
    throw blocked(
      `cannot force_unship "${node.id}" while shipped dependents exist: ${list}. ` +
        `Force-unship or deprecate those first (Infrastructure First).`
    );
  }

  if (!isNextPipelineState(newStatus)) {
    throw blocked(
      `"${newStatus}" is not a valid force_unship target. Valid: draft, ready, in-progress, in-review.`
    );
  }

  if (node.type === "Interaction") {
    validateInteractionRules(graph, node, newStatus);
  } else if (node.type === "Interface") {
    validateInterfaceRules(graph, node, newStatus);
  } else if (node.type === "Foundation" && newStatus === "in-review") {
    runMinimumTerritoryShape(node, newStatus, "current");
    runImplementsGate(node, newStatus, "current");
  }

  return newStatus;
}

/**
 * Computed Capability States (Interaction activity only; Bugs do not affect Capabilities):
 *   evolving   — shipped Interactions (stable/unstable) + in-progress/in-review building (incl. next)
 *   stable     — shipped Interactions, 0 in-progress/in-review
 *   incubation — in-progress/in-review, 0 shipped
 *   draft      — otherwise
 */
export function computeCapabilityState(graph: MindPlanGraph, capabilityId: string): CapabilityState {
  const interactions = interactionsOfCapability(graph, capabilityId);
  const shipped = interactions.filter(
    (w) => w.shipped_at && (w.state === "stable" || w.state === "unstable")
  ).length;
  const building = (state: string | undefined) => state === "in-progress" || state === "in-review";
  const inProgress = interactions.filter((w) => {
    if (w.next && building(w.next.state)) return true;
    if ((w.open_revisions ?? []).some((r) => building(r.state))) return true;
    return !w.shipped_at && (w.state === "in-progress" || w.state === "in-review");
  }).length;

  if (shipped > 0 && inProgress > 0) return "evolving";
  if (shipped > 0) return "stable";
  if (inProgress > 0) return "incubation";
  return "draft";
}

export function recomputeCapabilityStates(graph: MindPlanGraph): MindPlanNode[] {
  const changed: MindPlanNode[] = [];
  const now = new Date().toISOString();
  for (const node of graph.nodes) {
    if (node.type !== "Capability") continue;
    const next: NodeState = computeCapabilityState(graph, node.id);
    if (node.state !== next) {
      node.state = next;
      node.updated_at = now;
      changed.push(node);
    }
  }
  return changed;
}

/** Recomputes stable/unstable for every shipped Foundation, Interaction, and Interface. */
export function recomputeStability(graph: MindPlanGraph): MindPlanNode[] {
  const changed: MindPlanNode[] = [];
  const now = new Date().toISOString();
  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type)) continue;
    if (!node.shipped_at) continue;
    if (node.state === "deprecated" || node.state === "cancelled") continue;
    const next = computeProductionState(graph, node.id);
    if (node.state !== next) {
      node.state = next;
      node.updated_at = now;
      changed.push(node);
    }
  }
  return changed;
}
