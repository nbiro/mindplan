/**
 * Read/orient MCP tool handlers — owned by i-orient-plan.
 * Return plain payloads; if-mcp-tools wraps with ok/guarded.
 */

import * as fs from "fs";
import * as path from "path";
import {
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
  entityRelativePath,
  listAttachments,
  loadGraph,
  loadProjectConfig,
  nodeToRecord,
  projectRoot,
  readMarkdown,
  splitContext,
  summarizeGraphNode,
} from "../../foundations/f-territory-store/store.js";
import { expandClaims } from "../../foundations/f-source-index/claims.js";
import { listResolvedImports } from "../../foundations/f-source-index/imports.js";
import {
  buildOwnershipIndex,
  exclusiveOwner,
  nodeOwnedFiles,
} from "../../foundations/f-source-index/ownership.js";
import {
  blocked,
  blastRadiusDependents,
  findNode,
  interactionReachability,
  interfacesExposing,
} from "../../foundations/f-compiler-rules/rules.js";
import { DEFAULT_FIND_LIMIT, findRelatedNodes } from "../../foundations/f-graph-search/search.js";

export type AffectedFileVia = "focus" | "dependent" | "exposing" | "importer";

function fileExists(rel: string, root?: string): boolean {
  const cwd = root ?? projectRoot();
  const abs = path.join(cwd, ...rel.split("/"));
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

function filesPayload(
  entries: string[],
  root?: string
): { path: string; exists: boolean }[] {
  return entries.map((p) => ({ path: p, exists: fileExists(p, root) }));
}

function taggedFiles(
  node: MindPlanNode,
  root?: string
): { path: string; owner_id: string; owner_type: string; exists: boolean }[] {
  const owned = nodeOwnedFiles(node, root);
  const out = owned.files.map((p) => ({
    path: p,
    owner_id: node.id,
    owner_type: node.type,
    exists: fileExists(p, root),
  }));
  return out;
}

/** Reverse-depends_on blast radius; Interaction focus also includes reachability + affected_files. */
export function buildBlastRadiusPayload(
  graph: MindPlanGraph,
  node: MindPlanNode
): Record<string, unknown> {
  const { affected: entries } = blastRadiusDependents(graph, node.id);
  const journeysAtRisk = new Set<string>();
  for (const { node: affected } of entries) {
    if (affected.type !== "Interaction") continue;
    for (const edge of graph.edges) {
      if (edge.source === affected.id && edge.type === "belongs_to") {
        journeysAtRisk.add(edge.target);
      }
    }
  }

  const root = projectRoot();
  const affected_files: {
    path: string;
    owner_id: string;
    owner_type: string;
    via: AffectedFileVia;
  }[] = [];
  const seen = new Set<string>();

  const pushFiles = (owner: MindPlanNode, via: AffectedFileVia) => {
    for (const p of expandClaims(owner.implements, root)) {
      const key = `${p}|${via}|${owner.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      affected_files.push({
        path: p,
        owner_id: owner.id,
        owner_type: owner.type,
        via,
      });
    }
    if (owner.next) {
      for (const p of expandClaims(owner.next.implements, root)) {
        const key = `${p}|${via}|${owner.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        affected_files.push({
          path: p,
          owner_id: owner.id,
          owner_type: owner.type,
          via,
        });
      }
    }
  };

  if (isPipelineNodeType(node.type)) {
    pushFiles(node, "focus");
  }
  for (const { node: dep } of entries) {
    if (isPipelineNodeType(dep.type)) pushFiles(dep, "dependent");
  }

  if (node.type === "Interaction") {
    for (const iface of interfacesExposing(graph, node.id)) {
      pushFiles(iface, "exposing");
    }
  }

  // Importers: other nodes whose files import focus-owned files
  const focusFiles = new Set([
    ...expandClaims(node.implements, root),
    ...(node.next ? expandClaims(node.next.implements, root) : []),
  ]);
  if (focusFiles.size > 0) {
    for (const other of graph.nodes) {
      if (other.id === node.id || !isPipelineNodeType(other.type)) continue;
      const otherFiles = [
        ...expandClaims(other.implements, root),
        ...(other.next ? expandClaims(other.next.implements, root) : []),
      ];
      let importsFocus = false;
      for (const f of otherFiles) {
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) continue;
        for (const edge of listResolvedImports(f, root)) {
          if (focusFiles.has(edge.to)) {
            importsFocus = true;
            break;
          }
        }
        if (importsFocus) break;
      }
      if (importsFocus) pushFiles(other, "importer");
    }
  }

  affected_files.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.via.localeCompare(b.via) ||
      a.owner_id.localeCompare(b.owner_id)
  );

  const payload: Record<string, unknown> = {
    node_id: node.id,
    affected: entries.map(({ node: n, distance }) => ({
      id: n.id,
      type: n.type,
      state: n.state,
      distance,
    })),
    journeys_at_risk: [...journeysAtRisk].sort(),
    affected_files,
  };
  if (node.type === "Interaction") {
    const reach = interactionReachability(graph, node.id);
    payload.reachability = {
      exposing_interfaces: reach.exposing_interfaces.map(summarizeGraphNode),
      containing_journeys: reach.containing_journeys.map(summarizeGraphNode),
      leads_to_downstream: reach.leads_to_downstream.map(({ node: n, distance }) => ({
        ...summarizeGraphNode(n),
        distance,
      })),
    };
  }
  return payload;
}

export function buildNodeContextPayload(node: MindPlanNode): Record<string, unknown> {
  const rel = entityRelativePath(node);
  const currentRaw = readMarkdown(node, "current");
  const currentSplit = splitContext(currentRaw);
  const payload: Record<string, unknown> = {
    folder: rel,
    context_path: `${rel}/${CURRENT_FILENAME}`,
    current_path: `${rel}/${CURRENT_FILENAME}`,
    attachments_path: `${rel}/${ATTACHMENTS_DIR}`,
    attachments: listAttachments(node),
    record: nodeToRecord(node),
    body: currentSplit?.body ?? "",
    title: node.title,
    description: node.description,
    raw_context: currentRaw,
    next: null,
  };
  if (node.next) {
    const nextRaw = readMarkdown(node, "next");
    const nextSplit = splitContext(nextRaw);
    payload.next_path = `${rel}/${NEXT_FILENAME}`;
    payload.next_attachments_path = `${rel}/${NEXT_ATTACHMENTS_DIR}`;
    payload.next = {
      record: {
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
      },
      body: nextSplit?.body ?? "",
      raw: nextRaw,
    };
  }
  return payload;
}

export function getMindPlanGraph(): MindPlanGraph {
  return loadGraph();
}

export function findRelatedNodesHandler(args: {
  query?: string;
  node_id?: string;
  type?: NodeType;
  limit?: number;
}): ReturnType<typeof findRelatedNodes> {
  const q = (args.query ?? "").trim();
  if (!q && !args.node_id) {
    throw blocked('find_related_nodes requires a non-empty "query" and/or "node_id".');
  }
  const graph = loadGraph();
  if (args.node_id) {
    findNode(graph, args.node_id);
  }
  return findRelatedNodes(graph, {
    query: q,
    node_id: args.node_id,
    type: args.type,
    limit: args.limit ?? DEFAULT_FIND_LIMIT,
  });
}

export function getBlastRadius(args: { node_id: string }): Record<string, unknown> {
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  return buildBlastRadiusPayload(graph, node);
}

export function getNodeContext(args: { node_id: string }): Record<string, unknown> {
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  return buildNodeContextPayload(node);
}

export function orientForWork(args: {
  query?: string;
  node_id?: string;
  type?: NodeType;
  limit?: number;
}): Record<string, unknown> {
  const q = (args.query ?? "").trim();
  if (!q && !args.node_id) {
    throw blocked('orient_for_work requires a non-empty "query" and/or "node_id".');
  }
  const graph = loadGraph();
  if (args.node_id) {
    findNode(graph, args.node_id);
  }
  const related = findRelatedNodes(graph, {
    query: q,
    node_id: args.node_id,
    type: args.type,
    limit: args.limit ?? DEFAULT_FIND_LIMIT,
  });
  let context: Record<string, unknown> | null = null;
  let blast_radius: Record<string, unknown> | null = null;

  if (related.focus) {
    const node = findNode(graph, related.focus);
    context = buildNodeContextPayload(node);
    if (isPipelineNodeType(node.type)) {
      blast_radius = buildBlastRadiusPayload(graph, node);
    }
  }

  return { ...related, context, blast_radius };
}

/**
 * Declared file ownership query. Optional `path` returns the owning node.
 */
export function getNodeImplementationHandler(args: {
  node_id?: string;
  path?: string;
}): Record<string, unknown> {
  loadProjectConfig();
  const graph = loadGraph();
  const root = projectRoot();

  if (args.path) {
    const rel = args.path.replace(/\\/g, "/").replace(/^\.\//, "");
    const buckets = buildOwnershipIndex(graph, root);
    const ownerId = exclusiveOwner(buckets, rel);
    if (!ownerId) {
      return { path: rel, owner: null };
    }
    const owner = findNode(graph, ownerId);
    return {
      path: rel,
      owner: {
        node_id: owner.id,
        type: owner.type,
        state: owner.state,
        role: owner.role ?? null,
      },
    };
  }

  if (!args.node_id) {
    throw blocked('get_node_implementation requires "node_id" or "path".');
  }

  const node = findNode(graph, args.node_id);

  if (node.type === "Journey") {
    const interactions = graph.edges
      .filter((e) => e.type === "belongs_to" && e.target === node.id)
      .map((e) => findNode(graph, e.source))
      .filter((n) => n.type === "Interaction");
    const files: {
      path: string;
      owner_id: string;
      owner_type: string;
      exists: boolean;
    }[] = [];
    const seenIfaces = new Set<string>();
    for (const ix of interactions) {
      files.push(...taggedFiles(ix, root));
      for (const iface of interfacesExposing(graph, ix.id)) {
        if (seenIfaces.has(iface.id)) continue;
        seenIfaces.add(iface.id);
        files.push(...taggedFiles(iface, root));
      }
    }
    return { node_id: node.id, type: "Journey", files };
  }

  if (node.type === "Bug") {
    const files: {
      path: string;
      owner_id: string;
      owner_type: string;
      exists: boolean;
    }[] = [];
    for (const tid of node.affects ?? []) {
      const target = findNode(graph, tid);
      if (isPipelineNodeType(target.type)) {
        files.push(...taggedFiles(target, root));
      }
    }
    return { node_id: node.id, type: "Bug", files };
  }

  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `get_node_implementation does not apply to ${node.type} "${node.id}" without path lookup.`
    );
  }

  const owned = nodeOwnedFiles(node, root);
  const result: Record<string, unknown> = {
    node_id: node.id,
    files: filesPayload(owned.files, root),
  };
  if (owned.next_files) {
    result.next_files = filesPayload(owned.next_files, root);
  }
  return result;
}
