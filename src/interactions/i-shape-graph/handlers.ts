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
import * as fs from "fs";
import * as path from "path";
import {
  ATTACHMENTS_DIR,
  COMPONENTS_DIR,
  MINDPLAN_DIR,
  addEdgeToFrontmatter,
  edgeWriteSlot,
  ensureDirectories,
  entityRelativePath,
  mindplanRoot,
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
  recomputeCapabilityStates,
  recomputeStability,
  revisionGraph,
  validateLink,
} from "../../foundations/f-compiler-rules/rules.js";
import { shapeReport } from "../../foundations/f-compiler-rules/shape.js";
import {
  emptyDelta,
  resolveRevisionChange,
  revisionFor,
  withRevision,
} from "../../foundations/f-revision-model/index.js";
import { writeRevisionDelta } from "../../foundations/f-territory-store/revisions.js";
import { validatePlannedLink } from "../../foundations/f-compiler-rules/planned.js";
import { assertNoChangeCycle } from "../../foundations/f-compiler-rules/change-cycles.js";
import {
  revisionReadinessResult,
  changedFiles,
  gateWrite,
  gateWriteOrOrient,
  mutationTail,
  readinessFields,
  readinessResult,
  refreshPersistedMap,
  rulesBeforeWrite,
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
  // A graph scaffolded by hand may lack components/; ensureDirectories then writes its .gitkeep.
  const componentsKeep = path.posix.join(MINDPLAN_DIR, COMPONENTS_DIR, ".gitkeep");
  const hadComponentsKeep = fs.existsSync(path.join(mindplanRoot(), COMPONENTS_DIR, ".gitkeep"));
  ensureDirectories();
  scaffoldEntity(node, { title, description: desc });
  writeChangeFrontmatter(node, { change: args.change, change_ref: args.change_ref });
  if (args.aliases?.length) writeAliasesFrontmatter(node, args.aliases);
  const rel = entityRelativePath(node);
  const current = territoryPath(node, "current");
  const attachments = `${rel}/${ATTACHMENTS_DIR}`;
  refreshPersistedMap();
  const files = [current, `${attachments}/.gitkeep`, ...(hadComponentsKeep ? [] : [componentsKeep])];
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

type EdgeType = (typeof EDGE_TYPES)[number];

/** One edge of a `link_nodes` batch. */
export type LinkEdge = { source_id: string; target_id: string; edge_type: EdgeType };

/** Most edges one `link_nodes` call takes. */
export const MAX_BATCH_EDGES = 100;

/** Inside a batch the gate, map refresh, and rules diff run once for the whole batch, not per edge. */
type LinkMode = { batch?: boolean };

export function linkNodes(args: {
  verbose?: boolean;
  source_id?: string;
  target_id?: string;
  edge_type?: EdgeType;
  edges?: LinkEdge[];
  change?: string;
}): Record<string, unknown> {
  if (args.edges !== undefined) {
    if (args.source_id !== undefined || args.target_id !== undefined || args.edge_type !== undefined) {
      throw blocked("link_nodes takes either edges or source_id, target_id, and edge_type, not both.");
    }
    return linkBatch(args.edges, args.change, args.verbose);
  }
  if (args.source_id === undefined || args.target_id === undefined || args.edge_type === undefined) {
    throw blocked("link_nodes requires source_id, target_id, and edge_type (or edges for several).");
  }
  return linkOne({ ...args, source_id: args.source_id, target_id: args.target_id, edge_type: args.edge_type });
}

/**
 * `change` on a Foundation, Interaction, or Interface that never shipped and carries another
 * change id: its edges are its own plan, so the edge would silently join that plan.
 */
function preShipChangeProblem(source: MindPlanNode, change: string | undefined): string | null {
  if (change === undefined || !isPipelineNodeType(source.type) || source.shipped_at) return null;
  if (!source.change || source.change === change) return null;
  return (
    `"${source.id}" has not shipped, so the edge would join its own plan (change "${source.change}"), not "${change}". ` +
    `Drop change to add it now (the node then waits for the target), or plan it with change once "${source.id}" has shipped.`
  );
}

function linkOne(
  args: { verbose?: boolean; source_id: string; target_id: string; edge_type: EdgeType; change?: string },
  mode: LinkMode = {}
): Record<string, unknown> {
  const { source_id, target_id, edge_type } = args;
  const graph = loadGraph();
  const source = findNode(graph, source_id);
  const target = findNode(graph, target_id);
  const preShip = preShipChangeProblem(source, args.change);
  if (preShip) throw blocked(preShip);
  const revision = linkRevision(source, edge_type, args.change);
  if (revision !== null) return linkOnRevision(graph, source, target, edge_type as PlannedEdgeType, revision, args.verbose, mode);
  if (args.change !== undefined && isPlannedSource(source, args.change)) {
    return planEdge(graph, source, target, edge_type, args.change, args.verbose, mode);
  }
  validateLink(source, target, edge_type);

  if (edge_type === "depends_on") {
    const change = source.shipped_at ? null : source.change || null;
    assertNoChangeCycle(graph, { source: source_id, target: target_id, change });
    assertAcyclicDependsOn(graph, source_id, target_id);
  }
  if (!mode.batch) gateWrite(graph, [source_id], "link_nodes");
  const rulesBefore = mode.batch ? null : rulesBeforeWrite(graph, source_id);

  const writeSlot = edgeWriteSlot(source, edge_type);
  if (liveEdgeExists(graph, source, target_id, edge_type, writeSlot)) {
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

  const changedCapabilities = recomputeCapabilityStates(graph);
  const changedStability = recomputeStability(graph);
  const synced = syncNodes([...changedCapabilities, ...changedStability]);
  if (!mode.batch) refreshPersistedMap();
  const readiness = readinessResult(source, writeSlot, edgeWrite.readinessReset);
  const files = [territoryPath(source, writeSlot), ...synced, ...readiness.files];
  return {
    linked: { source: source_id, target: target_id, type: edge_type },
    slot: writeSlot,
    capabilities_recomputed: changedCapabilities.map((j) => ({ id: j.id, state: j.state })),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    ...readinessFields(readiness.reset),
    ...(mode.batch ? {} : rulesReachingAfterWrite(source_id, rulesBefore)),
    changed_files: changedFiles(files, !mode.batch),
    ...(mode.batch ? {} : mutationTail(loadGraph(), source_id, args.verbose)),
  };
}

/** Whether a live link would duplicate an edge on the slot it writes (live, or a legacy next file). */
function liveEdgeExists(
  graph: MindPlanGraph,
  source: MindPlanNode,
  targetId: string,
  type: EdgeType,
  writeSlot: "current" | "next"
): boolean {
  if (writeSlot === "next" && source.next) {
    return type !== "affects" && ((source.next[type] as string[] | undefined) ?? []).includes(targetId);
  }
  return graph.edges.some((e) => e.source === source.id && e.target === targetId && e.type === type);
}

/** Where one link lands: live, a delta on an open revision, or a planned entry. */
type LinkRoute = "live" | "revision" | "planned";

/**
 * Check one edge of a batch against `sim` exactly as a single link_nodes would, then add it to
 * `sim` (graph edges and node arrays, a revision's add delta, or the planned list), so the next
 * edge is checked against the graph this one leaves. Throws the single call's Blocked.
 */
function simulateLink(sim: MindPlanGraph, edge: LinkEdge, change: string | undefined): LinkRoute {
  const source = findNode(sim, edge.source_id);
  const target = findNode(sim, edge.target_id);
  const type = edge.edge_type;
  const preShip = preShipChangeProblem(source, change);
  if (preShip) throw blocked(preShip);
  const revision = linkRevision(source, type, change);
  if (revision !== null) {
    validateLink(source, target, type);
    if (type === "depends_on") {
      assertNoChangeCycle(sim, { source: source.id, target: target.id, change: revision });
      assertAcyclicDependsOn(revisionGraph(sim, revision), source.id, target.id);
    }
    const planned = type as PlannedEdgeType;
    if ((withRevision(source, revision).next?.[planned] ?? []).includes(target.id)) {
      throw blocked(`edge ${source.id} -${type}-> ${target.id} already exists in revision "${revision}".`);
    }
    const rev = revisionFor(source, revision)!;
    const d = rev.edges[planned] ?? emptyDelta();
    rev.edges[planned] = { add: [...d.add, target.id], remove: d.remove.filter((id) => id !== target.id) };
    return "revision";
  }
  if (change !== undefined && isPlannedSource(source, change)) {
    validateChangeInput({ change });
    if (!change) throw blocked("link_nodes change must be a change id to plan an edge.");
    if (!(PLANNED_EDGE_TYPES as readonly string[]).includes(type)) {
      throw blocked(`a ${type} edge cannot be planned; planned edges are ${PLANNED_EDGE_TYPES.join(", ")}.`);
    }
    const row = { source: source.id, change, type: type as PlannedEdgeType, target: target.id };
    if (row.type === "depends_on") assertNoChangeCycle(sim, row);
    validatePlannedLink(sim, row);
    source.planned = [...(source.planned ?? []), { change, type: row.type, target: target.id }];
    return "planned";
  }
  validateLink(source, target, type);
  if (type === "depends_on") {
    const own = source.shipped_at ? null : source.change || null;
    assertNoChangeCycle(sim, { source: source.id, target: target.id, change: own });
    assertAcyclicDependsOn(sim, source.id, target.id);
  }
  const writeSlot = edgeWriteSlot(source, type);
  if (liveEdgeExists(sim, source, target.id, type, writeSlot)) {
    throw blocked(`edge ${source.id} -${type}-> ${target.id} already exists.`);
  }
  if (writeSlot === "next" && source.next) {
    const next = source.next as unknown as Record<string, string[] | undefined>;
    next[type] = [...(next[type] ?? []), target.id];
  } else {
    sim.edges.push({ source: source.id, target: target.id, type });
    const live = source as unknown as Record<string, string[] | undefined>;
    live[type] = [...(live[type] ?? []), target.id];
  }
  return "live";
}

/**
 * Merge the per-source rules blocks of a batch into one, shaped like a single link's: `node_id`
 * names the sources (comma-joined), each rule source comes once, `removed` lists each source that
 * stopped reaching one of them.
 */
function mergeRulesBlocks(blocks: { source: string; rules: Record<string, unknown> }[]): Record<string, unknown> {
  if (blocks.length === 0) return {};
  const entries = new Map<string, Record<string, unknown>>();
  const removed = new Set<string>();
  let more: unknown;
  for (const { rules } of blocks) {
    for (const e of (rules.entries as Record<string, unknown>[] | undefined) ?? []) {
      const id = String(e.node_id);
      // A source's full text wins over its one-line form.
      if (!entries.has(id) || (typeof e.rules === "string" && typeof entries.get(id)!.rules !== "string")) entries.set(id, e);
    }
    for (const id of (rules.removed as string[] | undefined) ?? []) removed.add(id);
    more ??= rules.more;
  }
  return {
    rules: {
      node_id: blocks.map((b) => b.source).join(","),
      entries: [...entries.values()],
      ...(more ? { more } : {}),
      ...(removed.size ? { removed: [...removed] } : {}),
    },
  };
}

/**
 * link_nodes with `edges`: every edge is checked on one in-memory graph, each against the graph
 * the earlier ones leave, before the first write; one Blocked edge Blocks the call and nothing is
 * written. Then each edge is written as a single link would write it, the map is refreshed once,
 * and one rules block covers every source.
 */
function linkBatch(edges: LinkEdge[], change: string | undefined, verbose?: boolean): Record<string, unknown> {
  if (edges.length === 0) throw blocked("link_nodes edges is empty; pass at least one edge.");
  if (edges.length > MAX_BATCH_EDGES) {
    throw blocked(`link_nodes takes at most ${MAX_BATCH_EDGES} edges per call; got ${edges.length}. Split the list.`);
  }
  const graph = loadGraph();
  const sim = structuredClone(graph);
  const failures: string[] = [];
  const routes: LinkRoute[] = [];
  edges.forEach((edge, i) => {
    try {
      routes.push(simulateLink(sim, edge, change));
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/^Blocked: /, "");
      failures.push(`edge ${i + 1} of ${edges.length} (${edge.source_id} -${edge.edge_type}-> ${edge.target_id}): ${message}`);
    }
  });
  if (failures.length > 0) {
    throw blocked(`link_nodes wrote nothing: ${failures.length} of ${edges.length} edge(s) are Blocked. ${failures.join(" ")}`);
  }
  const plain = [...new Set(edges.filter((_, i) => routes[i] !== "planned").map((e) => e.source_id))];
  const plannedOnly = [...new Set(edges.filter((_, i) => routes[i] === "planned").map((e) => e.source_id))].filter(
    (id) => !plain.includes(id)
  );
  if (plain.length > 0) gateWrite(graph, plain, "link_nodes");
  const finish = plannedOnly.length > 0 ? gateWriteOrOrient(graph, plannedOnly, "link_nodes") : (r: Record<string, unknown>) => r;
  const before = new Map(plain.map((id) => [id, rulesBeforeWrite(graph, id)]));

  const linked: Record<string, unknown>[] = [];
  const files: string[] = [];
  const resets: unknown[] = [];
  for (const edge of edges) {
    const r = linkOne({ ...edge, change }, { batch: true });
    linked.push({ ...edge, ...(r.planned ? { planned: true } : {}) });
    files.push(...((r.changed_files as string[] | undefined) ?? []));
    if (r.readiness_reset) resets.push(r.readiness_reset);
  }
  if (routes.some((r) => r !== "planned")) refreshPersistedMap();
  const blocks: { source: string; rules: Record<string, unknown> }[] = [];
  for (const id of plain) {
    const after = rulesReachingAfterWrite(id, before.get(id) ?? null);
    if (after.rules) blocks.push({ source: id, rules: after.rules as Record<string, unknown> });
  }
  return finish({
    edges: linked,
    ...mergeRulesBlocks(blocks),
    ...(resets.length > 0 ? { readiness_reset: resets } : {}),
    changed_files: changedFiles(files, true),
    ...(verbose ? mutationTail(loadGraph(), edges[0].source_id, verbose) : {}),
  });
}

/**
 * The open revision a link of `edgeType` from `source` writes to, or null (live, legacy next, or a
 * planned edge): a planned-type edge on a node with open revisions goes to the revision of `change`
 * when it has one (none of `change`: planned), else to its only open revision (several: Blocked).
 */
function linkRevision(source: MindPlanNode, edgeType: string, change: string | undefined): string | null {
  if (!source.open_revisions?.length || !(PLANNED_EDGE_TYPES as readonly string[]).includes(edgeType)) return null;
  if (change !== undefined) return revisionFor(source, change) ? change : null;
  return resolveRevisionChange(source);
}

/**
 * link_nodes on an open revision: the edge joins the revision's add delta (and leaves its remove
 * delta), so live gains it only when the revision ships. Checked against live plus that revision.
 */
function linkOnRevision(
  graph: MindPlanGraph,
  source: MindPlanNode,
  target: MindPlanNode,
  type: PlannedEdgeType,
  change: string,
  verbose?: boolean,
  mode: LinkMode = {}
): Record<string, unknown> {
  validateLink(source, target, type);
  if (type === "depends_on") {
    assertNoChangeCycle(graph, { source: source.id, target: target.id, change });
    assertAcyclicDependsOn(revisionGraph(graph, change), source.id, target.id);
  }
  if (!mode.batch) gateWrite(graph, [source.id], "link_nodes");
  const rulesBefore = mode.batch ? null : rulesBeforeWrite(graph, source.id);
  if ((withRevision(source, change).next?.[type] ?? []).includes(target.id)) {
    throw blocked(`edge ${source.id} -${type}-> ${target.id} already exists in revision "${change}".`);
  }
  const d = revisionFor(source, change)!.edges[type] ?? emptyDelta();
  const files = writeRevisionDelta(source, change, type, {
    add: [...d.add, target.id],
    remove: d.remove.filter((id) => id !== target.id),
  }).changed_files;
  const readiness = revisionReadinessResult(source, change);
  if (!mode.batch) refreshPersistedMap();
  return {
    linked: { source: source.id, target: target.id, type },
    slot: "next",
    change,
    capabilities_recomputed: [],
    stability_recomputed: [],
    ...(readiness.reset ? { readiness_reset: readiness.reset } : {}),
    ...(mode.batch ? {} : rulesReachingAfterWrite(source.id, rulesBefore)),
    changed_files: changedFiles([...files, ...readiness.files], !mode.batch),
    ...(mode.batch ? {} : mutationTail(loadGraph(), source.id, verbose)),
  };
}

/**
 * unlink_nodes on an open revision: every planned-type edge from source to target in live plus
 * that revision joins the revision's remove delta (and leaves its add delta). Live is untouched
 * until the revision ships.
 */
function unlinkOnRevision(
  graph: MindPlanGraph,
  source: MindPlanNode,
  target_id: string,
  change: string,
  verbose?: boolean
): Record<string, unknown> {
  const view = withRevision(source, change).next;
  const types = PLANNED_EDGE_TYPES.filter((t) => (view?.[t] ?? []).includes(target_id));
  if (types.length === 0) {
    throw blocked(`no edge exists between "${source.id}" and "${target_id}" in revision "${change}".`);
  }
  gateWrite(graph, [source.id], "unlink_nodes");
  const rulesBefore = rulesBeforeWrite(graph, source.id);
  const files: string[] = [];
  for (const type of types) {
    const d = revisionFor(source, change)!.edges[type] ?? emptyDelta();
    files.push(
      ...writeRevisionDelta(source, change, type, {
        add: d.add.filter((id) => id !== target_id),
        remove: [...d.remove, target_id],
      }).changed_files
    );
  }
  const readiness = revisionReadinessResult(source, change);
  refreshPersistedMap();
  return {
    removed: types.length,
    slot: "next",
    change,
    capabilities_recomputed: [],
    stability_recomputed: [],
    ...(readiness.reset ? { readiness_reset: readiness.reset } : {}),
    ...rulesReachingAfterWrite(source.id, rulesBefore),
    changed_files: changedFiles([...files, ...readiness.files], true),
    ...mutationTail(loadGraph(), source.id, verbose),
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
  verbose?: boolean,
  mode: LinkMode = {}
): Record<string, unknown> {
  validateChangeInput({ change });
  if (!change) throw blocked("link_nodes change must be a change id to plan an edge.");
  if (!(PLANNED_EDGE_TYPES as readonly string[]).includes(edge_type)) {
    throw blocked(`a ${edge_type} edge cannot be planned; planned edges are ${PLANNED_EDGE_TYPES.join(", ")}.`);
  }
  const row = { source: source.id, change, type: edge_type as PlannedEdgeType, target: target.id };
  if (row.type === "depends_on") assertNoChangeCycle(graph, row);
  validatePlannedLink(graph, row);
  // A planned edge changes neither the live graph nor the rules reaching anything until open_next
  // applies it (and returns the rules it brings), so it orients its source itself.
  const finish = mode.batch ? (r: Record<string, unknown>) => r : gateWriteOrOrient(graph, [source.id], "link_nodes");
  // Planned edges are not in the map or the search docs, so neither is refreshed.
  writePlannedEdges(source, [...(source.planned ?? []), { change, type: row.type, target: target.id }]);
  return finish({
    planned: row,
    note: `Planned, not live: open_next({ node_id: "${source.id}", change: "${change}" }) applies it to the revision.`,
    changed_files: changedFiles([territoryPath(source, "current")]),
    ...(mode.batch ? {} : mutationTail(loadGraph(), source.id, verbose)),
  });
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
    if (revisionFor(source, args.change)) return unlinkOnRevision(graph, source, target_id, args.change, args.verbose);
    return unplanEdges(graph, source, target_id, args.change, args.verbose);
  }
  if (source.open_revisions?.length) {
    return unlinkOnRevision(graph, source, target_id, resolveRevisionChange(source)!, args.verbose);
  }
  findNode(graph, target_id);
  gateWrite(graph, [source_id], "unlink_nodes");
  const rulesBefore = rulesBeforeWrite(graph, source_id);
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
  const changedCapabilities = recomputeCapabilityStates(graph);
  const changedStability = recomputeStability(graph);
  const synced = syncNodes([...changedCapabilities, ...changedStability]);
  refreshPersistedMap();
  const sourceFiles = [territoryPath(source, "current")];
  if (source.next) sourceFiles.push(territoryPath(source, "next"));
  const readiness = readinessResult(source, source.next ? "next" : "current", edgeWrite.readinessReset);
  const files = [...sourceFiles, ...synced, ...readiness.files];
  return {
    removed,
    capabilities_recomputed: changedCapabilities.map((j) => ({ id: j.id, state: j.state })),
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
