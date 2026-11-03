/**
 * Plan writes — the plumbing every graph-write action shares: the orientation write gate, the
 * small write result (changed_files, anchor, readiness reset), stability sync, the persisted map
 * refresh, and dropping a change's planned edges when a write closes it. Owned by f-plan-writes.
 */

import { revisionSummaries as readSummaries } from "../../foundations/f-plan-views/views.js";
import { type MindPlanGraph, type MindPlanNode } from "../../foundations/f-domain-model/types.js";
import { openChanges, revisionFor } from "../../foundations/f-revision-model/index.js";
import { writeRevisionState } from "../../foundations/f-territory-store/revisions.js";
import { MAP_REL } from "../../foundations/f-source-index/git.js";
import {
  loadGraph,
  markdownRelativePath,
  nodeToRecord,
  projectRoot,
  patchFrontmatter,
  territoryBodyReader,
  writePlannedEdges,
  type TerritorySlot,
} from "../../foundations/f-territory-store/store.js";
import {
  changeMembers,
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

/** Repo-relative path of a node's live or evolution territory MDX. */
export function territoryPath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  return markdownRelativePath(node, slot);
}

/**
 * Deduplicate changed paths (null: nothing written). The map snapshot is derived: it is never
 * listed, even when a caller still passes `includeMap` (kept so older call sites compile).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function changedFiles(paths: (string | null)[], _includeMap = false): string[] {
  return [...new Set(paths.filter((p): p is string => Boolean(p) && p !== MAP_REL))];
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
 * Default write tail: the touched node's state and next_state (the single open revision's or a
 * legacy next file's state; null with none or several), plus `revisions: [{ change, state,
 * conflicts? }]` when the node has open revisions. Neighborhood and record come only with
 * `verbose: true` (`buildMutationAnchor`).
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
  const open = revisionSummaries(node);
  if (open.length > 0) tail.revisions = open;
  return verbose ? { ...tail, ...buildMutationAnchor(graph, nodeId) } : tail;
}

/**
 * One line per open revision of `node` in a write result: the read surfaces' summary
 * (`revisionSummaries` of f-plan-views: change, state, conflict count) without the title.
 */
export function revisionSummaries(node: MindPlanNode): { change: string; state: string; conflicts: number }[] {
  return readSummaries(node).map(({ change, state, conflicts }) => ({ change, state, conflicts }));
}

/**
 * Every change id with an open revision anywhere: a pre-ship node's live change, a legacy next
 * file's change, and each open revision of a shipped node.
 */
export function openChangeIds(graph: MindPlanGraph): Set<string> {
  const out = new Set(changesWithRevisions(graph));
  for (const n of graph.nodes) for (const c of openChanges(n)) out.add(c);
  return out;
}

/** Whether `change` still has an open revision on any node. */
function changeIsOpen(graph: MindPlanGraph, change: string): boolean {
  return changeMembers(graph, change).length > 0 || graph.nodes.some((n) => openChanges(n).includes(change));
}

/** What a readiness reset reports: the slot (and, for a revision, its change) that left `ready`. */
export type ReadinessReset = {
  slot: TerritorySlot;
  change?: string;
  from: "ready" | "in-review";
  to: "draft";
  note: string;
};

export const READINESS_NOTE =
  "This revision was ready; a contract write sent it back to draft. Review the contract and self-ready it again.";

/** The note of a reset from in-review: the text under review changed, so it is reviewed again. */
export const IN_REVIEW_RESET_NOTE =
  "This revision was in review; a write changed its text and sent it back to draft. Review the contract and walk it to in-review again.";

/**
 * Report a readiness reset the store made during a contract write (`demoteReadySlot`).
 * A ready → draft move never changes a Capability state, so only the map is refreshed.
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

/** The reset a contract write reports when it sends the revision of `change` from ready (or in-review) back to draft. */
export function revisionReadinessReset(change: string, from: ReadinessReset["from"] = "ready"): ReadinessReset {
  return { slot: "next", change, from, to: "draft", note: from === "ready" ? READINESS_NOTE : IN_REVIEW_RESET_NOTE };
}

/** A contract write to a ready revision sends it back to draft; returns the reset and files. */
export function revisionReadinessResult(
  node: MindPlanNode,
  change: string
): { reset: ReadinessReset | null; files: string[] } {
  if (revisionFor(node, change)?.state !== "ready") return { reset: null, files: [] };
  const written = writeRevisionState(node, change, "draft");
  return { reset: revisionReadinessReset(change), files: written.changed_files };
}

export function readinessFields(reset: ReadinessReset | null): Record<string, unknown> {
  return reset ? { readiness_reset: reset } : {};
}

/**
 * The Blocked for `change` / `change_ref` on a shipped node with no open next
 * (`isShippedWithoutNext`): its files are edited in place, and only a revision carries a change id.
 */
export function shippedChangeBlocked(node: Pick<MindPlanNode, "id">): Error {
  return new Error(
    `Blocked: "${node.id}" is shipped with no open revision: edit its files in place; it needs no change id (open_next if its contract changes).`
  );
}

/**
 * A change with no open revisions left is closed: drop the planned edges recorded under each of
 * these changes from every node in `graph`. Returns the dropped entries and the files.
 */
export function clearClosedChanges(
  graph: MindPlanGraph,
  changes: string[]
): { planned: string[]; files: string[] } {
  const planned: string[] = [];
  const files: string[] = [];
  for (const change of new Set(changes)) {
    if (changeIsOpen(graph, change)) continue;
    // Wiring planned under a closed change was never opened: it goes with the change.
    for (const node of graph.nodes) {
      const dropped = (node.planned ?? []).filter((e) => e.change === change);
      if (dropped.length === 0) continue;
      writePlannedEdges(node, (node.planned ?? []).filter((e) => e.change !== change));
      files.push(territoryPath(node, "current"));
      for (const e of dropped) planned.push(`${node.id} -${e.type}-> ${e.target} (${change})`);
    }
  }
  return { planned, files };
}

/**
 * Run a write that can end a change (a status move, a discard, a change id moved or cleared), then
 * drop the planned edges of every change that had an open revision before the write and has none
 * after. Every such write goes through here, so a new write path cannot forget the cleanup. The
 * cleanup also runs when the write throws part-way (a batch keeps its earlier transitions); the
 * result then carries nothing, as before.
 */
export function withChangeCleanup(write: () => Record<string, unknown>): Record<string, unknown> {
  const before = openChangeIds(loadGraph());
  let result: Record<string, unknown> | undefined;
  try {
    result = write();
  } finally {
    if (before.size > 0) {
      const graph = loadGraph();
      const after = openChangeIds(graph);
      const closed = [...before].filter((c) => !after.has(c));
      const dropped = closed.length ? clearClosedChanges(graph, closed) : { planned: [], files: [] };
      if (result && dropped.planned.length > 0) {
        const prior = (result.cleared_planned as string[] | undefined) ?? [];
        const files = (result.changed_files as string[] | undefined) ?? [];
        result = {
          ...result,
          cleared_planned: [...new Set([...prior, ...dropped.planned])],
          changed_files: [...new Set([...files, ...dropped.files])],
        };
      }
    }
  }
  return result!;
}
