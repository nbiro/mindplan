/**
 * Mutate MCP tool handlers — owned by i-steer-plan.
 * Return plain payloads with changed_files + anchor; if-mcp-tools wraps with ok/guarded.
 * Map refresh via persistMindPlanMap from f-view-projection (not i-export-map).
 */

import * as fs from "fs";
import {
  EDGE_TYPES,
  initialStateForType,
  isNextPipelineState,
  isPipelineNodeType,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeType,
} from "../../foundations/f-domain-model/types.js";
import {
  ATTACHMENTS_DIR,
  CURRENT_FILENAME,
  NEXT_ATTACHMENTS_DIR,
  NEXT_FILENAME,
  addEdgeToFrontmatter,
  discardNextSlot,
  edgeWriteSlot,
  ensureDirectories,
  entityRelativePath,
  implementationPackagesRequired,
  implementationRelativePath,
  loadGraph,
  nextAttachmentsDir,
  nodeExists,
  nodeToRecord,
  openNextSlot,
  patchFrontmatter,
  patchNodeTerritory as patchNodeTerritoryStore,
  promoteNextSlot,
  readMarkdown,
  removeEdgesFromFrontmatter,
  scaffoldEntity,
  splitContext,
  toggleCheckboxesInBody,
  type TerritorySlot,
} from "../../foundations/f-territory-store/store.js";
import {
  assertAcyclicDependsOn,
  assertOpenChecklistWhileBuilding,
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
import { DEFAULT_FIND_LIMIT, findRelatedNodes } from "../../foundations/f-graph-search/search.js";
import { persistMindPlanMap } from "../../foundations/f-view-projection/view.js";

export function syncNodes(nodes: MindPlanNode[]): void {
  for (const n of nodes) patchFrontmatter(n);
}

/** Project-relative path of the auto-persisted Mermaid snapshot. */
export const MAP_REL = "mindplan/map.md";

/** Repo-relative path of a node's current or next territory MDX. */
export function territoryPath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  const rel = entityRelativePath(node);
  return `${rel}/${slot === "next" ? NEXT_FILENAME : CURRENT_FILENAME}`;
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
  const files = [`${rel}/${NEXT_FILENAME}`, nextAttRel];
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
          }
        : null,
    },
  };
}

export function createNode(args: {
  id: string;
  type: NodeType;
  title: string;
  description: string;
}): Record<string, unknown> {
  const { id, type, title, description } = args;
  if (nodeExists(id)) {
    throw blocked(`node "${id}" already exists.`);
  }
  const now = new Date().toISOString();
  const node: MindPlanNode = {
    id,
    type,
    title,
    description,
    state: initialStateForType(type),
    created_at: now,
    updated_at: now,
  };
  ensureDirectories();
  scaffoldEntity(node, { title, description });
  const rel = entityRelativePath(node);
  const current = `${rel}/${CURRENT_FILENAME}`;
  const attachments = `${rel}/${ATTACHMENTS_DIR}`;
  const packagesOn = implementationPackagesRequired();
  const implementation = packagesOn ? implementationRelativePath(node) : null;
  refreshPersistedMap();
  const files = [current, `${attachments}/.gitkeep`];
  if (implementation) files.push(`${implementation}/.gitkeep`);
  const graph = loadGraph();
  return {
    created: node,
    folder: rel,
    current,
    context: current,
    attachments,
    ...(implementation ? { implementation } : {}),
    ...(packagesOn ? {} : { implementation_packages: "off" as const }),
    changed_files: changedFiles(files, true),
    ...buildMutationAnchor(graph, id),
  };
}

export function linkNodes(args: {
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
    ...buildMutationAnchor(loadGraph(), source_id),
  };
}

export function unlinkNodes(args: {
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
    if (
      nextBelongs.includes(target_id) ||
      nextDepends.includes(target_id) ||
      nextExposes.includes(target_id) ||
      nextLeadsTo.includes(target_id)
    ) {
      source.next.belongs_to = nextBelongs.filter((id) => id !== target_id);
      source.next.depends_on = nextDepends.filter((id) => id !== target_id);
      source.next.exposes = nextExposes.filter((id) => id !== target_id);
      source.next.leads_to = nextLeadsTo.filter((id) => id !== target_id);
      if (source.next.belongs_to.length === 0) delete source.next.belongs_to;
      if (source.next.depends_on?.length === 0) delete source.next.depends_on;
      if (source.next.exposes?.length === 0) delete source.next.exposes;
      if (source.next.leads_to?.length === 0) delete source.next.leads_to;
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
    ...buildMutationAnchor(loadGraph(), source_id),
  };
}

export function updateNodeStatus(args: {
  node_id: string;
  new_status: string;
}): Record<string, unknown> {
  const { node_id, new_status } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);

  const resolved = resolveStatusChange(graph, node, new_status);

  const previous = node.next ? node.next.state : node.state;
  const now = new Date().toISOString();
  let promoted = false;
  let promoteSlotFiles: string[] = [];

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
  } else if (resolved.ship) {
    node.shipped_at = now;
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
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
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
  }

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const primaryPaths: string[] = [];
  if (promoted) {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(...promoteSlotFiles);
  } else if (node.next && isNextPipelineState(resolved.state)) {
    primaryPaths.push(territoryPath(node, "next"));
  } else {
    primaryPaths.push(territoryPath(node, "current"));
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
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files, true),
    ...buildMutationAnchor(loadGraph(), node_id),
  };
}

export function forceUnship(args: {
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

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const files = [
    territoryPath(node),
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
    ...buildMutationAnchor(loadGraph(), node_id),
  };
}

export function patchNodeTerritory(args: {
  node_id: string;
  title?: string;
  description?: string;
  body?: string;
  toggle_checkboxes?: { contains: string; checked: boolean }[];
  slot?: TerritorySlot;
}): Record<string, unknown> {
  const { node_id, title, description, body, toggle_checkboxes, slot } = args;
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
  if (body !== undefined || (toggle_checkboxes?.length ?? 0) > 0) {
    const raw = readMarkdown(node, resolvedSlot);
    const split = splitContext(raw);
    if (!split) {
      throw blocked(`${resolvedSlot} file for "${node_id}" has no YAML frontmatter.`);
    }
    let nextBody = body !== undefined ? body : split.body;
    if (toggle_checkboxes?.length) {
      nextBody = toggleCheckboxesInBody(nextBody, toggle_checkboxes);
    }
    assertOpenChecklistWhileBuilding(node, nextBody, resolvedSlot);
  }
  const result = patchNodeTerritoryStore(node, {
    title,
    description,
    body,
    toggle_checkboxes,
    slot: resolvedSlot,
  });
  const pathWritten = territoryPath(node, result.slot);
  return {
    node_id,
    ...result,
    path: pathWritten,
    changed_files: changedFiles([pathWritten]),
    ...buildMutationAnchor(loadGraph(), node_id),
  };
}

export function openNext(args: {
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
  const current = `${rel}/${CURRENT_FILENAME}`;
  const next_path = `${rel}/${NEXT_FILENAME}`;
  refreshPersistedMap();
  return {
    node_id,
    live_state: node.state,
    next,
    folder: rel,
    current,
    next_path,
    changed_files: changedFiles([next_path, `${rel}/${NEXT_ATTACHMENTS_DIR}/.gitkeep`], true),
    ...buildMutationAnchor(loadGraph(), node_id),
  };
}

export function discardNext(args: { node_id: string }): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  if (!node.next) {
    throw blocked(`node "${node_id}" has no next.mdx to discard.`);
  }
  const next_path = territoryPath(node, "next");
  const slotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: false });
  discardNextSlot(node);
  delete node.next;
  refreshPersistedMap();
  return {
    node_id,
    discarded: true,
    live_state: node.state,
    changed_files: changedFiles([next_path, ...slotFiles], true),
    ...buildMutationAnchor(loadGraph(), node_id),
  };
}
