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
  isPipelineNodeType,
  isProductionState,
  PRE_SHIP_STATES,
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

/** Interactions linked to a Journey via belongs_to edges. */
export function interactionsOfJourney(graph: MindPlanGraph, journeyId: string): MindPlanNode[] {
  return graph.edges
    .filter((e) => e.type === "belongs_to" && e.target === journeyId)
    .map((e) => findNode(graph, e.source))
    .filter((n) => n.type === "Interaction");
}

/** @deprecated Use interactionsOfJourney */
export function workflowsOfJourney(graph: MindPlanGraph, journeyId: string): MindPlanNode[] {
  return interactionsOfJourney(graph, journeyId);
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
  const unchecked = countUncheckedBoxes(node, slot);
  const file = slot === "next" ? "next.mdx" : "current.mdx";
  if (unchecked > 0) {
    throw blocked(
      `Completion Check. ${unchecked} unchecked checkbox(es) remain in ${node.id}/${file}. All [ ] items must be [x] before moving to "${targetLabel}".`
    );
  }
}

/** Pre-ship Interaction/Interface title/description edits; shipped scope changes use open_next. */
export function assertPipelineTerritoryScalarsEditable(
  node: MindPlanNode,
  field: "title" | "description",
  slot: "current" | "next" = "current"
): void {
  if (node.type !== "Interaction" && node.type !== "Interface") return;
  if (slot === "next") {
    if (!node.next) {
      throw blocked(`cannot edit ${field} on next: "${node.id}" has no next.mdx.`);
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
 * Taxonomy rules for link_nodes:
 *   Interaction --belongs_to--> Journey
 *   Interaction|Interface --depends_on--> Foundation
 *   Foundation --depends_on--> Foundation
 *   Interface --exposes--> Interaction
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
  if (edgeType === "belongs_to") {
    if (source.type !== "Interaction" || target.type !== "Journey") {
      throw blocked(
        `belongs_to edges must go Interaction -> Journey. Got ${source.type} "${source.id}" -> ${target.type} "${target.id}".`
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
        `Use leads_to for Journey navigation/progression only.`
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

/** Validates open_next preconditions (Rule 9). */
export function validateOpenNext(node: MindPlanNode): void {
  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `only Foundations, Interactions, and Interfaces can open a next evolution. Got ${node.type} "${node.id}".`
    );
  }
  if (node.state !== "stable" && node.state !== "unstable") {
    throw blocked(
      `only shipped Foundations/Interactions/Interfaces (stable or unstable) can open next. "${node.id}" is currently "${node.state}".`
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

/** Journeys that contain the given Interaction via belongs_to. */
export function journeysContaining(
  graph: MindPlanGraph,
  interactionId: string
): MindPlanNode[] {
  const interaction = findNode(graph, interactionId);
  const journeyIds = effectiveBelongsTo(interaction);
  const fromEdges = graph.edges
    .filter((e) => e.type === "belongs_to" && e.source === interactionId)
    .map((e) => e.target);
  const all = new Set([...journeyIds, ...fromEdges]);
  return [...all]
    .map((id) => findNode(graph, id))
    .filter((n) => n.type === "Journey")
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reachability impact analysis for an Interaction focus. */
export function interactionReachability(
  graph: MindPlanGraph,
  interactionId: string
): {
  exposing_interfaces: MindPlanNode[];
  containing_journeys: MindPlanNode[];
  leads_to_downstream: ReachabilityEntry[];
} {
  return {
    exposing_interfaces: interfacesExposing(graph, interactionId),
    containing_journeys: journeysContaining(graph, interactionId),
    leads_to_downstream: leadsToDownstream(graph, interactionId),
  };
}

export type StatusChangeResult = {
  state: NodeState;
  /** When true, caller must set shipped_at before persisting (first ship or promote next). */
  ship: boolean;
  /** When true, ship promotes next.mdx over current.mdx. */
  promote_next: boolean;
};

function validateShipTransition(graph: MindPlanGraph, node: MindPlanNode): ProductionState {
  if (!isPipelineNodeType(node.type)) {
    throw blocked(`only Foundations, Interactions, and Interfaces can ship to production.`);
  }

  if (node.next) {
    if (node.next.state !== "in-review") {
      throw blocked(
        `ship is only allowed from next in-review. "${node.id}" next is currently "${node.next.state}".`
      );
    }
    runCompletionCheck(node, SHIP_TRANSITION, "next");
    assertEffectiveDependsOnAcyclic(graph);

    if (node.type === "Interaction") {
      const depIds = node.next.depends_on ?? [];
      const deps = depIds.map((id) => findNode(graph, id));
      const foundations = deps.filter((n) => n.type === "Foundation");
      const notStable = foundations.filter((n) => n.state !== "stable");
      if (notStable.length > 0) {
        const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
        throw blocked(
          `Infrastructure First. Interaction "${node.id}" next cannot ship while linked Foundations are not stable: ${list}.`
        );
      }
    }

    if (node.type === "Interface") {
      const exposedIds = node.next.exposes ?? [];
      const exposed = exposedIds.map((id) => findNode(graph, id));
      const notStable = exposed.filter((n) => n.state !== "stable");
      if (notStable.length > 0) {
        const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
        throw blocked(
          `Behavior First. Interface "${node.id}" next cannot ship while exposed Interactions are not stable: ${list}.`
        );
      }
      const depIds = node.next.depends_on ?? [];
      const foundations = depIds
        .map((id) => findNode(graph, id))
        .filter((n) => n.type === "Foundation");
      const foundationsNotStable = foundations.filter((n) => n.state !== "stable");
      if (foundationsNotStable.length > 0) {
        const list = foundationsNotStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
        throw blocked(
          `Infrastructure First. Interface "${node.id}" next cannot ship while linked Foundations are not stable: ${list}.`
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

  if (node.type === "Interaction") {
    const foundations = edgesFrom(graph, node.id, "depends_on").filter(
      (n) => n.type === "Foundation"
    );
    const notStable = foundations.filter((n) => n.state !== "stable");
    if (notStable.length > 0) {
      const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
      throw blocked(
        `Infrastructure First. Interaction "${node.id}" cannot ship while linked Foundations are not stable: ${list}.`
      );
    }
  }

  if (node.type === "Interface") {
    const exposed = edgesFrom(graph, node.id, "exposes");
    const notStable = exposed.filter((n) => n.state !== "stable");
    if (notStable.length > 0) {
      const list = notStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
      throw blocked(
        `Behavior First. Interface "${node.id}" cannot ship while exposed Interactions are not stable: ${list}.`
      );
    }
    const foundations = edgesFrom(graph, node.id, "depends_on").filter(
      (n) => n.type === "Foundation"
    );
    const foundationsNotStable = foundations.filter((n) => n.state !== "stable");
    if (foundationsNotStable.length > 0) {
      const list = foundationsNotStable.map((n) => `"${n.id}" (${n.state})`).join(", ");
      throw blocked(
        `Infrastructure First. Interface "${node.id}" cannot ship while linked Foundations are not stable: ${list}.`
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
    runCompletionCheck(bug, newStatus, "current");
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
        `Ghost Interaction. "${interaction.id}" has no belongs_to edge to a Journey. Link it with link_nodes before moving it to "${newStatus}".`
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
  const journeys = graph.edges
    .filter((e) => e.source === interaction.id && e.type === "belongs_to")
    .map((e) => e.target);

  const dependsOn = graph.edges
    .filter((e) => e.source === interaction.id && e.type === "depends_on")
    .map((e) => e.target);

  validateInteractionRulesForEdges(interaction, newStatus, journeys, dependsOn, graph);

  if (newStatus === "in-review") {
    runCompletionCheck(interaction, newStatus, "current");
  }
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

  if (newStatus === "in-review") {
    runCompletionCheck(iface, newStatus, "current");
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
  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `cancelled only applies to Foundations, Interactions, and Interfaces. Got ${node.type} "${node.id}".`
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

  if (node.type === "Interaction") {
    validateInteractionRulesForEdges(
      node,
      newStatus,
      next.belongs_to ?? [],
      next.depends_on ?? [],
      graph
    );
    if (newStatus === "in-review") {
      runCompletionCheck(node, newStatus, "next");
    }
  } else if (node.type === "Interface") {
    validateInterfaceRulesForEdges(node, newStatus, next.exposes ?? [], graph);
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
      `Journey states are computed automatically from their Interactions and cannot be set manually.`
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

  if (node.type === "Interaction") {
    validateInteractionRules(graph, node, newStatus);
  } else if (node.type === "Interface") {
    validateInterfaceRules(graph, node, newStatus);
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

  if (node.type === "Interaction") {
    validateInteractionRules(graph, node, newStatus);
  } else if (node.type === "Interface") {
    validateInterfaceRules(graph, node, newStatus);
  } else if (node.type === "Foundation" && newStatus === "in-review") {
    runCompletionCheck(node, newStatus, "current");
  }

  return newStatus;
}

/**
 * Computed Journey States (Interaction activity only; Bugs do not affect Journeys):
 *   evolving   — shipped Interactions (stable/unstable) + in-progress/in-review building (incl. next)
 *   stable     — shipped Interactions, 0 in-progress/in-review
 *   incubation — in-progress/in-review, 0 shipped
 *   draft      — otherwise
 */
export function computeJourneyState(graph: MindPlanGraph, journeyId: string): JourneyState {
  const interactions = interactionsOfJourney(graph, journeyId);
  const shipped = interactions.filter(
    (w) => w.shipped_at && (w.state === "stable" || w.state === "unstable")
  ).length;
  const inProgress = interactions.filter((w) => {
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
