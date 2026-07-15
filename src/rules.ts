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
  NodeState,
  ProductionState,
} from "./types.js";
import {
  BUG_STATES,
  BUG_TRANSITIONS,
  EXECUTION_STATES,
  EXECUTION_TRANSITIONS,
  isBugState,
  isExecutionState,
  isOpenBugState,
  isProductionState,
  PRODUCTION_TRANSITIONS,
  SHIP_TRANSITION,
} from "./types.js";
import { countUncheckedBoxes } from "./store.js";

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

function runCompletionCheck(node: MindPlanNode, targetLabel: string): void {
  const unchecked = countUncheckedBoxes(node);
  if (unchecked > 0) {
    throw blocked(
      `Completion Check. ${unchecked} unchecked checkbox(es) remain in ${node.id}/context.mdx. All [ ] items must be [x] before moving to "${targetLabel}".`
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
  if (edgeType === "supersedes") {
    throw blocked(`supersedes edges are created only via create_node_version, not link_nodes.`);
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

/** Returns true if targetId is reachable from startId via existing depends_on edges. */
function hasDependsOnPath(graph: MindPlanGraph, startId: string, targetId: string): boolean {
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges) {
      if (edge.source === current && edge.type === "depends_on") {
        stack.push(edge.target);
      }
    }
  }
  return false;
}

/** Rejects depends_on edges that would create a cycle in the dependency graph. */
export function assertAcyclicDependsOn(
  graph: MindPlanGraph,
  sourceId: string,
  targetId: string
): void {
  if (hasDependsOnPath(graph, targetId, sourceId)) {
    throw blocked(
      `depends_on edge ${sourceId} -> ${targetId} would create a dependency cycle.`
    );
  }
}

/** Transitive closure of Workflow targets reachable via depends_on from workflowId. */
export function transitiveWorkflowDependencies(
  graph: MindPlanGraph,
  workflowId: string
): MindPlanNode[] {
  const result: MindPlanNode[] = [];
  const seen = new Set<string>();
  const stack = [workflowId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of graph.edges) {
      if (edge.source !== current || edge.type !== "depends_on") continue;
      const target = findNode(graph, edge.target);
      if (target.type !== "Workflow") continue;
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      result.push(target);
      stack.push(target.id);
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Dependency workflows missing a belongs_to edge to the given Journey. */
export function missingJourneyDependents(
  graph: MindPlanGraph,
  workflow: MindPlanNode,
  journeyId: string
): MindPlanNode[] {
  const deps = transitiveWorkflowDependencies(graph, workflow.id);
  return deps.filter(
    (dep) =>
      !graph.edges.some(
        (e) => e.type === "belongs_to" && e.source === dep.id && e.target === journeyId
      )
  );
}

/** Node with a supersedes edge pointing at nodeId (the successor version). */
export function findSuccessor(graph: MindPlanGraph, nodeId: string): MindPlanNode | undefined {
  const edge = graph.edges.find((e) => e.type === "supersedes" && e.target === nodeId);
  return edge ? findNode(graph, edge.source) : undefined;
}

/** Predecessor targeted by nodeId's supersedes edge. */
export function findPredecessor(graph: MindPlanGraph, nodeId: string): MindPlanNode | undefined {
  const edge = graph.edges.find((e) => e.type === "supersedes" && e.source === nodeId);
  return edge ? findNode(graph, edge.target) : undefined;
}

/** Validates create_node_version preconditions (Rule 9). */
export function validateNewVersion(graph: MindPlanGraph, previous: MindPlanNode): void {
  if (previous.type !== "Workflow" && previous.type !== "Foundation") {
    throw blocked(
      `only Foundations and Workflows can be versioned. Got ${previous.type} "${previous.id}".`
    );
  }
  if (previous.state !== "stable" && previous.state !== "unstable") {
    throw blocked(
      `only shipped Foundations/Workflows (stable or unstable) can be superseded. "${previous.id}" is currently "${previous.state}".`
    );
  }
  const successor = findSuccessor(graph, previous.id);
  if (successor) {
    throw blocked(
      `"${previous.id}" has already been superseded by "${successor.id}". Create a new version from the latest version instead.`
    );
  }
}

/** Version number by walking supersedes chain backward (1 = no predecessor). */
export function computeVersionNumber(graph: MindPlanGraph, nodeId: string): number {
  let count = 1;
  let current = nodeId;
  for (;;) {
    const pred = findPredecessor(graph, current);
    if (!pred) break;
    count++;
    current = pred.id;
  }
  return count;
}

export type DependentEntry = { node: MindPlanNode; distance: number };

/** Transitive dependents via reverse depends_on (BFS). */
export function transitiveDependents(
  graph: MindPlanGraph,
  nodeId: string
): DependentEntry[] {
  const result: DependentEntry[] = [];
  const seen = new Set<string>();
  const queue: { id: string; distance: number }[] = [{ id: nodeId, distance: 0 }];

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
  /** When true, caller must set shipped_at before persisting. */
  ship: boolean;
};

function validateShipTransition(graph: MindPlanGraph, node: MindPlanNode): ProductionState {
  if (node.type !== "Workflow" && node.type !== "Foundation") {
    throw blocked(`only Foundations and Workflows can ship to production.`);
  }
  if (node.state !== "in-review") {
    throw blocked(
      `ship is only allowed from in-review. "${node.id}" is currently "${node.state}".`
    );
  }
  runCompletionCheck(node, SHIP_TRANSITION);

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
    runCompletionCheck(bug, newStatus);
  }
}

function validateWorkflowRules(
  graph: MindPlanGraph,
  workflow: MindPlanNode,
  newStatus: ExecutionState
): void {
  const journeys = graph.edges
    .filter((e) => e.source === workflow.id && e.type === "belongs_to")
    .map((e) => findNode(graph, e.target));

  if (newStatus === "ready" || newStatus === "in-progress") {
    if (journeys.length === 0) {
      throw blocked(
        `Ghost Workflow. "${workflow.id}" has no belongs_to edge to a Journey. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
    const foundations = edgesFrom(graph, workflow.id, "depends_on").filter(
      (n) => n.type === "Foundation"
    );
    if (foundations.length === 0) {
      throw blocked(
        `Ghost Workflow. "${workflow.id}" has no depends_on edge to a Foundation. Link it with link_nodes before moving it to "${newStatus}".`
      );
    }
  }

  if (newStatus === "in-review") {
    runCompletionCheck(workflow, newStatus);
  }
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

  if (isProductionState(node.state)) {
    if (newStatus === "deprecated") {
      return { state: "deprecated", ship: false };
    }
    const allowed = PRODUCTION_TRANSITIONS[node.state];
    throw blocked(
      `illegal transition "${node.state}" -> "${newStatus}" for node "${node.id}". ` +
        `Allowed from "${node.state}": ${allowed.join(", ") || "(none)"}. ` +
        `Production posture (stable/unstable) is computed automatically from open Bugs.`
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
    return { state: newStatus, ship: false };
  }

  // Foundation / Workflow
  if (newStatus === SHIP_TRANSITION) {
    const productionState = validateShipTransition(graph, node);
    return { state: productionState, ship: true };
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
      `node "${node.id}" has already shipped (shipped_at: ${node.shipped_at}). Use deprecated to retire it; stable/unstable are computed from Bugs.`
    );
  }
  if (!EXECUTION_TRANSITIONS[current]?.includes(newStatus)) {
    throw blocked(
      `illegal transition "${current}" -> "${newStatus}" for node "${node.id}". ` +
        `Allowed from "${current}": ${EXECUTION_TRANSITIONS[current]?.join(", ") || "(none)"}.`
    );
  }

  if (node.type === "Workflow") {
    validateWorkflowRules(graph, node, newStatus);
  } else if (node.type === "Foundation" && newStatus === "in-review") {
    runCompletionCheck(node, newStatus);
  }

  return { state: newStatus, ship: false };
}

/**
 * Computed Journey States (Workflow activity only; Bugs do not affect Journeys):
 *   evolving   — shipped Workflows (stable/unstable) + in-progress/in-review building
 *   stable     — shipped Workflows, 0 in-progress/in-review
 *   incubation — in-progress/in-review, 0 shipped
 *   draft      — otherwise
 */
export function computeJourneyState(graph: MindPlanGraph, journeyId: string): JourneyState {
  const workflows = workflowsOfJourney(graph, journeyId);
  const shipped = workflows.filter(
    (w) => w.shipped_at && (w.state === "stable" || w.state === "unstable")
  ).length;
  const inProgress = workflows.filter(
    (w) => !w.shipped_at && (w.state === "in-progress" || w.state === "in-review")
  ).length;

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
    if (node.state === "deprecated") continue;
    const next = computeProductionState(graph, node.id);
    if (node.state !== next) {
      node.state = next;
      node.updated_at = now;
      changed.push(node);
    }
  }
  return changed;
}
