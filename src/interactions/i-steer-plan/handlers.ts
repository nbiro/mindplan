/**
 * Mutate MCP tool handlers — owned by i-steer-plan.
 * Return plain payloads with changed_files + anchor; if-mcp-tools wraps with ok/guarded.
 * Map refresh via persistMindPlanMap from f-view-projection (not i-export-map).
 */

import * as fs from "fs";
import * as path from "path";
import {
  EDGE_TYPES,
  initialStateForType,
  isFoundationRole,
  isNextPipelineState,
  isPipelineNodeType,
  isProductionState,
  type FoundationRole,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeType,
} from "../../foundations/f-domain-model/types.js";
import {
  ATTACHMENTS_DIR,
  NEXT_ATTACHMENTS_DIR,
  addEdgeToFrontmatter,
  attachmentsDir,
  deleteNextSlotFiles,
  discardNextSlot,
  edgeWriteSlot,
  ensureDirectories,
  entityRelativePath,
  loadGraph,
  markdownRelativePath,
  loadProjectConfig,
  nextAttachmentsDir,
  nodeExists,
  nodeToRecord,
  projectRoot,
  openNextSlot,
  patchFrontmatter,
  patchNodeTerritory as patchNodeTerritoryStore,
  promoteNextSlot,
  readMarkdown,
  removeEdgesFromFrontmatter,
  scaffoldEntity,
  splitContext,
  writeImplementsFrontmatter,
  writeMirrorTwin,
  writeNodeRules,
  writeProjectConfig,
  type TerritorySlot,
} from "../../foundations/f-territory-store/store.js";
import {
  PROJECT_RELATIVE_PATH,
  writeProjectBrief,
} from "../../foundations/f-territory-store/project.js";
import {
  expandClaims,
  normalizeClaimList,
} from "../../foundations/f-source-index/claims.js";
import {
  buildOwnershipIndex,
  exclusiveOwner,
} from "../../foundations/f-source-index/ownership.js";
import {
  assertAcyclicDependsOn,
  assertPipelineTerritoryScalarsEditable,
  blocked,
  findNode,
  recomputeJourneyStates,
  recomputeStability,
  resolveForceUnship,
  resolveStatusChange,
  validateLink,
  validateOpenNext,
} from "../../foundations/f-compiler-rules/rules.js";
import {
  assertCheckCleanForNode,
  findImportViolationsForClaim,
  staleTextWarnings,
} from "../../foundations/f-compiler-rules/integrity.js";
import { DEFAULT_FIND_LIMIT, findRelatedNodes } from "../../foundations/f-graph-search/search.js";
import { rulesImpact } from "../../foundations/f-graph-search/rules.js";
import { persistMindPlanMap } from "../../foundations/f-view-projection/view.js";

export function syncNodes(nodes: MindPlanNode[]): void {
  for (const n of nodes) patchFrontmatter(n);
}

/**
 * Accept empty payloads (empty files) and standard or unpadded base64.
 * Node's Buffer.from does not throw on invalid input, so charset/shape are checked here.
 */
function isBase64Payload(value: string): boolean {
  if (value.length === 0) return true;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(
    value
  );
}

function assertAttachmentBasename(filename: string, raw: string): void {
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".." ||
    path.basename(filename) !== filename
  ) {
    throw blocked(`invalid attachment filename "${raw}".`);
  }
}

/** Project-relative path of the auto-persisted Mermaid snapshot. */
export const MAP_REL = "mindplan/map.md";

/** Repo-relative path of a node's live or evolution territory MDX. */
export function territoryPath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  return markdownRelativePath(node, slot);
}

/** Deduplicate changed paths, optionally appending the map snapshot. */
export function changedFiles(paths: string[], includeMap = false): string[] {
  const out = [...new Set(paths.filter(Boolean))];
  if (includeMap && !out.includes(MAP_REL)) out.push(MAP_REL);
  return out;
}

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

/** Reload territory and refresh `mindplan/map.md` after a successful mutation. */
export function refreshPersistedMap(): void {
  persistMindPlanMap(loadGraph());
}

/**
 * Re-anchor payload for successful graph mutations: active-slot record + 1-hop
 * neighborhood so agents need not call find_related_nodes after every write.
 */
export function buildMutationAnchor(
  graph: MindPlanGraph,
  nodeId: string
): {
  anchor: {
    record: Record<string, unknown>;
    neighborhood: ReturnType<typeof findRelatedNodes>;
    next: Record<string, unknown> | null;
  };
} {
  const node = findNode(graph, nodeId);
  const neighborhood = findRelatedNodes(graph, {
    query: "",
    node_id: nodeId,
    limit: DEFAULT_FIND_LIMIT,
  });
  return {
    anchor: {
      record: nodeToRecord(node),
      neighborhood,
      next: node.next
        ? {
            state: node.next.state,
            title: node.next.title,
            description: node.next.description,
            updated_at: node.next.updated_at,
            ...(node.next.belongs_to?.length ? { belongs_to: node.next.belongs_to } : {}),
            ...(node.next.depends_on?.length ? { depends_on: node.next.depends_on } : {}),
            ...(node.next.exposes?.length ? { exposes: node.next.exposes } : {}),
            ...(node.next.leads_to?.length ? { leads_to: node.next.leads_to } : {}),
            ...(node.next.implements?.length ? { implements: node.next.implements } : {}),
            ...(node.next.role ? { role: node.next.role } : {}),
          }
        : null,
    },
  };
}

/**
 * Default write tail: the touched node's state and next_state. Neighborhood and
 * record come only with `verbose: true` (`buildMutationAnchor`).
 */
export function mutationTail(
  graph: MindPlanGraph,
  nodeId: string,
  verbose?: boolean
): Record<string, unknown> {
  const node = findNode(graph, nodeId);
  const tail: Record<string, unknown> = {
    state: node.state,
    next_state: node.next?.state ?? null,
  };
  return verbose ? { ...tail, ...buildMutationAnchor(graph, nodeId) } : tail;
}

export function createNode(args: {
  verbose?: boolean;
  id: string;
  type: NodeType;
  title: string;
  description: string;
  role?: FoundationRole;
}): Record<string, unknown> {
  const { id, type, title, description } = args;
  // Validate config before writing territory.
  loadProjectConfig();
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
  const rel = entityRelativePath(node);
  const current = territoryPath(node, "current");
  const attachments = `${rel}/${ATTACHMENTS_DIR}`;
  refreshPersistedMap();
  const files = [current, `${attachments}/.gitkeep`];
  const graph = loadGraph();
  return {
    created: node,
    folder: rel,
    current,
    context: current,
    attachments,
    changed_files: changedFiles(files, true),
    ...mutationTail(graph, id, args.verbose),
  };
}

/**
 * Replace the implements list for a pipeline node on the appropriate slot.
 */
export function setImplementationFiles(args: {
  verbose?: boolean;
  node_id: string;
  files: string[];
  slot?: TerritorySlot;
}): Record<string, unknown> {
  loadProjectConfig();
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `set_implementation_files only applies to Interaction, Interface, and Foundation; "${node.id}" is a ${node.type}.`
    );
  }

  const normalized = normalizeClaimList(args.files);
  const retired = node.state === "cancelled" || node.state === "deprecated";
  let slot: TerritorySlot;

  if (args.slot) {
    slot = args.slot;
    if (slot === "next" && !node.next) {
      throw blocked(`cannot set implements on next: "${node.id}" has no open evolution.`);
    }
    if (slot === "current" && isProductionState(node.state) && !retired) {
      throw blocked(
        `shipped "${node.id}" can only change implements on an open next slot. Call open_next first.`
      );
    }
  } else if (retired) {
    slot = "current";
  } else if (isProductionState(node.state)) {
    if (!node.next) {
      throw blocked(
        `shipped "${node.id}" has no open evolution. Call open_next before set_implementation_files.`
      );
    }
    slot = "next";
  } else {
    slot = "current";
  }

  if (retired) {
    if (slot !== "current") {
      throw blocked(`retired "${node.id}" can only shrink implements on current.`);
    }
    const prevFiles = new Set(expandClaims(node.implements));
    for (const f of expandClaims(normalized)) {
      if (!prevFiles.has(f)) {
        throw blocked(
          `retired "${node.id}" may only shrink implements (cannot add "${f}").`
        );
      }
    }
    for (const e of normalized) {
      const covered = (node.implements ?? []).some(
        (p) => p === e || (p.endsWith("/") && (e === p || e.startsWith(p)))
      );
      if (!covered) {
        throw blocked(
          `retired "${node.id}" may only shrink implements (cannot add entry "${e}").`
        );
      }
    }
  }

  const buckets = buildOwnershipIndex(graph);
  for (const f of expandClaims(normalized)) {
    const other = exclusiveOwner(buckets, f);
    if (other && other !== node.id) {
      throw blocked(`implements conflict: "${f}" is already claimed by "${other}".`);
    }
  }

  writeImplementsFrontmatter(node, normalized, slot);
  refreshPersistedMap();
  const pathWritten = territoryPath(node, slot);
  // Scan the claimed files now, so a missing edge is reported with the exact call that fixes it.
  const claimedGraph = loadGraph();
  const claimedNode = findNode(claimedGraph, node.id);
  const importViolations = findImportViolationsForClaim(
    claimedGraph,
    projectRoot(),
    claimedNode,
    normalized
  ).map((v) => ({
    file: v.file,
    imports: v.imports,
    ...(v.fix ? { fix: v.fix } : { not_allowed: v.not_allowed }),
  }));
  return {
    node_id: node.id,
    slot,
    implements: normalized,
    ...(importViolations.length ? { import_violations: importViolations } : {}),
    changed_files: changedFiles([pathWritten], true),
    ...mutationTail(loadGraph(), node.id, args.verbose),
  };
}

export function linkNodes(args: {
  verbose?: boolean;
  source_id: string;
  target_id: string;
  edge_type: (typeof EDGE_TYPES)[number];
}): Record<string, unknown> {
  const { source_id, target_id, edge_type } = args;
  const graph = loadGraph();
  const source = findNode(graph, source_id);
  const target = findNode(graph, target_id);
  validateLink(source, target, edge_type);

  if (edge_type === "depends_on") {
    assertAcyclicDependsOn(graph, source_id, target_id);
  }

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
  addEdgeToFrontmatter(source, edge_type, target_id);

  const changedJourneys = recomputeJourneyStates(graph);
  const changedStability = recomputeStability(graph);
  syncNodes([...changedJourneys, ...changedStability]);
  refreshPersistedMap();
  const files = [
    territoryPath(source, writeSlot),
    ...changedJourneys.map((j) => territoryPath(j)),
    ...changedStability.map((n) => territoryPath(n)),
  ];
  return {
    linked: { source: source_id, target: target_id, type: edge_type },
    slot: writeSlot,
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), source_id, args.verbose),
  };
}

export function unlinkNodes(args: {
  verbose?: boolean;
  source_id: string;
  target_id: string;
}): Record<string, unknown> {
  const { source_id, target_id } = args;
  const graph = loadGraph();
  const source = findNode(graph, source_id);
  findNode(graph, target_id);
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
  removeEdgesFromFrontmatter(source, target_id);
  const changedJourneys = recomputeJourneyStates(graph);
  const changedStability = recomputeStability(graph);
  syncNodes([...changedJourneys, ...changedStability]);
  refreshPersistedMap();
  const sourceFiles = [territoryPath(source, "current")];
  if (source.next) sourceFiles.push(territoryPath(source, "next"));
  const files = [
    ...sourceFiles,
    ...changedJourneys.map((j) => territoryPath(j)),
    ...changedStability.map((n) => territoryPath(n)),
  ];
  return {
    removed,
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), source_id, args.verbose),
  };
}

const STATUS_TIER: Record<string, number> = {
  Foundation: 0,
  Interaction: 1,
  Interface: 2,
  Bug: 3,
};

type StatusRevision = { node_id: string; new_status: string };

/** Which nodes a scoped status call walks. */
export const STATUS_SCOPES = ["all_open_updates", "node_and_dependents"] as const;
export type StatusScope = (typeof STATUS_SCOPES)[number];

/** Forward build pipeline a scoped call walks each node through. */
const WALK_PIPELINE = ["draft", "ready", "in-progress", "in-review", "ship"] as const;

type StatusArgs = {
  node_id?: string;
  new_status?: string;
  revisions?: StatusRevision[];
  scope?: StatusScope;
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
    return { mode: "scope", items: [] };
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
 * A shipped node with an open next, or a pre-ship node that is being built: in-progress or
 * in-review, or already claiming files. A planned node with no files (a draft or ready plan
 * for later work) is not an update and is never walked.
 */
function isOpenUpdate(node: MindPlanNode): boolean {
  if (!isPipelineNodeType(node.type)) return false;
  if (node.next) return true;
  if (node.shipped_at) return false;
  if (!(WALK_PIPELINE as readonly string[]).includes(node.state)) return false;
  return (
    node.state === "in-progress" ||
    node.state === "in-review" ||
    (node.implements?.length ?? 0) > 0
  );
}

/** Nodes a scoped call walks, in the order they must move (Foundations, Interactions, Interfaces). */
function selectScopedNodes(graph: MindPlanGraph, args: StatusArgs): MindPlanNode[] {
  let selected: MindPlanNode[];
  if (args.scope === "all_open_updates") {
    selected = graph.nodes.filter(isOpenUpdate);
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
    selected = graph.nodes.filter((n) => ids.has(n.id) && isOpenUpdate(n));
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

/**
 * Validates every step of a plan in memory against a loaded graph, writing nothing.
 * Returns the first Blocked reason (naming the node and step), or null.
 */
function simulateWalk(plan: WalkPlan[]): { blocked: string | null; warnings: string[] } {
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
          for (const w of staleTextWarnings(graph, root, node)) warnings.add(w);
        }
        if (resolved.promote_next) {
          node.state = resolved.state;
          node.shipped_at = node.shipped_at ?? now;
          delete node.next;
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

function describePlan(plan: WalkPlan[], graph: MindPlanGraph): string[] {
  return plan.map((row) => {
    const node = findNode(graph, row.node_id);
    const to = row.steps[row.steps.length - 1];
    return `${row.node_id}: ${activeState(node)} -> ${to}`;
  });
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
  const normalized = normalizeStatusArgs(args);
  const verbose = args.verbose === true;

  if (normalized.mode === "scope") {
    const graph = loadGraph();
    const nodes = selectScopedNodes(graph, args);
    const plan: WalkPlan[] = nodes
      .map((n) => ({ node_id: n.id, steps: stepsToTarget(n, args.new_status!) }))
      .filter((row) => row.steps.length > 0);
    const sim = simulateWalk(plan);
    if (args.dry_run) {
      return {
        dry_run: true,
        scope: args.scope,
        plan: describePlan(plan, graph),
        blocked: sim.blocked,
        ...(sim.warnings.length ? { warnings: capWarnings(sim.warnings) } : {}),
      };
    }
    if (sim.blocked) {
      throw new Error(
        `${sim.blocked}. Nothing was written: the whole walk is validated before the first transition.`
      );
    }
    const lines: string[] = [];
    const changed = new Set<string>();
    const warnings = new Set<string>(sim.warnings);
    let last: Record<string, unknown> = {};
    for (const row of plan) {
      let first: Record<string, unknown> | null = null;
      for (const step of row.steps) {
        last = applyOneStatus({ node_id: row.node_id, new_status: step });
        first = first ?? last;
        for (const f of (last.changed_files as string[] | undefined) ?? []) changed.add(f);
      }
      lines.push(statusLine({ ...last, previous_state: first!.previous_state }));
    }
    return {
      ordered: true,
      scope: args.scope,
      lines,
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

  if (normalized.mode === "single") {
    return applyOneStatus({ ...normalized.items[0], verbose: args.verbose });
  }

  const ordered = orderStatusRevisions(normalized.items);
  const applied: Record<string, unknown>[] = [];
  for (const rev of ordered) {
    try {
      applied.push(applyOneStatus(rev));
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

function applyOneStatus(args: {
  verbose?: boolean;
  node_id: string;
  new_status: string;
}): Record<string, unknown> {
  const { node_id, new_status } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);

  const resolved = resolveStatusChange(graph, node, new_status);
  // Moves to in-review and ship run the check's import and ownership rules on this node's files.
  let warnings: string[] = [];
  if (new_status === "in-review" || new_status === "ship") {
    assertCheckCleanForNode(graph, projectRoot(), node, new_status);
    warnings = staleTextWarnings(graph, projectRoot(), node);
  }

  const previous = node.next ? node.next.state : node.state;
  const now = new Date().toISOString();
  let promoted = false;
  let promoteSlotFiles: string[] = [];
  let removedTwin: string[] = [];

  if (resolved.promote_next) {
    promoteSlotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: true });
    promoteNextSlot(node, resolved.state, now);
    promoted = true;
    graph.edges = graph.edges.filter((e) => e.source !== node_id);
    if (node.belongs_to) {
      for (const t of node.belongs_to) {
        graph.edges.push({ source: node_id, target: t, type: "belongs_to" });
      }
    }
    if (node.depends_on) {
      for (const t of node.depends_on) {
        graph.edges.push({ source: node_id, target: t, type: "depends_on" });
      }
    }
    if (node.exposes) {
      for (const t of node.exposes) {
        graph.edges.push({ source: node_id, target: t, type: "exposes" });
      }
    }
    if (node.leads_to) {
      for (const t of node.leads_to) {
        graph.edges.push({ source: node_id, target: t, type: "leads_to" });
      }
    }
    if (node.mounts) {
      for (const t of node.mounts) {
        graph.edges.push({ source: node_id, target: t, type: "mounts" });
      }
    }
  } else if (resolved.ship) {
    node.shipped_at = now;
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
    writeMirrorTwin(node);
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
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
    if (retiring && isPipelineNodeType(node.type)) {
      removedTwin = deleteNextSlotFiles(node);
    }
  }

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const primaryPaths: string[] = [];
  if (promoted) {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(territoryPath(node, "next"));
    primaryPaths.push(...promoteSlotFiles);
  } else if (resolved.ship) {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(territoryPath(node, "next"));
  } else if (node.next && isNextPipelineState(resolved.state)) {
    primaryPaths.push(territoryPath(node, "next"));
  } else {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(...removedTwin);
  }
  const files = [
    ...primaryPaths,
    ...changedJourneys.map((j) => territoryPath(j)),
    ...changedStability.map((n) => territoryPath(n)),
  ];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    next_state: node.next?.state ?? null,
    shipped_at: node.shipped_at,
    promoted_next: promoted,
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
  const target = new_status ?? "ready";
  const previous = node.state;

  resolveForceUnship(graph, node, target, confirm);

  const now = new Date().toISOString();
  delete node.shipped_at;
  node.state = target;
  node.updated_at = now;
  patchFrontmatter(node, "current", { clearShippedAt: true });
  const removedTwin = deleteNextSlotFiles(node);

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const files = [
    territoryPath(node),
    ...removedTwin,
    ...changedJourneys.map((j) => territoryPath(j)),
    ...changedStability.map((n) => territoryPath(n)),
  ];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    shipped_at: null,
    force_unship: true,
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function patchNodeTerritory(args: {
  verbose?: boolean;
  node_id: string;
  title?: string;
  description?: string;
  role?: FoundationRole;
  body?: string;
  toggle_checkboxes?: { contains: string; checked: boolean }[];
  section?: string;
  text?: string;
  replace?: { find: string; with: string; all?: boolean };
  slot?: TerritorySlot;
}): Record<string, unknown> {
  const { node_id, title, description, role, body, toggle_checkboxes, slot } = args;
  if ((args.section === undefined) !== (args.text === undefined)) {
    throw blocked('patch_node_territory section needs both section ("## Heading") and text.');
  }
  if (body !== undefined && (args.section !== undefined || args.replace !== undefined)) {
    throw blocked("patch_node_territory body replaces the whole body; do not combine it with section or replace.");
  }
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const resolvedSlot: TerritorySlot =
    slot ??
    (node.next &&
    isPipelineNodeType(node.type) &&
    (node.state === "stable" || node.state === "unstable")
      ? "next"
      : "current");
  if (title !== undefined) {
    assertPipelineTerritoryScalarsEditable(node, "title", resolvedSlot);
  }
  if (description !== undefined) {
    assertPipelineTerritoryScalarsEditable(node, "description", resolvedSlot);
  }
  if (role !== undefined) {
    if (!isFoundationRole(role)) {
      throw blocked(`invalid Foundation role "${role}".`);
    }
    assertPipelineTerritoryScalarsEditable(node, "role", resolvedSlot);
  }
  if (
    body !== undefined ||
    args.section !== undefined ||
    args.replace !== undefined ||
    (toggle_checkboxes?.length ?? 0) > 0
  ) {
    const raw = readMarkdown(node, resolvedSlot);
    if (!splitContext(raw)) {
      throw blocked(`${resolvedSlot} file for "${node_id}" has no YAML frontmatter.`);
    }
  }
  const result = patchNodeTerritoryStore(node, {
    title,
    description,
    role,
    body,
    toggle_checkboxes,
    section: args.section !== undefined ? { heading: args.section, text: args.text! } : undefined,
    replace: args.replace,
    slot: resolvedSlot,
  });
  const pathWritten = territoryPath(node, result.slot);
  return {
    node_id,
    ...result,
    path: pathWritten,
    changed_files: changedFiles([pathWritten]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

/**
 * Replace one node's `## Rules` section. Valid in any non-retired state; never changes state,
 * edges, or checkboxes and never needs open_next. Reports whose work the rules reach.
 */
export function patchNodeRules(args: {
  node_id: string;
  rules: string;
}): Record<string, unknown> {
  const { node_id, rules } = args;
  if (rules === undefined) {
    throw blocked("patch_node_rules requires rules.");
  }
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const written = writeNodeRules(node, rules);
  return {
    node_id,
    rules: node.rules ?? "",
    slots: written.slots,
    rules_impact: rulesImpact(graph, node),
    changed_files: changedFiles(written.paths),
  };
}

export function openNext(args: {
  verbose?: boolean;
  node_id: string;
  title?: string;
  description?: string;
}): Record<string, unknown> {
  const { node_id, title, description } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  validateOpenNext(node);
  const next = openNextSlot(node, { title, description });
  node.next = next;
  const rel = entityRelativePath(node);
  const current = territoryPath(node, "current");
  const next_path = territoryPath(node, "next");
  refreshPersistedMap();
  return {
    node_id,
    live_state: node.state,
    next,
    folder: rel,
    current,
    next_path,
    changed_files: changedFiles([next_path, `${rel}/${NEXT_ATTACHMENTS_DIR}/.gitkeep`], true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function discardNext(args: {
  node_id: string;
  verbose?: boolean;
}): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  if (!node.next) {
    throw blocked(
      `node "${node_id}" has no open evolution to discard (standing mirror twins are not discarded).`
    );
  }
  const next_path = territoryPath(node, "next");
  const slotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: false });
  discardNextSlot(node);
  delete node.next;
  refreshPersistedMap();
  return {
    node_id,
    discarded: true,
    restored_mirror: true,
    live_state: node.state,
    changed_files: changedFiles([next_path, ...slotFiles], true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function patchProjectDescription(args: {
  description: string;
}): Record<string, unknown> {
  if (args.description === undefined) {
    throw blocked("patch_project_description requires description.");
  }
  const result = writeProjectBrief({ description: args.description });
  return {
    path: result.path,
    description: result.description,
    rules: result.rules,
    changed_files: changedFiles([PROJECT_RELATIVE_PATH]),
  };
}

export function patchProjectRules(args: { rules: string }): Record<string, unknown> {
  if (args.rules === undefined) {
    throw blocked("patch_project_rules requires rules.");
  }
  const result = writeProjectBrief({ rules: args.rules });
  return {
    path: result.path,
    description: result.description,
    rules: result.rules,
    changed_files: changedFiles([PROJECT_RELATIVE_PATH]),
  };
}

export function patchConfig(args: {
  sources?: string[];
  exclude?: string[];
}): Record<string, unknown> {
  if (args.sources === undefined && args.exclude === undefined) {
    throw blocked("patch_config requires sources and/or exclude.");
  }
  const current = loadProjectConfig();
  const next = {
    sources: args.sources ?? current.sources,
    exclude: args.exclude ?? current.exclude,
  };
  const written = writeProjectConfig(next, { force: true });
  return {
    path: written.path,
    config: written.config,
    changed_files: changedFiles([written.path]),
  };
}

export function putAttachment(args: {
  verbose?: boolean;
  node_id: string;
  filename: string;
  content_base64: string;
  slot?: TerritorySlot;
}): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const filename = args.filename.trim();
  assertAttachmentBasename(filename, args.filename);
  const slot: TerritorySlot =
    args.slot ??
    (node.next && isPipelineNodeType(node.type) ? "next" : "current");
  if (slot === "next" && !node.next) {
    throw blocked(
      `cannot put attachment on next for "${node_id}" — no open evolution. Call open_next first.`
    );
  }
  if (!isBase64Payload(args.content_base64)) {
    throw blocked("content_base64 is not valid base64.");
  }
  const bytes = Buffer.from(args.content_base64, "base64");
  const dir = slot === "next" ? nextAttachmentsDir(node) : attachmentsDir(node);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, filename);
  if (path.resolve(abs) !== path.resolve(dir, filename)) {
    throw blocked(`invalid attachment filename "${args.filename}".`);
  }
  fs.writeFileSync(abs, bytes);
  const rel = `${entityRelativePath(node)}/${slot === "next" ? NEXT_ATTACHMENTS_DIR : ATTACHMENTS_DIR}/${filename}`;
  return {
    node_id,
    slot,
    path: rel,
    bytes: bytes.length,
    changed_files: changedFiles([rel]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function removeAttachment(args: {
  verbose?: boolean;
  node_id: string;
  filename: string;
  slot?: TerritorySlot;
}): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const filename = args.filename.trim();
  assertAttachmentBasename(filename, args.filename);
  const slot: TerritorySlot =
    args.slot ??
    (node.next && isPipelineNodeType(node.type) ? "next" : "current");
  if (slot === "next" && !node.next) {
    throw blocked(
      `cannot remove attachment on next for "${node_id}" — no open evolution.`
    );
  }
  const dir = slot === "next" ? nextAttachmentsDir(node) : attachmentsDir(node);
  const abs = path.join(dir, filename);
  if (path.resolve(abs) !== path.resolve(dir, filename)) {
    throw blocked(`invalid attachment filename "${args.filename}".`);
  }
  if (!fs.existsSync(abs)) {
    throw blocked(`attachment "${filename}" not found on ${slot} for "${node_id}".`);
  }
  fs.unlinkSync(abs);
  const rel = `${entityRelativePath(node)}/${slot === "next" ? NEXT_ATTACHMENTS_DIR : ATTACHMENTS_DIR}/${filename}`;
  return {
    node_id,
    slot,
    path: rel,
    removed: true,
    changed_files: changedFiles([rel]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}
