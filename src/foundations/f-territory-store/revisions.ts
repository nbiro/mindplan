/**
 * Revision files: a shipped node's open revisions, one folder per change id,
 * `<node folder>/revisions/<change>/` holding `<id>.mdx` (frontmatter: the `Revision` record;
 * body: the revision's territory), `attachments/`, and `decisions/` (`decisions-store.ts`).
 * Ship or discard deletes the folder. The path helpers are final; the writers are stubs whose doc
 * comments are the contract (WP1/WP2 implement them).
 *
 * Every writer that takes a node also updates `node.open_revisions` in memory, the way
 * `appendDecision` updates `node.decisions`, and returns repo-relative POSIX `changed_files`.
 */

import * as path from "path";
import type {
  EdgeDelta,
  FoundationRole,
  MindPlanGraph,
  MindPlanNode,
  NextPipelineState,
  PlannedEdge,
  PlannedEdgeType,
  ProductionState,
  Revision,
  RevisionConflict,
} from "../f-domain-model/types.js";
import { decisionsDir } from "./decisions-store.js";
import { ATTACHMENTS_DIR, entityDir, entityRelativePath, liveMdxFilename } from "./store.js";

/** Folder inside a node folder that holds one folder per open revision. */
export const REVISIONS_DIR = "revisions";

/** One revision as read from disk. */
export interface RevisionFile {
  revision: Revision;
  /** The revision file's body (frontmatter excluded), as on disk. */
  body: string;
  /** Absolute path of `<id>.mdx`. */
  path: string;
}

/** `<nodeFolder>/revisions/<change>` (absolute in, absolute out). */
export function revisionDir(nodeFolder: string, change: string): string {
  return path.join(nodeFolder, REVISIONS_DIR, change);
}

/** Absolute path of a revision's territory file, `<node folder>/revisions/<change>/<id>.mdx`. */
export function revisionFilePath(node: Pick<MindPlanNode, "id" | "type">, change: string): string {
  return path.join(revisionDir(entityDir(node), change), liveMdxFilename(node.id));
}

/** Repo-relative POSIX path of a revision's territory file, for `changed_files`. */
export function revisionRelativeFilePath(node: Pick<MindPlanNode, "id" | "type">, change: string): string {
  return path.posix.join(entityRelativePath(node), REVISIONS_DIR, change, liveMdxFilename(node.id));
}

/** Absolute path of a revision's attachments folder. */
export function revisionAttachmentsDir(node: Pick<MindPlanNode, "id" | "type">, change: string): string {
  return path.join(revisionDir(entityDir(node), change), ATTACHMENTS_DIR);
}

/** Absolute path of a revision's decisions folder. */
export function revisionDecisionsDir(node: Pick<MindPlanNode, "id" | "type">, change: string): string {
  return decisionsDir(revisionDir(entityDir(node), change));
}

/**
 * Every open revision under `<nodeFolder>/revisions/`, sorted by change id. A folder whose
 * `<nodeId>.mdx` is missing is skipped; a file whose frontmatter does not parse into a `Revision`
 * (unknown state, change id not matching its folder name) is Blocked naming the path. Each
 * revision's `decisions` are read from its `decisions/` folder (`readDecisionFiles`). A missing
 * `revisions/` folder is an empty list. Read-only.
 */
export function readRevisions(nodeFolder: string, nodeId: string): RevisionFile[] {
  throw new Error("not implemented: readRevisions");
}

/**
 * Opens a revision of shipped `node` under `change`: Blocked when the node is not a shipped
 * pipeline node, is retired, or already has a revision of `change`. Writes
 * `revisions/<change>/<id>.mdx` with state `draft`, `opened_at` = `updated_at` = now, title and
 * description from `opts` or live, no role, empty deltas except the planned edges of this change
 * (`plannedAdds`, as edge adds), `base` = `scalarHashes` / `sectionHashes` of live, no conflicts,
 * and the live body (Decisions section excluded) with fresh Atomic Ops. Pushes the revision onto
 * `node.open_revisions` and returns it with the paths written.
 */
export function openRevision(
  node: MindPlanNode,
  change: string,
  opts: { change_ref?: string; title?: string; description?: string; plannedAdds?: PlannedEdge[] }
): { revision: Revision; changed_files: string[] } {
  throw new Error("not implemented: openRevision");
}

/**
 * Deletes `revisions/<change>/` (file, attachments, decisions) and removes the revision from
 * `node.open_revisions`; removes `revisions/` when it ends empty. Blocked when the node has no
 * revision of `change`. Returns every path deleted.
 */
export function discardRevision(node: MindPlanNode, change: string): { changed_files: string[] } {
  throw new Error("not implemented: discardRevision");
}

/**
 * Ships the revision of `change`: Blocked when it has unresolved conflicts. Rewrites live from
 * live ⊕ revision (scalars, edges/claims/tests via `applyDelta`, body, role, split_into), sets
 * `state` = `opts.newState`, `shipped_at` = `opts.now`, bumps `revisions` and `churn`, moves the
 * revision's decision files and attachments into live (`moveDecisions`), and deletes its folder.
 * Then rebases every sibling revision of the node onto the new live (`rebase` from
 * f-revision-model, with `implementsOwners` from `graph`) and rewrites each sibling's file.
 * Updates `node` and `node.open_revisions` in memory. Returns every path written or deleted and,
 * per sibling, the conflicts it holds after the rebase.
 */
export function shipRevision(
  graph: MindPlanGraph,
  node: MindPlanNode,
  change: string,
  opts: { now: string; newState: ProductionState }
): { changed_files: string[]; rebased: { change: string; conflicts: RevisionConflict[] }[] } {
  throw new Error("not implemented: shipRevision");
}

/**
 * Replaces one delta of the revision of `change` (`field`: an edge type, `implements`, or
 * `tests`), stored trimmed against live (adds already live and removes not live dropped) and
 * sorted; sets `updated_at`. Blocked when the node has no revision of `change`.
 */
export function writeRevisionDelta(
  node: MindPlanNode,
  change: string,
  field: PlannedEdgeType | "implements" | "tests",
  delta: EdgeDelta
): { changed_files: string[] } {
  throw new Error("not implemented: writeRevisionDelta");
}

/**
 * Patches the revision's scalars: a key present in `patch` replaces the stored value (`role`
 * `null` and `change_ref` `""` clear it); sets `updated_at`. Blocked when the node has no
 * revision of `change`.
 */
export function writeRevisionScalars(
  node: MindPlanNode,
  change: string,
  patch: {
    title?: string;
    description?: string;
    role?: FoundationRole | null;
    change_ref?: string;
    attributed?: string[];
    split_into?: string[];
  }
): { changed_files: string[] } {
  throw new Error("not implemented: writeRevisionScalars");
}

/**
 * Replaces the revision file's body (frontmatter kept); the `## Rules` and `## Decisions`
 * sections of `body` are ignored (rules are slot-independent, decisions live in files). Sets
 * `updated_at`. Blocked when the node has no revision of `change`.
 */
export function writeRevisionBody(node: MindPlanNode, change: string, body: string): { changed_files: string[] } {
  throw new Error("not implemented: writeRevisionBody");
}

/** Sets the revision's pipeline `state` and `updated_at`. Blocked when the node has no revision of `change`. */
export function writeRevisionState(
  node: MindPlanNode,
  change: string,
  state: NextPipelineState
): { changed_files: string[] } {
  throw new Error("not implemented: writeRevisionState");
}

/**
 * Resolves one conflict of the revision of `change`. `target` names it: a section heading
 * (`"## Spec"`), a scalar field (`"title"`, `"description"`, `"role"`), or a claim path.
 * `take`: `"revision"` keeps the revision's value; `"live"` takes live's (a claim: drops the add);
 * `"text"` writes `text` (sections and scalars only; Blocked without `text`). Removes the conflict
 * and sets `updated_at`. Blocked when the revision holds no such conflict. Returns the paths
 * written and the conflicts left.
 */
export function resolveConflict(
  node: MindPlanNode,
  change: string,
  target: string,
  take: "revision" | "live" | "text",
  text?: string
): { changed_files: string[]; conflicts: RevisionConflict[] } {
  throw new Error("not implemented: resolveConflict");
}
