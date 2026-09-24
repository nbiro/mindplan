/**
 * Ownership index — live / next / released / retired claim maps from implements lists.
 */

import type { MindPlanGraph, MindPlanNode } from "../f-domain-model/types.js";
import { isPipelineNodeType } from "../f-domain-model/types.js";
import { expandClaims, validateClaimPath } from "./claims.js";

const RETIRED_STATES = new Set(["cancelled", "deprecated"]);

export type OwnershipBuckets = {
  live: Map<string, string>;
  next: Map<string, string>;
  released: Map<string, string>;
  retired: Map<string, string>;
};

/**
 * Build ownership index from implements lists.
 * Exclusivity uses live ∪ next (released excluded).
 * Coverage uses live ∪ next ∪ released ∪ retired.
 */
export function buildOwnershipIndex(
  graph: MindPlanGraph,
  root?: string
): OwnershipBuckets {
  const live = new Map<string, string>();
  const next = new Map<string, string>();
  const released = new Map<string, string>();
  const retired = new Map<string, string>();

  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type)) continue;
    const currentFiles = new Set(expandClaims(node.implements, root));
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

  return { live, next, released, retired };
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

/** Expanded files for a pipeline node's live and/or next slot. */
export function nodeOwnedFiles(
  node: MindPlanNode,
  root?: string
): { files: string[]; next_files?: string[] } {
  const files = expandClaims(node.implements, root);
  if (node.next) {
    return { files, next_files: expandClaims(node.next.implements, root) };
  }
  return { files };
}

export { RETIRED_STATES };
