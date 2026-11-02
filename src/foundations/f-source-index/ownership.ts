/**
 * Ownership index — live / next / released / retired claim maps from implements lists, plus every
 * open revision's claims keyed by change.
 */

import type { MindPlanGraph, MindPlanNode } from "../f-domain-model/types.js";
import { isPipelineNodeType } from "../f-domain-model/types.js";
import { applyDelta } from "../f-revision-model/index.js";
import { expandClaims, validateClaimPath } from "./claims.js";

const RETIRED_STATES = new Set(["cancelled", "deprecated"]);

/** One open revision's claim on a file. */
export type RevisionClaim = { id: string; change: string };

export type OwnershipBuckets = {
  live: Map<string, string>;
  next: Map<string, string>;
  released: Map<string, string>;
  retired: Map<string, string>;
  /**
   * File → every open revision claiming it (`applyDelta(live implements, revision.implements)`
   * expanded), one entry per node and change, in node then change order.
   */
  revisions: Map<string, RevisionClaim[]>;
  /** Every non-retired node's live claims, whatever is open on it (file → node id). */
  liveClaims: Map<string, string>;
  /** Change → live files a revision of that change drops (file → node id). */
  releasedByChange: Map<string, Map<string, string>>;
};

/**
 * Build ownership index from implements lists.
 * Exclusivity uses live ∪ next (released excluded); per change, `ownerUnder`.
 * Coverage uses live ∪ next ∪ released ∪ every revision (`claimantsOf`); retired claims only feed
 * leftovers. `next` is the legacy next file or the loader's single-revision view, as before.
 */
export function buildOwnershipIndex(
  graph: MindPlanGraph,
  root?: string
): OwnershipBuckets {
  const live = new Map<string, string>();
  const next = new Map<string, string>();
  const released = new Map<string, string>();
  const retired = new Map<string, string>();
  const revisions = new Map<string, RevisionClaim[]>();
  const liveClaims = new Map<string, string>();
  const releasedByChange = new Map<string, Map<string, string>>();

  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type)) continue;
    const currentFiles = new Set(expandClaims(node.implements, root));
    if (!RETIRED_STATES.has(node.state)) {
      for (const f of currentFiles) liveClaims.set(f, node.id);
      for (const rev of node.open_revisions ?? []) {
        const revFiles = new Set(expandClaims(applyDelta(node.implements, rev.implements), root));
        for (const f of revFiles) {
          const list = revisions.get(f) ?? [];
          list.push({ id: node.id, change: rev.change });
          revisions.set(f, list);
        }
        for (const f of currentFiles) {
          if (revFiles.has(f)) continue;
          let byFile = releasedByChange.get(rev.change);
          if (!byFile) releasedByChange.set(rev.change, (byFile = new Map()));
          byFile.set(f, node.id);
        }
      }
    }
    const nextFiles = node.next
      ? new Set(expandClaims(node.next.implements, root))
      : null;

    if (RETIRED_STATES.has(node.state)) {
      for (const f of currentFiles) {
        if (!retired.has(f)) retired.set(f, node.id);
      }
      continue;
    }

    if (nextFiles) {
      for (const f of nextFiles) {
        next.set(f, node.id);
      }
      for (const f of currentFiles) {
        if (nextFiles.has(f)) {
          live.set(f, node.id);
        } else {
          released.set(f, node.id);
        }
      }
    } else {
      for (const f of currentFiles) {
        live.set(f, node.id);
      }
    }
  }

  return { live, next, released, retired, revisions, liveClaims, releasedByChange };
}

/**
 * The owner of `file` as change `change` sees it: a node whose open revision of `change` claims
 * it, else its live owner unless that owner's revision of `change` drops it. Other changes'
 * revisions are invisible. Null when nothing owns it under the change.
 */
export function ownerUnder(buckets: OwnershipBuckets, file: string, change: string): string | null {
  const mine = buckets.revisions.get(file)?.find((c) => c.change === change);
  if (mine) return mine.id;
  const live = buckets.liveClaims.get(file);
  if (!live) return null;
  if (buckets.releasedByChange.get(change)?.get(file) === live) return null;
  return live;
}

/** Live files the open revisions of `change` drop (file → node id); empty when none. */
export function releasedUnder(buckets: OwnershipBuckets, change: string): Map<string, string> {
  return buckets.releasedByChange.get(change) ?? new Map();
}

/**
 * Live implements claim entries released by an open next slot.
 * Same release idea as buildOwnershipIndex (live expanded file omitted from
 * next.implements), applied at claim-entry granularity so presence can skip
 * directories already moved off disk (expandClaims omits missing paths).
 */
export function releasedClaimEntries(
  node: MindPlanNode,
  root?: string
): Set<string> {
  const out = new Set<string>();
  if (!isPipelineNodeType(node.type)) return out;
  if (!node.next) return out;

  const nextEntries = new Set(
    (node.next.implements ?? []).map((e) => validateClaimPath(e))
  );
  const nextFiles = new Set(expandClaims(node.next.implements, root));

  for (const raw of node.implements ?? []) {
    const entry = validateClaimPath(raw);
    if (nextEntries.has(entry)) continue;
    const expanded = expandClaims([entry], root);
    if (expanded.every((f) => !nextFiles.has(f))) {
      out.add(raw);
      out.add(entry);
    }
  }
  return out;
}

/** Exclusive owner (live or next; not released/retired). Prefer next. */
export function exclusiveOwner(
  buckets: OwnershipBuckets,
  file: string
): string | null {
  if (buckets.next.has(file)) return buckets.next.get(file)!;
  if (buckets.live.has(file)) return buckets.live.get(file)!;
  return null;
}

export function ownerOfFile(
  buckets: OwnershipBuckets,
  file: string
): { id: string; via: "live" | "next" | "released" | "retired" } | null {
  if (buckets.next.has(file)) return { id: buckets.next.get(file)!, via: "next" };
  if (buckets.live.has(file)) return { id: buckets.live.get(file)!, via: "live" };
  if (buckets.released.has(file)) return { id: buckets.released.get(file)!, via: "released" };
  if (buckets.retired.has(file)) return { id: buckets.retired.get(file)!, via: "retired" };
  return null;
}

/**
 * One non-retired claim on a file. `released` is a current-slot claim an open next dropped;
 * `revision` is an open revision's claim (with its change).
 */
export type Claimant =
  | { id: string; via: "live" | "next" | "released" }
  | { id: string; via: "revision"; change: string };

/**
 * Every non-retired claim on a file: its next-slot owner, its live owner, a released owner, and
 * each open revision claiming it that is not already listed by node id (the loader's
 * single-revision view is listed as `next`).
 */
export function claimantsOf(buckets: OwnershipBuckets, file: string): Claimant[] {
  const out: Claimant[] = [];
  if (buckets.next.has(file)) out.push({ id: buckets.next.get(file)!, via: "next" });
  if (buckets.live.has(file)) out.push({ id: buckets.live.get(file)!, via: "live" });
  if (buckets.released.has(file)) out.push({ id: buckets.released.get(file)!, via: "released" });
  for (const r of buckets.revisions.get(file) ?? []) {
    if (out.some((c) => c.id === r.id)) continue;
    out.push({ id: r.id, via: "revision", change: r.change });
  }
  return out;
}

/**
 * Expanded files for a pipeline node's live and/or next slot, and with several open revisions,
 * each revision's files by change.
 */
export function nodeOwnedFiles(
  node: MindPlanNode,
  root?: string
): { files: string[]; next_files?: string[]; revision_files?: Record<string, string[]> } {
  const files = expandClaims(node.implements, root);
  const out: { files: string[]; next_files?: string[]; revision_files?: Record<string, string[]> } = { files };
  if (node.next) out.next_files = expandClaims(node.next.implements, root);
  if ((node.open_revisions?.length ?? 0) > 1) {
    out.revision_files = {};
    for (const rev of node.open_revisions!) {
      out.revision_files[rev.change] = expandClaims(applyDelta(node.implements, rev.implements), root);
    }
  }
  return out;
}

export { RETIRED_STATES };
