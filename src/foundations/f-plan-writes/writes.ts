/**
 * Plan writes — the plumbing every graph-write action shares: the orientation write gate, the
 * small write result (changed_files, anchor, readiness reset), stability sync, the persisted map
 * refresh, and neighbor-label cleanup when a write closes a change. Owned by f-plan-writes.
 */

import { type MindPlanGraph, type MindPlanNode } from "../../foundations/f-domain-model/types.js";
import {
  loadGraph,
  markdownRelativePath,
  nodeToRecord,
  projectRoot,
  patchFrontmatter,
  territoryBodyReader,
  writePlannedEdges,
  writeNeighborLabel,
  type TerritorySlot,
} from "../../foundations/f-territory-store/store.js";
import {
  changeMembers,
  changeNeighbors,
  changesWithRevisions,
  findNode,
} from "../../foundations/f-compiler-rules/rules.js";
import { DEFAULT_FIND_LIMIT, findRelatedNodes, refreshSearchIndex } from "../../foundations/f-graph-search/search.js";
import { persistMindPlanMap } from "../../foundations/f-view-projection/view.js";
import {
  assertOriented,
  orientationGateEnabled,
  reachingRules,
  recordOriented,
  rulesFingerprint,
} from "../../foundations/f-orientation-ledger/ledger.js";
import * as path from "path";

/**
 * Blocked: Orientation unless every node was oriented on in this session with the rules that apply
 * to it now (`f-orientation-ledger`). Free when the gate is off (the CLI, or MINDPLAN_ORIENT_GATE=off).
 */
export function gateWrite(
  graph: MindPlanGraph | null,
  ids: string[],
  tool: string,
  opts: { change?: string } = {}
): void {
  if (!orientationGateEnabled()) return;
  assertOriented(graph ?? loadGraph(), ids, tool, opts);
}

/**
 * After a write that can change which rules reach `id` (a link, a new node): when they changed,
 * return them as a `rules` block and count the node as oriented, since the rules reached the agent
 * in this result.
 */
export function rulesReachingAfterWrite(id: string, before: string | null): Record<string, unknown> {
  if (!orientationGateEnabled()) return {};
  const graph = loadGraph();
  if (before !== null && rulesFingerprint(graph, id) === before) return {};
  recordOriented(graph, [id]);
  return { rules: { node_id: id, entries: reachingRules(graph, id) } };
}

/** Persist recomputed states. Returns each node's live path. */
export function syncNodes(nodes: MindPlanNode[]): string[] {
  const paths: string[] = [];
  for (const n of nodes) {
    patchFrontmatter(n);
    paths.push(territoryPath(n));
  }
  return paths;
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

/** Deduplicate changed paths (null: nothing written), optionally appending the map snapshot. */
export function changedFiles(paths: (string | null)[], includeMap = false): string[] {
  const out = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (includeMap && !out.includes(MAP_REL)) out.push(MAP_REL);
  return out;
}

/**
 * Reload territory after a successful mutation: refresh `mindplan/map.md`, and sync the search
 * cache (outside mindplan/, so never in changed_files) with the embeddings of what changed
 * computed in the background.
 */
export function refreshPersistedMap(): void {
  const graph = loadGraph();
  persistMindPlanMap(graph);
  refreshSearchIndex(graph, projectRoot(), territoryBodyReader());
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

/** What a readiness reset reports: the slot that left `ready`. */
export type ReadinessReset = {
  slot: TerritorySlot;
  from: "ready";
  to: "draft";
  note: string;
};

export const READINESS_NOTE =
  "This revision was ready; a contract write sent it back to draft. Review the contract and self-ready it again.";

/**
 * Report a readiness reset the store made during a contract write (`demoteReadySlot`).
 * A ready → draft move never changes a Journey state, so only the map is refreshed.
 */
export function readinessResult(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot,
  demoted: boolean
): { reset: ReadinessReset | null; files: string[] } {
  if (!demoted) return { reset: null, files: [] };
  refreshPersistedMap();
  return {
    reset: { slot, from: "ready", to: "draft", note: READINESS_NOTE },
    files: [territoryPath(node, slot)],
  };
}

export function readinessFields(reset: ReadinessReset | null): Record<string, unknown> {
  return reset ? { readiness_reset: reset } : {};
}

/**
 * Label a neighbor of `change` (the live `change` scalar). Returns the result fields
 * (`neighbor_of`, `replaced_change`) and the files written.
 */
export function labelNeighbor(
  node: MindPlanNode,
  change: string
): { fields: Record<string, unknown>; files: string[] } {
  const label = writeNeighborLabel(node, change);
  return {
    fields: {
      ...(change ? { neighbor_of: change } : {}),
      ...(label.replaced ? { replaced_change: label.replaced } : {}),
    },
    files: label.changed ? [territoryPath(node)] : [],
  };
}

/**
 * A change with no open revisions left has no neighbors either: clear each of these changes'
 * labels from every neighbor in `graph`. Returns the cleared node ids and
 * the files.
 */
export function clearOrphanedNeighbors(
  graph: MindPlanGraph,
  changes: string[]
): { cleared: string[]; planned: string[]; files: string[] } {
  const cleared: string[] = [];
  const planned: string[] = [];
  const files: string[] = [];
  for (const change of new Set(changes)) {
    if (changeMembers(graph, change).length > 0) continue;
    for (const neighbor of changeNeighbors(graph, change)) {
      files.push(...labelNeighbor(neighbor, "").files);
      cleared.push(neighbor.id);
    }
    // Wiring planned under a closed change was never opened: it goes with the change.
    for (const node of graph.nodes) {
      const dropped = (node.planned ?? []).filter((e) => e.change === change);
      if (dropped.length === 0) continue;
      writePlannedEdges(node, (node.planned ?? []).filter((e) => e.change !== change));
      files.push(territoryPath(node, "current"));
      for (const e of dropped) planned.push(`${node.id} -${e.type}-> ${e.target} (${change})`);
    }
  }
  return { cleared, planned, files };
}

/**
 * Run a write that can end change memberships (a status move, a discard, a change id moved or
 * cleared), then clear the neighbor labels of every change that had an open revision before the
 * write and has none after. Every such write goes through here, so a new write path cannot forget
 * the cleanup, and a neighbor-only change (no revisions before either) keeps its labels. The
 * cleanup also runs when the write throws part-way (a batch keeps its earlier transitions); the
 * result then carries nothing, as before.
 */
export function withNeighborCleanup(write: () => Record<string, unknown>): Record<string, unknown> {
  const before = changesWithRevisions(loadGraph());
  let result: Record<string, unknown> | undefined;
  try {
    result = write();
  } finally {
    if (before.size > 0) {
      const graph = loadGraph();
      const after = changesWithRevisions(graph);
      const closed = [...before].filter((c) => !after.has(c));
      const orphaned = closed.length
        ? clearOrphanedNeighbors(graph, closed)
        : { cleared: [], planned: [], files: [] };
      if (result && (orphaned.cleared.length > 0 || orphaned.planned.length > 0)) {
        const prior = (result.cleared_neighbors as string[] | undefined) ?? [];
        const files = (result.changed_files as string[] | undefined) ?? [];
        result = {
          ...result,
          ...(orphaned.cleared.length || prior.length
            ? { cleared_neighbors: [...new Set([...prior, ...orphaned.cleared])] }
            : {}),
          ...(orphaned.planned.length ? { cleared_planned: orphaned.planned } : {}),
          changed_files: [...new Set([...files, ...orphaned.files])],
        };
      }
    }
  }
  return result!;
}
