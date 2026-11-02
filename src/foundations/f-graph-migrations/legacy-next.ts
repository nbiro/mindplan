/**
 * Legacy next files — a frozen reader of the `<id>.next.mdx` evolution file and its
 * `next-attachments/` folder that releases before migration level 4 kept beside a shipped node.
 * It copies what the store's next-slot parser did when level 4 was added, so the store may drop
 * that parser while the level-4 migration (moveNextToRevisions) can still read old graphs.
 * Owned by Foundation f-graph-migrations.
 */

import * as fs from "fs";
import * as path from "path";
import {
  MIRROR_STATE,
  PLANNED_EDGE_TYPES,
  isFoundationRole,
  isMirrorState,
  isNextPipelineState,
  type FoundationRole,
  type NextPipelineState,
  type PlannedEdgeType,
} from "../f-domain-model/types.js";
import { readFileRetry } from "../f-source-index/io.js";
import { parseFrontmatter, splitContext } from "../f-territory-store/store.js";

/** The folder that held a legacy next file's attachments, beside `attachments/`. */
export const LEGACY_NEXT_ATTACHMENTS_DIR = "next-attachments";

/** The legacy next file's name: `<id>.next.mdx`. */
export function legacyNextFilename(id: string): string {
  return `${id}.next.mdx`;
}

/** Absolute path of a node folder's legacy next file. */
export function legacyNextFile(folder: string, id: string): string {
  return path.join(folder, legacyNextFilename(id));
}

/** Absolute path of a node folder's legacy `next-attachments/`. */
export function legacyNextAttachmentsDir(folder: string): string {
  return path.join(folder, LEGACY_NEXT_ATTACHMENTS_DIR);
}

/** One legacy next file, as the store read it: a full snapshot of the node under its revision. */
export interface LegacyNext {
  state: NextPipelineState;
  title: string;
  description: string;
  updated_at: string;
  opened_at?: string;
  change?: string;
  change_ref?: string;
  role?: FoundationRole;
  /** Outgoing edges by planned edge type (a missing key in the file is an empty list). */
  edges: Record<PlannedEdgeType, string[]>;
  implements: string[];
  tests: string[];
  attributed: string[];
  split_into: string[];
  /** The file's body (frontmatter excluded), as on disk. */
  body: string;
}

/**
 * Parses `<id>.next.mdx` of node `folderId`. Null when the file is a leftover `state: mirror` twin
 * (not an evolution). Blocked when the frontmatter is missing, lacks state or updated_at, or holds
 * an illegal state or role.
 */
export function parseLegacyNext(folderId: string, nextFile: string): LegacyNext | null {
  const raw = readFileRetry(nextFile);
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(`Blocked: next file for "${folderId}" has no YAML frontmatter (expected at ${nextFile}).`);
  }
  const fm = parsed.scalars;
  if (!fm.state || !fm.updated_at) {
    throw new Error(`Blocked: next frontmatter for "${folderId}" must include state and updated_at.`);
  }
  if (isMirrorState(fm.state)) return null;
  if (!isNextPipelineState(fm.state)) {
    throw new Error(
      `Blocked: ${path.basename(nextFile)} for "${folderId}" has invalid next state "${fm.state}". ` +
        `Allowed: ${MIRROR_STATE}, draft, ready, in-progress, in-review.`
    );
  }
  const edges = {} as Record<PlannedEdgeType, string[]>;
  for (const type of PLANNED_EDGE_TYPES) edges[type] = [...parsed.arrays[type]];
  const next: LegacyNext = {
    state: fm.state,
    title: fm.title ?? "",
    description: fm.description ?? "",
    updated_at: fm.updated_at,
    edges,
    implements: [...parsed.implements],
    tests: [...parsed.tests],
    attributed: [...parsed.attributed],
    split_into: [...parsed.split_into],
    body: splitContext(raw)?.body ?? "",
  };
  if (fm.change) next.change = fm.change;
  if (fm.change_ref) next.change_ref = fm.change_ref;
  if (fm.opened_at) next.opened_at = fm.opened_at;
  if (fm.role) {
    if (!isFoundationRole(fm.role)) {
      throw new Error(
        `Blocked: invalid Foundation role "${fm.role}" in ${path.basename(nextFile)} for "${folderId}". ` +
          `Allowed: assembler, infra, design-system, adapter.`
      );
    }
    next.role = fm.role;
  }
  return next;
}
