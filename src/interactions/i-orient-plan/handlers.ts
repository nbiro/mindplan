/**
 * Read/orient MCP tool handlers — owned by i-orient-plan.
 * Return plain payloads; if-mcp-tools wraps with ok/guarded.
 */

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
  getNodeImplementation,
  listAttachments,
  loadGraph,
  nodeToRecord,
  readMarkdown,
  splitContext,
  summarizeGraphNode,
} from "../../foundations/f-territory-store/store.js";
import {
  blocked,
  blastRadiusDependents,
  findNode,
  interactionReachability,
} from "../../foundations/f-compiler-rules/rules.js";
import { DEFAULT_FIND_LIMIT, findRelatedNodes } from "../../foundations/f-graph-search/search.js";

/** Reverse-depends_on blast radius; Interaction focus also includes reachability. */
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
  const payload: Record<string, unknown> = {
    node_id: node.id,
    affected: entries.map(({ node: n, distance }) => ({
      id: n.id,
      type: n.type,
      state: n.state,
      distance,
    })),
    journeys_at_risk: [...journeysAtRisk].sort(),
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

export function getNodeImplementationHandler(args: { node_id: string }): ReturnType<
  typeof getNodeImplementation
> {
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  return getNodeImplementation(node);
}
