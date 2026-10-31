/**
 * Shape the graph — owned by i-shape-graph: create_node, link_nodes, and unlink_nodes (edges,
 * planned edges, and the rules a new edge brings).
 */

import {
  EDGE_TYPES,
  activeChange,
  initialStateForType,
  isFoundationRole,
  isPipelineNodeType,
  PLANNED_EDGE_TYPES,
  type FoundationRole,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeType,
  type PlannedEdgeType,
} from "../../foundations/f-domain-model/types.js";
import {
  ATTACHMENTS_DIR,
  addEdgeToFrontmatter,
  edgeWriteSlot,
  ensureDirectories,
  entityRelativePath,
  loadGraph,
  loadProjectConfig,
  nodeExists,
  normalizeAliases,
  writeAliasesFrontmatter,
  removeEdgesFromFrontmatter,
  scaffoldEntity,
  validateChangeInput,
  writeChangeFrontmatter,
  writePlannedEdges,
} from "../../foundations/f-territory-store/store.js";
import {
  assertAcyclicDependsOn,
  blocked,
  findNode,
  recomputeJourneyStates,
  recomputeStability,
  validateLink,
} from "../../foundations/f-compiler-rules/rules.js";
import { shapeReport } from "../../foundations/f-compiler-rules/shape.js";
import { validatePlannedLink } from "../../foundations/f-compiler-rules/planned.js";
import { orientationGateEnabled, rulesFingerprint } from "../../foundations/f-orientation-ledger/ledger.js";
import {
  changedFiles,
  gateWrite,
  mutationTail,
  readinessFields,
  readinessResult,
  refreshPersistedMap,
  rulesReachingAfterWrite,
  syncNodes,
  territoryPath,
} from "../../foundations/f-plan-writes/writes.js";

export function createNode(args: {
  verbose?: boolean;
  id: string;
  type: NodeType;
  title: string;
  description: string;
  role?: FoundationRole;
  change?: string;
  change_ref?: string;
  aliases?: string[];
}): Record<string, unknown> {
  const { id, type, title, description } = args;
  // Validate config before writing territory.
  loadProjectConfig();
  if (args.aliases !== undefined) normalizeAliases(id, args.aliases);
  if (nodeExists(id)) {
    throw blocked(`node "${id}" already exists.`);
  }
  let role: FoundationRole | undefined;
  let desc = description;
  if (type === "Foundation") {
    if (!args.role || !isFoundationRole(args.role)) {
      throw blocked(
        `create_node Foundation requires role: assembler | infra | design-system | adapter.`
      );
    }
    role = args.role;
    const tag =
      role === "assembler"
        ? "Assembler"
        : role === "design-system"
          ? "Design system"
          : role === "adapter"
            ? "Adapter"
            : "Infra";
    if (!new RegExp(`^${tag}\\b`, "i").test(desc)) {
      desc = `${tag} — ${desc}`;
    }
  } else if (args.role !== undefined) {
    throw blocked(`role is only valid when creating a Foundation (got ${type}).`);
  }
  if ((args.change !== undefined || args.change_ref !== undefined) && !isPipelineNodeType(type)) {
    throw blocked(`change applies to Foundations, Interactions, and Interfaces (got ${type}).`);
  }
  validateChangeInput(args);
  const now = new Date().toISOString();
  const node: MindPlanNode = {
    id,
    type,
    title,
    description: desc,
    state: initialStateForType(type),
    created_at: now,
    updated_at: now,
    ...(role ? { role } : {}),
  };
  ensureDirectories();
  scaffoldEntity(node, { title, description: desc });
  writeChangeFrontmatter(node, { change: args.change, change_ref: args.change_ref });
  if (args.aliases?.length) writeAliasesFrontmatter(node, args.aliases);
  const rel = entityRelativePath(node);
  const current = territoryPath(node, "current");
  const attachments = `${rel}/${ATTACHMENTS_DIR}`;
  refreshPersistedMap();
  const files = [current, `${attachments}/.gitkeep`];
  const graph = loadGraph();
  const shape = shapeReport(graph.nodes.find((n) => n.id === id) ?? node);
  return {
    created: node,
    folder: rel,
    current,
    context: current,
    attachments,
    // create_node is never gated: the new node counts as oriented, with the rules that reach it.
    ...rulesReachingAfterWrite(id, null),
    // The sections its first transition checks, so they are written before it, not found one Blocked at a time.
    ...(shape ? { shape } : {}),
    changed_files: changedFiles(files, true),
    ...mutationTail(graph, id, args.verbose),
  };
}

export function linkNodes(args: {
  verbose?: boolean;
  source_id: string;
  target_id: string;
  edge_type: (typeof EDGE_TYPES)[number];
  change?: string;
}): Record<string, unknown> {
  const { source_id, target_id, edge_type } = args;
  const graph = loadGraph();
  const source = findNode(graph, source_id);
  const target = findNode(graph, target_id);
  if (args.change !== undefined && isPlannedSource(source, args.change)) {
    return planEdge(graph, source, target, edge_type, args.change, args.verbose);
  }
  validateLink(source, target, edge_type);

  if (edge_type === "depends_on") {
    assertAcyclicDependsOn(graph, source_id, target_id);
  }
  gateWrite(graph, [source_id], "link_nodes");
  const rulesBefore = orientationGateEnabled() ? rulesFingerprint(graph, source_id) : null;

  const writeSlot = edgeWriteSlot(source, edge_type);
  const existingOnSlot =
    writeSlot === "next" && source.next
      ? edge_type === "belongs_to"
        ? (source.next.belongs_to ?? []).includes(target_id)
        : edge_type === "depends_on"
          ? (source.next.depends_on ?? []).includes(target_id)
          : edge_type === "exposes"
            ? (source.next.exposes ?? []).includes(target_id)
            : edge_type === "leads_to"
              ? (source.next.leads_to ?? []).includes(target_id)
              : edge_type === "mounts"
                ? (source.next.mounts ?? []).includes(target_id)
                : false
      : graph.edges.some(
          (e) => e.source === source_id && e.target === target_id && e.type === edge_type
        );

  if (existingOnSlot) {
    throw blocked(`edge ${source_id} -${edge_type}-> ${target_id} already exists.`);
  }

  if (writeSlot === "current") {
    graph.edges.push({ source: source_id, target: target_id, type: edge_type });
  } else if (source.next) {
    if (edge_type === "belongs_to") {
      source.next.belongs_to = [...(source.next.belongs_to ?? []), target_id];
    } else if (edge_type === "depends_on") {
      source.next.depends_on = [...(source.next.depends_on ?? []), target_id];
    } else if (edge_type === "exposes") {
      source.next.exposes = [...(source.next.exposes ?? []), target_id];
    } else if (edge_type === "leads_to") {
      source.next.leads_to = [...(source.next.leads_to ?? []), target_id];
    } else if (edge_type === "mounts") {
      source.next.mounts = [...(source.next.mounts ?? []), target_id];
    }
  }
  const edgeWrite = addEdgeToFrontmatter(source, edge_type, target_id);

  const changedJourneys = recomputeJourneyStates(graph);
  const changedStability = recomputeStability(graph);
  const synced = syncNodes([...changedJourneys, ...changedStability]);
  refreshPersistedMap();
  const readiness = readinessResult(source, writeSlot, edgeWrite.readinessReset);
  const files = [territoryPath(source, writeSlot), ...synced, ...readiness.files];
  return {
    linked: { source: source_id, target: target_id, type: edge_type },
    slot: writeSlot,
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    ...readinessFields(readiness.reset),
    ...rulesReachingAfterWrite(source_id, rulesBefore),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), source_id, args.verbose),
  };
}

/**
 * Whether `change` on a link plans the edge: the source is shipped and has no open revision of
 * that change (a revision of it takes the edge on its next slot, as without `change`).
 */
function isPlannedSource(source: MindPlanNode, change: string): boolean {
  if (!isPipelineNodeType(source.type) || !source.shipped_at) return false;
  return !(source.next && activeChange(source) === change);
}

/** link_nodes with `change` on a shipped node: record the edge as planned under that change. */
function planEdge(
  graph: MindPlanGraph,
  source: MindPlanNode,
  target: MindPlanNode,
  edge_type: (typeof EDGE_TYPES)[number],
  change: string,
  verbose?: boolean
): Record<string, unknown> {
  validateChangeInput({ change });
  if (!change) throw blocked("link_nodes change must be a change id to plan an edge.");
  if (!(PLANNED_EDGE_TYPES as readonly string[]).includes(edge_type)) {
    throw blocked(`a ${edge_type} edge cannot be planned; planned edges are ${PLANNED_EDGE_TYPES.join(", ")}.`);
  }
  const row = { source: source.id, change, type: edge_type as PlannedEdgeType, target: target.id };
  validatePlannedLink(graph, row);
  gateWrite(graph, [source.id], "link_nodes");
  // Planned edges are not in the map or the search docs, so neither is refreshed.
  writePlannedEdges(source, [...(source.planned ?? []), { change, type: row.type, target: target.id }]);
  return {
    planned: row,
    note: `Planned, not live: open_next({ node_id: "${source.id}", change: "${change}" }) applies it to the revision.`,
    changed_files: changedFiles([territoryPath(source, "current")]),
    ...mutationTail(loadGraph(), source.id, verbose),
  };
}

export function unlinkNodes(args: {
  verbose?: boolean;
  source_id: string;
  target_id: string;
  change?: string;
}): Record<string, unknown> {
  const { source_id, target_id } = args;
  const graph = loadGraph();
  const source = findNode(graph, source_id);
  // A planned edge may point at a node deleted since: removing it must not need the target.
  if (args.change !== undefined) {
    return unplanEdges(graph, source, target_id, args.change, args.verbose);
  }
  findNode(graph, target_id);
  gateWrite(graph, [source_id], "unlink_nodes");
  const rulesBefore = orientationGateEnabled() ? rulesFingerprint(graph, source_id) : null;
  const before = graph.edges.length;
  graph.edges = graph.edges.filter(
    (e) => !(e.source === source_id && e.target === target_id)
  );
  let removed = before - graph.edges.length;

  if (source.next) {
    const nextBelongs = source.next.belongs_to ?? [];
    const nextDepends = source.next.depends_on ?? [];
    const nextExposes = source.next.exposes ?? [];
    const nextLeadsTo = source.next.leads_to ?? [];
    const nextMounts = source.next.mounts ?? [];
    if (
      nextBelongs.includes(target_id) ||
      nextDepends.includes(target_id) ||
      nextExposes.includes(target_id) ||
      nextLeadsTo.includes(target_id) ||
      nextMounts.includes(target_id)
    ) {
      source.next.belongs_to = nextBelongs.filter((id) => id !== target_id);
      source.next.depends_on = nextDepends.filter((id) => id !== target_id);
      source.next.exposes = nextExposes.filter((id) => id !== target_id);
      source.next.leads_to = nextLeadsTo.filter((id) => id !== target_id);
      source.next.mounts = nextMounts.filter((id) => id !== target_id);
      if (source.next.belongs_to.length === 0) delete source.next.belongs_to;
      if (source.next.depends_on?.length === 0) delete source.next.depends_on;
      if (source.next.exposes?.length === 0) delete source.next.exposes;
      if (source.next.leads_to?.length === 0) delete source.next.leads_to;
      if (source.next.mounts?.length === 0) delete source.next.mounts;
      removed += 1;
    }
  }

  if (removed === 0) {
    throw blocked(`no edge exists between "${source_id}" and "${target_id}".`);
  }
  const edgeWrite = removeEdgesFromFrontmatter(source, target_id);
  const changedJourneys = recomputeJourneyStates(graph);
  const changedStability = recomputeStability(graph);
  const synced = syncNodes([...changedJourneys, ...changedStability]);
  refreshPersistedMap();
  const sourceFiles = [territoryPath(source, "current")];
  if (source.next) sourceFiles.push(territoryPath(source, "next"));
  const readiness = readinessResult(source, source.next ? "next" : "current", edgeWrite.readinessReset);
  const files = [...sourceFiles, ...synced, ...readiness.files];
  return {
    removed,
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    ...readinessFields(readiness.reset),
    ...rulesReachingAfterWrite(source_id, rulesBefore),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), source_id, args.verbose),
  };
}

/** unlink_nodes with `change`: remove that change's planned edges from source to target. */
function unplanEdges(
  graph: MindPlanGraph,
  source: MindPlanNode,
  target_id: string,
  change: string,
  verbose?: boolean
): Record<string, unknown> {
  const all = source.planned ?? [];
  const kept = all.filter((e) => !(e.change === change && e.target === target_id));
  if (kept.length === all.length) {
    throw blocked(`no planned edge from "${source.id}" to "${target_id}" under change "${change}".`);
  }
  gateWrite(graph, [source.id], "unlink_nodes");
  writePlannedEdges(source, kept);
  return {
    unplanned: all
      .filter((e) => !kept.includes(e))
      .map((e) => ({ source: source.id, change: e.change, type: e.type, target: e.target })),
    changed_files: changedFiles([territoryPath(source, "current")]),
    ...mutationTail(loadGraph(), source.id, verbose),
  };
}
