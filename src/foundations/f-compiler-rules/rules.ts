/**
 * The Compiler Rules — strict validation for MindPlan state mutations.
 * Every violation throws an Error whose message starts with "Blocked: ".
 */

import type {
  BugState,
  EdgeType,
  ExecutionState,
  JourneyState,
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
  isProductionState,
  PRE_SHIP_WORKFLOW_STATES,
  PRODUCTION_TRANSITIONS,
  SHIP_TRANSITION,
} from "../f-domain-model/types.js";
import { countUncheckedBoxes } from "../f-territory-store/store.js";

export function blocked(message: string): Error {
  return new Error(`Blocked: ${message}`);
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

/** Workflows linked to a Journey via belongs_to edges. */
export function workflowsOfJourney(graph: MindPlanGraph, journeyId: string): MindPlanNode[] {
  return graph.edges
    .filter((e) => e.type === "belongs_to" && e.target === journeyId)
    .map((e) => findNode(graph, e.source))
    .filter((n) => n.type === "Workflow");
}

function isShipped(node: MindPlanNode): boolean {
  return (node.type === "Workflow" || node.type === "Foundation") && !!node.shipped_at;
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
  const unchecked = countUncheckedBoxes(node, slot);
  const file = slot === "next" ? "next.mdx" : "current.mdx";
  if (unchecked > 0) {
    throw blocked(
      `Completion Check. ${unchecked} unchecked checkbox(es) remain in ${node.id}/${file}. All [ ] items must be [x] before moving to "${targetLabel}".`
    );
  }
}

/** Pre-ship Workflow title/description edits; shipped scope changes use open_next. */
export function assertWorkflowTerritoryScalarsEditable(
  node: MindPlanNode,
  field: "title" | "description",
  slot: "current" | "next" = "current"
): void {
  if (node.type !== "Workflow") return;
  if (slot === "next") {
    if (!node.next) {
      throw blocked(`cannot edit ${field} on next: "${node.id}" has no next.mdx.`);
    }
    return;
  }
  if (isProductionState(node.state) || node.state === "deprecated" || node.state === "cancelled") {
    throw blocked(
      `${field} cannot be changed on Workflow "${node.id}" (${node.state}). ` +
        (node.state === "cancelled"
          ? "Cancelled Workflows are terminal."
          : "Use open_next for material scope changes on live work.")
    );
  }
  if (!(PRE_SHIP_WORKFLOW_STATES as readonly string[]).includes(node.state)) {
    throw blocked(
      `${field} cannot be changed on Workflow "${node.id}" in state "${node.state}". ` +
        `Allowed pre-ship states: ${PRE_SHIP_WORKFLOW_STATES.join(", ")}.`
    );
  }
}

/**
 * Taxonomy rules for link_nodes:
 *   Workflow --belongs_to--> Journey
 *   Workflow --depends_on--> Foundation|Workflow
 *   Foundation --depends_on--> Foundation
 *   Bug --affects--> Workflow|Foundation
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
    if (target.type !== "Workflow" && target.type !== "Foundation") {
      throw blocked(
        `affects edges must target a Workflow or Foundation. Got Bug "${source.id}" -> ${target.type} "${target.id}".`
      );
    }
    return;
  }
  if (edgeType === "belongs_to") {
    if (source.type !== "Workflow" || target.type !== "Journey") {
      throw blocked(
        `belongs_to edges must go Workflow -> Journey. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}".`
      );
    }
    return;
  }
  // depends_on
  if (target.type === "Journey") {
    throw blocked(
      `depends_on edges must target a Foundation or Workflow. Got ${source.type} "${source.id}" -> Journey "${target.id}".`
    );
  }
  if (target.type === "Workflow" && source.type !== "Workflow") {
    throw blocked(
      `depends_on edges to a Workflow must originate from a Workflow. Got ${source.type} "${source.id}" -> Workflow "${target.id}".`
    );
  }
  if (target.type === "Foundation" && source.type !== "Workflow" && source.type !== "Foundation") {
    throw blocked(
      `depends_on edges to a Foundation must originate from a Workflow or Foundation. Got ${source.type} "${source.id}" -> Foundation "${target.id}".`
    );
  }
  if (source.type === "Journey" || source.type === "Bug") {
    throw blocked(
      `a ${source.type} cannot depend on a Foundation. Only Workflows and Foundations may use depends_on.`
    );
  }
}

/**
 * Outgoing depends_on for cycle/closure checks: proposed next.depends_on while
 * evolving a shipped Foundation/Workflow, otherwise live depends_on.
 */
export function effectiveDependsOn(node: MindPlanNode): string[] {
  if (
    node.next &&
    (node.type === "Workflow" || node.type === "Foundation")
  ) {
    return node.next.depends_on ?? [];
  }
  return node.depends_on ?? [];
}

/**
 * Outgoing belongs_to for Dependency Closure: proposed next.belongs_to while
 * evolving a shipped Workflow, otherwise live belongs_to.
 */
export function effectiveBelongsTo(node: MindPlanNode): string[] {
  if (node.next && node.type === "Workflow") {
    return node.next.belongs_to ?? [];
  }
  return node.belongs_to ?? [];
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

/** Transitive closure of Workflow targets reachable via effective depends_on from workflowId. */
export function transitiveWorkflowDependencies(
  graph: MindPlanGraph,
  workflowId: string
): MindPlanNode[] {
  const result: MindPlanNode[] = [];
  const seen = new Set<string>();
  const stack = [workflowId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const currentNode = graph.nodes.find((n) => n.id === current);
    const depIds = currentNode ? effectiveDependsOn(currentNode) : [];
    for (const targetId of depIds) {
      const target = findNode(graph, targetId);
      if (target.type !== "Workflow") continue;
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      result.push(target);
      stack.push(target.id);
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Dependency workflows missing an effective belongs_to edge to the given Journey. */
export function missingJourneyDependents(
  graph: MindPlanGraph,
  workflow: MindPlanNode,
  journeyId: string
): MindPlanNode[] {
  const deps = transitiveWorkflowDependencies(graph, workflow.id);
  return deps.filter((dep) => !effectiveBelongsTo(dep).includes(journeyId));
}

/** Validates open_next preconditions (Rule 9). */
export function validateOpenNext(node: MindPlanNode): void {
  if (node.type !== "Workflow" && node.type !== "Foundation") {
    throw blocked(
      `only Foundations and Workflows can open a next evolution. Got ${node.type} "${node.id}".`
    );
  }
  if (node.state !== "stable" && node.state !== "unstable") {
    throw blocked(
      `only shipped Foundations/Workflows (stable or unstable) can open next. "${node.id}" is currently "${node.state}".`
    );
  }
  if (node.next) {
    throw blocked(
      `"${node.id}" already has a next.mdx evolution in state "${node.next.state}". Ship or discard_next before opening another.`
    );
  }
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

export type StatusChangeResult = {
  state: NodeState;
  /** When true, caller must set shipped_at before persisting (first ship or promote next). */
  ship: boolean;
  /** When true, ship promotes next.mdx over current.mdx. */
  promote_next: boolean;
};

function validateShipTransition(graph: MindPlanGraph, node: MindPlanNode): ProductionState {
  if (node.type !== "Workflow" && node.type !== "Foundation") {
    throw blocked(`only Foundations and Workflows can ship to production.`);
  }

  if (node.next) {
    if (node.next.state !== "in-review") {
      throw blocked(
        `ship is only allowed from next in-review. "${node.id}" next is currently "${node.next.state}".`
      );
    }
    runCompletionCheck(node, SHIP_TRANSITION, "next");
    assertEffectiveDependsOnAcyclic(graph);

    if (node.type === "Workflow") {
      const depIds = node.next.depends_on ?? [];
      const deps = depIds.map((id) => findNode(graph, id));
      const foundations = deps.filter((n) => n.type === "Foundation");
      const workflows = deps.filter((n) => n.type === "Workflow");
      const notStable = [...foundations, ...workflows].filter((n) => n.state !== "stable");
      if (notStable.length > 0) {
        const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
        throw blocked(
          `Infrastructure First. Workflow "${node.id}" next cannot ship while linked Foundations or Workflows are not stable: ${list}.`
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

  if (node.type === "Workflow") {
    const foundations = edgesFrom(graph, node.id, "depends_on").filter(
      (n) => n.type === "Foundation"
    );
    const workflows = edgesFrom(graph, node.id, "depends_on").filter(
      (n) => n.type === "Workflow"
    );
    const notStable = [...foundations, ...workflows].filter((n) => n.state !== "stable");
    if (notStable.length > 0) {
      const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
      throw blocked(
        `Infrastructure First. Workflow "${node.id}" cannot ship while linked Foundations or Workflows are not stable: ${list}.`
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
        `Ghost Bug. "${bug.id}" has no affects edge to a Workflow or Foundation. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
  }

  if (newStatus === "in-review" || newStatus === "resolved") {
    runCompletionCheck(bug, newStatus, "current");
  }
}

function validateWorkflowRulesForEdges(
  workflow: MindPlanNode,
  newStatus: ExecutionState | NextPipelineState,
  belongsTo: string[],
  dependsOn: string[],
  graph: MindPlanGraph
): void {
  if (newStatus === "ready" || newStatus === "in-progress") {
    if (belongsTo.length === 0) {
      throw blocked(
        `Ghost Workflow. "${workflow.id}" has no belongs_to edge to a Journey. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
    const foundations = dependsOn
      .map((id) => findNode(graph, id))
      .filter((n) => n.type === "Foundation");
    if (foundations.length === 0) {
      throw blocked(
        `Ghost Workflow. "${workflow.id}" has no depends_on edge to a Foundation. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
  }
}

function validateWorkflowRules(
  graph: MindPlanGraph,
  workflow: MindPlanNode,
  newStatus: ExecutionState
): void {
  const journeys = graph.edges
    .filter((e) => e.source === workflow.id && e.type === "belongs_to")
    .map((e) => e.target);

  const dependsOn = graph.edges
    .filter((e) => e.source === workflow.id && e.type === "depends_on")
    .map((e) => e.target);

  validateWorkflowRulesForEdges(workflow, newStatus, journeys, dependsOn, graph);

  if (newStatus === "in-review") {
    runCompletionCheck(workflow, newStatus, "current");
  }
}

/** Terminal states that do not block cancelling a dependency target. */
const RETIRED_OR_CLOSED = new Set([
  "cancelled",
  "deprecated",
  "resolved",
  "wontfix",
]);

/**
 * Pre-ship abandon: cancel is blocked while next.mdx is open or any active
 * (non-retired) node still depends_on this node — including proposed
 * depends_on on another node's open next.mdx.
 */
function validateCancelTransition(graph: MindPlanGraph, node: MindPlanNode): void {
  if (node.type !== "Workflow" && node.type !== "Foundation") {
    throw blocked(
      `cancelled only applies to Foundations and Workflows. Got ${node.type} "${node.id}".`
    );
  }
  if (node.next) {
    throw blocked(
      `cannot cancel "${node.id}" while next.mdx exists (state "${node.next.state}"). Call discard_next first.`
    );
  }
  const byId = new Map<string, MindPlanNode>();
  for (const dep of dependentsOf(graph, node.id)) {
    if (!RETIRED_OR_CLOSED.has(dep.state)) byId.set(dep.id, dep);
  }
  for (const other of graph.nodes) {
    if (other.id === node.id) continue;
    if (RETIRED_OR_CLOSED.has(other.state)) continue;
    if (other.next?.depends_on?.includes(node.id)) {
      byId.set(other.id, other);
    }
  }
  const activeDependents = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (activeDependents.length > 0) {
    const list = activeDependents
      .map((n) =>
        n.next?.depends_on?.includes(node.id)
          ? `"${n.id}" (next depends_on, next: ${n.next.state})`
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
  if (newStatus === "deprecated" || newStatus === "cancelled") {
    throw blocked(
      `cannot set "${newStatus}" on "${node.id}" while next.mdx exists. Call discard_next first, or ship the evolution.`
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
    throw blocked(`next slot of "${node.id}" is already in state "${current}".`);
  }
  if (!EXECUTION_TRANSITIONS[current]?.includes(newStatus)) {
    throw blocked(
      `illegal next transition "${current}" -> "${newStatus}" for node "${node.id}". ` +
        `Allowed from "${current}": ${EXECUTION_TRANSITIONS[current]?.join(", ") || "(none)"}.`
    );
  }

  if (node.type === "Workflow") {
    validateWorkflowRulesForEdges(
      node,
      newStatus,
      next.belongs_to ?? [],
      next.depends_on ?? [],
      graph
    );
    if (newStatus === "in-review") {
      runCompletionCheck(node, newStatus, "next");
    }
  } else if (node.type === "Foundation" && newStatus === "in-review") {
    runCompletionCheck(node, newStatus, "next");
  }

  return { state: newStatus, ship: false, promote_next: false };
}

/**
 * Resolves and validates a status mutation. Throws "Blocked: ..." on violation.
 */
export function resolveStatusChange(
  graph: MindPlanGraph,
  node: MindPlanNode,
  newStatus: string
): StatusChangeResult {
  if (node.type === "Journey") {
    throw blocked(
      `Journey states are computed automatically from their Workflows and cannot be set manually.`
    );
  }

  if (node.next) {
    return resolveNextStatusChange(graph, node, newStatus);
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
        `Use open_next to evolve a shipped Foundation/Workflow. ` +
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

  // Foundation / Workflow (first build, no next)
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

  if (node.type === "Workflow") {
    validateWorkflowRules(graph, node, newStatus);
  } else if (node.type === "Foundation" && newStatus === "in-review") {
    runCompletionCheck(node, newStatus, "current");
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

  if (node.type !== "Workflow" && node.type !== "Foundation") {
    throw blocked(
      `force_unship only applies to Foundations and Workflows. Got ${node.type} "${node.id}".`
    );
  }

  if (!isProductionState(node.state)) {
    throw blocked(
      `force_unship only applies to stable/unstable nodes. "${node.id}" is currently "${node.state}".`
    );
  }

  if (node.next) {
    throw blocked(
      `cannot force_unship "${node.id}" while next.mdx exists (state "${node.next.state}"). Call discard_next first.`
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

  if (node.type === "Workflow") {
    validateWorkflowRules(graph, node, newStatus);
  } else if (node.type === "Foundation" && newStatus === "in-review") {
    runCompletionCheck(node, newStatus, "current");
  }

  return newStatus;
}

/**
 * Computed Journey States (Workflow activity only; Bugs do not affect Journeys):
 *   evolving   — shipped Workflows (stable/unstable) + in-progress/in-review building (incl. next)
 *   stable     — shipped Workflows, 0 in-progress/in-review
 *   incubation — in-progress/in-review, 0 shipped
 *   draft      — otherwise
 */
export function computeJourneyState(graph: MindPlanGraph, journeyId: string): JourneyState {
  const workflows = workflowsOfJourney(graph, journeyId);
  const shipped = workflows.filter(
    (w) => w.shipped_at && (w.state === "stable" || w.state === "unstable")
  ).length;
  const inProgress = workflows.filter((w) => {
    if (w.next && (w.next.state === "in-progress" || w.next.state === "in-review")) {
      return true;
    }
    return !w.shipped_at && (w.state === "in-progress" || w.state === "in-review");
  }).length;

  if (shipped > 0 && inProgress > 0) return "evolving";
  if (shipped > 0) return "stable";
  if (inProgress > 0) return "incubation";
  return "draft";
}

export function recomputeJourneyStates(graph: MindPlanGraph): MindPlanNode[] {
  const changed: MindPlanNode[] = [];
  const now = new Date().toISOString();
  for (const node of graph.nodes) {
    if (node.type !== "Journey") continue;
    const next: NodeState = computeJourneyState(graph, node.id);
    if (node.state !== next) {
      node.state = next;
      node.updated_at = now;
      changed.push(node);
    }
  }
  return changed;
}

/** Recomputes stable/unstable for every shipped Foundation and Workflow. */
export function recomputeStability(graph: MindPlanGraph): MindPlanNode[] {
  const changed: MindPlanNode[] = [];
  const now = new Date().toISOString();
  for (const node of graph.nodes) {
    if (node.type !== "Workflow" && node.type !== "Foundation") continue;
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
