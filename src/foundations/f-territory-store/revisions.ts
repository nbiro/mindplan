/**
 * Revision files: a shipped node's open revisions, one folder per change id,
 * `<node folder>/revisions/<change>/` holding `<id>.mdx` (frontmatter: the `Revision` record;
 * body: the revision's territory), `attachments/`, and `decisions/` (`decisions-store.ts`).
 * Ship or discard deletes the folder. The path helpers are final; the writers are stubs whose doc
 * comments are the contract (WP1/WP2 implement them).
 *
 * Every writer that takes a node also updates `node.open_revisions` in memory, the way
 * `appendDecision` updates `node.decisions`, and returns repo-relative POSIX `changed_files`.
 *
 * Revision frontmatter is flat: scalars (`id`, `type`, `change`, `change_ref`, `state`,
 * `opened_at`, `updated_at`, `title`, `description`, `role`), then block lists
 * `<edge>_add` / `<edge>_remove` per planned edge type, `implements_add` / `implements_remove`,
 * `tests_add` / `tests_remove`, `attributed`, `split_into`, `base` (`title=<hash>`,
 * `section:<heading>=<hash>`, …), and `conflicts` (`section:<heading>`, `scalar:<field>`,
 * `claim:<path>@<owner>`). List items that are not plain path characters are JSON strings.
 */

import * as fs from "fs";
import * as path from "path";
import {
  CHANGE_ID_PATTERN,
  PLANNED_EDGE_TYPES,
  isFoundationRole,
  isInactiveNode,
  isNextPipelineState,
  isPipelineNodeType,
  type EdgeDelta,
  type FoundationRole,
  type MindPlanGraph,
  type MindPlanNode,
  type NextPipelineState,
  type NodeType,
  type PlannedEdge,
  type PlannedEdgeType,
  type ProductionState,
  type Revision,
  type RevisionConflict,
} from "../f-domain-model/types.js";
import {
  applyDelta,
  conflictLabel,
  detectEol,
  emptyDelta,
  joinSections,
  levelTwoHeadings,
  PREAMBLE_SECTION,
  pickRevision,
  rebase,
  resolveRevisionChange,
  revisionFor,
  scalarHashes,
  sectionHashes,
  splitParts,
  splitSections,
  withRevision,
  type RebaseLive,
} from "../f-revision-model/index.js";
import { RM_MAX_RETRIES, copyFileRetry, readFileRetry, withTransientRetry, writeFileRetry } from "../f-source-index/io.js";
import { repoRelative } from "../f-source-index/root-scope.js";
import {
  assertNoDecisionClash,
  decisionFolderFiles,
  decisionsDir,
  moveDecisions,
  readDecisionFiles,
} from "./decisions-store.js";
import {
  ATTACHMENTS_DIR,
  attachmentsDir,
  entityDir,
  entityRelativePath,
  joinNodeDecisions,
  liveMdxFilename,
  markdownRelativePath,
  oneBlankLineBelowFrontmatter,
  projectRoot,
  readMarkdown,
  scanFrontmatter,
  splitContext,
  splitNodeDecisions,
  splitNodeRules,
  unquote,
  validateChangeInput,
  withFreshAtomicOps,
  withoutAtomicOps,
  withoutOwnedSections,
  writePromotedLive,
} from "./store.js";

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

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

function blocked(message: string): Error {
  return new Error(`Blocked: ${message}`);
}

/** A Blocked error thrown after some files were already written (`changed_files`, repo-relative). */
export type BlockedWithWrites = Error & { changed_files?: string[] };

/** Attaches the files a write made before it Blocked, so a batch can still report them. */
export function withWrittenFiles(err: Error, files: string[]): BlockedWithWrites {
  const carried = err as BlockedWithWrites;
  carried.changed_files = [...new Set([...(carried.changed_files ?? []), ...files])];
  return carried;
}

/** The files an error says were written before it was thrown; empty for any other error. */
export function writtenFilesOf(err: unknown): string[] {
  const files = (err as BlockedWithWrites | null)?.changed_files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/** Deduped and sorted by code unit, so a list sorts the same on every locale. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** A list item as written: plain when it holds only path characters, else a JSON string. */
function formatItem(value: string): string {
  return /^[A-Za-z0-9_./@=:+*-]+$/.test(value) ? value : JSON.stringify(value);
}

function listLines(key: string, items: string[] | undefined): string[] {
  if (!items || items.length === 0) return [];
  return [`${key}:`, ...items.map((i) => `  - ${formatItem(i)}`)];
}

/**
 * One revision file's text: the flat frontmatter, a blank line, then `body`, every line ending
 * `eol` (writers pass the node's live file's, so a CRLF node gets CRLF revisions). The revision's
 * `decisions` are not written: they live in its `decisions/` folder.
 */
export function formatRevisionFile(
  nodeId: string,
  nodeType: NodeType,
  revision: Revision,
  body: string,
  eol: "\n" | "\r\n" = "\n"
): string {
  const lines = ["---", `id: ${nodeId}`, `type: ${nodeType}`, `change: ${revision.change}`];
  if (revision.change_ref) lines.push(`change_ref: ${JSON.stringify(revision.change_ref)}`);
  lines.push(
    `state: ${revision.state}`,
    `opened_at: ${revision.opened_at}`,
    `updated_at: ${revision.updated_at}`,
    `title: ${JSON.stringify(revision.title)}`,
    `description: ${JSON.stringify(revision.description)}`
  );
  if (revision.role) lines.push(`role: ${revision.role}`);
  else if (revision.role_removed) lines.push("role_removed: true");
  for (const type of PLANNED_EDGE_TYPES) {
    lines.push(...listLines(`${type}_add`, revision.edges[type]?.add));
    lines.push(...listLines(`${type}_remove`, revision.edges[type]?.remove));
  }
  lines.push(...listLines("implements_add", revision.implements.add));
  lines.push(...listLines("implements_remove", revision.implements.remove));
  lines.push(...listLines("tests_add", revision.tests.add));
  lines.push(...listLines("tests_remove", revision.tests.remove));
  lines.push(...listLines("attributed", revision.attributed));
  lines.push(...listLines("split_into", revision.split_into));
  lines.push("base:");
  for (const [field, hash] of Object.entries(revision.base.scalars)) lines.push(`  - ${formatItem(`${field}=${hash}`)}`);
  for (const [heading, hash] of Object.entries(revision.base.sections)) {
    lines.push(`  - ${formatItem(`section:${heading}=${hash}`)}`);
  }
  lines.push(...listLines("conflicts", revision.conflicts.map(conflictLabel)));
  lines.push("---");
  return oneBlankLineBelowFrontmatter(`${lines.join(eol)}${eol}${body.replace(/\r?\n/g, eol)}`);
}

/** The revision file's list keys: every `<list>_add` / `<list>_remove` delta, base hashes, conflicts, and the part lists. */
function isRevisionList(key: string): boolean {
  return /_(add|remove)$/.test(key) || key === "base" || key === "conflicts" || key === "attributed" || key === "split_into";
}

function parseConflict(entry: string): RevisionConflict {
  if (entry.startsWith("section:")) return { kind: "section", section: entry.slice("section:".length) };
  if (entry.startsWith("scalar:")) {
    const field = entry.slice("scalar:".length);
    if (field === "title" || field === "description" || field === "role") return { kind: "scalar", field };
  }
  if (entry.startsWith("claim:")) {
    const rest = entry.slice("claim:".length);
    const at = rest.lastIndexOf("@");
    if (at > 0 && at < rest.length - 1) return { kind: "claim", path: rest.slice(0, at), owner: rest.slice(at + 1) };
  }
  throw blocked(`unreadable conflict entry "${entry}".`);
}

/**
 * Parses one revision file of node `nodeId` into its `Revision` (without `decisions`) and body.
 * Blocked when the frontmatter is missing, names another node, or holds an invalid change id,
 * state, role, or conflict entry.
 */
export function parseRevisionFile(text: string, nodeId: string): { revision: Revision; body: string } {
  const split = splitContext(text);
  if (!split) throw blocked(`revision file of "${nodeId}" has no YAML frontmatter.`);
  const scanned = scanFrontmatter(split.frontmatter.split(/\r?\n/).slice(1, -1).join("\n"), isRevisionList);
  const scalars = scanned.scalars;
  const lists = Object.fromEntries(Object.entries(scanned.lists).map(([k, items]) => [k, items.map(unquote)]));
  if ((scalars.id ?? nodeId) !== nodeId) {
    throw blocked(`revision file names node "${scalars.id}", not "${nodeId}".`);
  }
  const change = scalars.change ?? "";
  if (!CHANGE_ID_PATTERN.test(change)) throw blocked(`revision file of "${nodeId}" has invalid change id "${change}".`);
  const state = scalars.state ?? "";
  if (!isNextPipelineState(state)) {
    throw blocked(
      `revision "${change}" of "${nodeId}" has invalid state "${state}". Allowed: draft, ready, in-progress, in-review.`
    );
  }
  if (!scalars.opened_at || !scalars.updated_at) {
    throw blocked(`revision "${change}" of "${nodeId}" must include opened_at and updated_at.`);
  }
  const delta = (key: string): EdgeDelta => ({ add: lists[`${key}_add`] ?? [], remove: lists[`${key}_remove`] ?? [] });
  const revision: Revision = {
    change,
    state,
    opened_at: scalars.opened_at,
    updated_at: scalars.updated_at,
    title: scalars.title ?? "",
    description: scalars.description ?? "",
    edges: {},
    implements: delta("implements"),
    tests: delta("tests"),
    base: { scalars: {}, sections: {} },
    conflicts: (lists.conflicts ?? []).map(parseConflict),
  };
  if (scalars.change_ref) revision.change_ref = scalars.change_ref;
  if (scalars.role) {
    if (!isFoundationRole(scalars.role)) {
      throw blocked(`revision "${change}" of "${nodeId}" has invalid Foundation role "${scalars.role}".`);
    }
    revision.role = scalars.role;
  } else if (scalars.role_removed === "true") {
    revision.role_removed = true;
  }
  for (const type of PLANNED_EDGE_TYPES) {
    const d = delta(type);
    if (d.add.length || d.remove.length) revision.edges[type] = d;
  }
  if (lists.attributed?.length) revision.attributed = lists.attributed;
  if (lists.split_into?.length) revision.split_into = lists.split_into;
  for (const entry of lists.base ?? []) {
    const eq = entry.lastIndexOf("=");
    if (eq <= 0) throw blocked(`revision "${change}" of "${nodeId}" has unreadable base entry "${entry}".`);
    const key = entry.slice(0, eq);
    const hash = entry.slice(eq + 1);
    if (key.startsWith("section:")) revision.base.sections[key.slice("section:".length)] = hash;
    else revision.base.scalars[key] = hash;
  }
  return { revision, body: split.body };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The folder names under `<nodeFolder>/revisions/` (one per open revision, named by its change),
 * sorted; a missing or unreadable folder is empty. Never throws.
 */
export function revisionFolderNames(nodeFolder: string): string[] {
  try {
    return fs
      .readdirSync(path.join(nodeFolder, REVISIONS_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every open revision under `<nodeFolder>/revisions/`, sorted by change id. A folder whose
 * `<nodeId>.mdx` is missing is skipped; a file whose frontmatter does not parse into a `Revision`
 * (unknown state, change id not matching its folder name) is Blocked naming the path. Each
 * revision's `decisions` are read from its `decisions/` folder (`readDecisionFiles`). A missing
 * `revisions/` folder is an empty list. Read-only.
 */
export function readRevisions(nodeFolder: string, nodeId: string): RevisionFile[] {
  const dir = path.join(nodeFolder, REVISIONS_DIR);
  const out: RevisionFile[] = [];
  for (const name of revisionFolderNames(nodeFolder)) {
    const file = path.join(dir, name, liveMdxFilename(nodeId));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    let parsed: { revision: Revision; body: string };
    try {
      parsed = parseRevisionFile(readFileRetry(file), nodeId);
    } catch (err) {
      throw new Error(`${(err as Error).message} (${file})`);
    }
    if (parsed.revision.change !== name) {
      throw blocked(`revision file ${file} names change "${parsed.revision.change}", not its folder "${name}".`);
    }
    const decisions = readDecisionFiles(decisionsDir(path.join(dir, name)));
    if (decisions.length > 0) parsed.revision.decisions = decisions;
    out.push({ ...parsed, path: file });
  }
  return out;
}

/**
 * Sets the `next` view the gates still read: exactly one open revision fills it (`withRevision`),
 * and none or several leave it unset.
 */
export function syncNextView(node: MindPlanNode): void {
  const { change, view } = pickRevision(node, undefined, { strict: false });
  if (change !== null) node.next = view.next;
  else delete node.next;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Reads the revision of `change` from disk (decisions from memory); Blocked when it is not open
 * or its file is missing.
 */
export function loadRevision(node: MindPlanNode, change: string): { revision: Revision; body: string } {
  resolveRevisionChange(node, change);
  const file = revisionFilePath(node, change);
  if (!fs.existsSync(file)) throw blocked(`revision file of "${node.id}" for change "${change}" is missing (${file}).`);
  const parsed = parseRevisionFile(readFileRetry(file), node.id);
  const decisions = revisionFor(node, change)?.decisions;
  if (decisions?.length) parsed.revision.decisions = decisions;
  return parsed;
}

/** The line ending of the node's live file (CRLF when it has any), else LF. */
function liveEol(node: MindPlanNode): "\n" | "\r\n" {
  try {
    return detectEol(readMarkdown(node, "current"));
  } catch {
    return "\n";
  }
}

/**
 * Writes one revision file in the line endings of the node's live file, replaces it in
 * `node.open_revisions`, and returns its repo path.
 */
function storeRevision(node: MindPlanNode, revision: Revision, body: string): string {
  const file = revisionFilePath(node, revision.change);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileRetry(file, formatRevisionFile(node.id, node.type, revision, body, liveEol(node)));
  const others = (node.open_revisions ?? []).filter((r) => r.change !== revision.change);
  node.open_revisions = [...others, revision].sort((a, b) => (a.change < b.change ? -1 : a.change > b.change ? 1 : 0));
  syncNextView(node);
  return revisionRelativeFilePath(node, revision.change);
}

function dropRevision(node: MindPlanNode, change: string): void {
  const rest = (node.open_revisions ?? []).filter((r) => r.change !== change);
  if (rest.length > 0) node.open_revisions = rest;
  else delete node.open_revisions;
  syncNextView(node);
}

/** Deletes a revision folder (and `revisions/` when it ends empty); returns the files deleted, repo-relative. */
function deleteRevisionFolder(node: Pick<MindPlanNode, "id" | "type">, change: string): string[] {
  const dir = revisionDir(entityDir(node), change);
  const removed: string[] = [];
  if (!fs.existsSync(dir)) return removed;
  const walk = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else removed.push(repoRelative(child));
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: RM_MAX_RETRIES });
  const parent = path.dirname(dir);
  if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) withTransientRetry(() => fs.rmdirSync(parent));
  return removed.sort();
}

function liveBody(node: Pick<MindPlanNode, "id" | "type">): { raw: string; body: string; separator: string } {
  const raw = readMarkdown(node, "current");
  const split = splitContext(raw);
  if (!split) throw blocked(`live file for "${node.id}" has no YAML frontmatter.`);
  return { raw, body: split.body, separator: split.separator };
}

function liveEdges(node: MindPlanNode): Partial<Record<PlannedEdgeType, string[]>> {
  const out: Partial<Record<PlannedEdgeType, string[]>> = {};
  for (const type of PLANNED_EDGE_TYPES) if (node[type]?.length) out[type] = [...node[type]!];
  return out;
}

function liveSide(node: MindPlanNode, body: string): RebaseLive {
  return {
    scalars: { title: node.title, description: node.description, role: node.role },
    body,
    edges: liveEdges(node),
    implements: [...(node.implements ?? [])],
    tests: [...(node.tests ?? [])],
  };
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
  if (!CHANGE_ID_PATTERN.test(change)) {
    throw blocked(`change id "${change}" must be a slug (lowercase letters, digits, "-" or "_").`);
  }
  validateChangeInput({ change_ref: opts.change_ref });
  if (!isPipelineNodeType(node.type) || !node.shipped_at) {
    throw blocked(`"${node.id}" is not a shipped Foundation, Interaction, or Interface; only those open revisions.`);
  }
  if (isInactiveNode(node)) throw blocked(`"${node.id}" is ${node.state}; a retired node opens no revision.`);
  if (revisionFor(node, change) || fs.existsSync(revisionDir(entityDir(node), change))) {
    throw blocked(`"${node.id}" already has an open revision of change "${change}".`);
  }
  const live = liveBody(node);
  const now = nowIso();
  const edges: Revision["edges"] = {};
  for (const p of opts.plannedAdds ?? []) {
    if (p.change !== change || (node[p.type] ?? []).includes(p.target)) continue;
    const d = (edges[p.type] ??= emptyDelta());
    d.add = sortedUnique([...d.add, p.target]);
  }
  const revision: Revision = {
    change,
    state: "draft",
    opened_at: now,
    updated_at: now,
    title: opts.title ?? node.title,
    description: opts.description ?? node.description,
    edges,
    implements: emptyDelta(),
    tests: emptyDelta(),
    base: {
      scalars: scalarHashes({ title: node.title, description: node.description, role: node.role }),
      sections: sectionHashes(live.body),
    },
    conflicts: [],
  };
  if (opts.change_ref) revision.change_ref = opts.change_ref;
  // The revision starts its own Atomic Ops; rules and decisions are not copied (rules are
  // slot-independent, decisions live in files).
  const body = withFreshAtomicOps(withoutOwnedSections(live.body), node.type);
  const written = storeRevision(node, revision, body);
  return { revision, changed_files: [written] };
}

/**
 * Deletes `revisions/<change>/` (file, attachments, decisions) and removes the revision from
 * `node.open_revisions`; removes `revisions/` when it ends empty. Blocked when the node has no
 * revision of `change`. Returns every path deleted.
 */
export function discardRevision(node: MindPlanNode, change: string): { changed_files: string[] } {
  resolveRevisionChange(node, change);
  const changed_files = deleteRevisionFolder(node, change);
  dropRevision(node, change);
  return { changed_files };
}

/** True when live moved since the revision's recorded `base`: a scalar or level-2 section hash differs. */
function liveMovedSince(revision: Revision, live: RebaseLive): boolean {
  if (Object.keys(revision.base.scalars).length === 0) return false;
  const scalars = scalarHashes(live.scalars);
  for (const [field, hash] of Object.entries(revision.base.scalars)) if (scalars[field] !== hash) return true;
  const sections = sectionHashes(live.body);
  const recorded = revision.base.sections;
  const keys = new Set([...Object.keys(sections), ...Object.keys(recorded)]);
  for (const key of keys) if (sections[key] !== recorded[key]) return true;
  return false;
}

/** What a rebase can change in a revision's own text: its scalars and each body section. */
function contentKey(revision: Revision, body: string): string {
  return JSON.stringify([
    revision.title,
    revision.description,
    revision.role ?? null,
    revision.role_removed ?? false,
    sectionHashes(body),
  ]);
}

/** Bytes of each file a ship may write or delete (null: absent), to put back when a write fails. */
type FileSnapshot = Map<string, Buffer | null>;

function snapshotFile(snap: FileSnapshot, abs: string): void {
  if (snap.has(abs)) return;
  if (!fs.existsSync(abs)) snap.set(abs, null);
  else if (fs.statSync(abs).isFile()) snap.set(abs, fs.readFileSync(abs));
}

function snapshotTree(snap: FileSnapshot, dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) snapshotTree(snap, child);
    else snapshotFile(snap, child);
  }
}

/** Puts every snapshotted file back as it was: rewritten, or removed when it did not exist. */
function restoreSnapshot(snap: FileSnapshot): void {
  for (const [abs, bytes] of snap) {
    try {
      if (bytes === null) {
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true, maxRetries: RM_MAX_RETRIES });
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, bytes);
      }
    } catch {
      // Best effort: the remaining files are still put back.
    }
  }
}

/** One sibling revision carried onto the new live, with the readiness reset that came with it. */
export type RebasedSibling = {
  change: string;
  conflicts: RevisionConflict[];
  /** Present when the rebase changed a `ready` / `in-review` sibling's text: it is `draft` again. */
  readiness_reset?: { from: NextPipelineState; to: "draft" };
};

/** Claim entry → id of another active node that claims it live: what a rebase recomputes claim conflicts from. */
function implementsOwnersOf(graph: MindPlanGraph, node: MindPlanNode): Map<string, string> {
  const owners = new Map<string, string>();
  for (const other of graph.nodes) {
    if (other.id === node.id || isInactiveNode(other)) continue;
    for (const entry of other.implements ?? []) if (!owners.has(entry)) owners.set(entry, other.id);
  }
  return owners;
}

/**
 * One revision carried onto `liveNew` with `rebase`; a `ready` / `in-review` revision whose text
 * the rebase changed goes back to `draft` (`readiness_reset`). Pure: nothing is written.
 */
function carryRevision(
  nodeId: string,
  liveOld: RebaseLive,
  liveNew: RebaseLive & { implementsOwners?: Map<string, string> },
  revision: Revision,
  body: string
): { out: { revision: Revision; body: string }; readiness_reset?: RebasedSibling["readiness_reset"] } {
  const out = rebase({ liveOld, liveNew, revision, revisionBody: body, nodeId });
  const state = out.revision.state;
  if ((state === "ready" || state === "in-review") && contentKey(out.revision, out.body) !== contentKey(revision, body)) {
    out.revision.state = "draft";
    return { out, readiness_reset: { from: state, to: "draft" } };
  }
  return { out };
}

/**
 * True when live moved since the recorded `base` of the revision of `change` (live changed after
 * it opened: a live patch, or a ship merged in from another branch). Blocked when it is not open.
 */
export function revisionBaseStale(node: MindPlanNode, change: string): boolean {
  const { revision } = loadRevision(node, change);
  return liveMovedSince(revision, liveSide(node, liveBody(node).body));
}

/** What `rebaseRevisionOntoLive` did to one revision. */
export type RevisionRebase = {
  /** False when the revision's base already matched live: nothing was written. */
  rebased: boolean;
  conflicts: RevisionConflict[];
  /** Present when the rebase changed a `ready` / `in-review` revision's text: it is `draft` again. */
  readiness_reset?: { from: NextPipelineState; to: "draft" };
  changed_files: string[];
};

/**
 * Carries the open revision of `change` onto current live with the rule a ship applies to its
 * siblings (`carryRevision`): a section or scalar the revision left untouched takes live's, one
 * both edited becomes a conflict, every base hash moves to live, deltas are trimmed against live,
 * claim conflicts are recomputed from `graph`, and a `ready` / `in-review` revision whose text
 * changed goes back to `draft`. A revision whose base already matches live is left as it is
 * (`rebased: false`). Blocked when the node has no revision of `change`.
 */
export function rebaseRevisionOntoLive(graph: MindPlanGraph, node: MindPlanNode, change: string): RevisionRebase {
  const loaded = loadRevision(node, change);
  const liveNow = liveSide(node, liveBody(node).body);
  if (!liveMovedSince(loaded.revision, liveNow)) {
    return { rebased: false, conflicts: loaded.revision.conflicts, changed_files: [] };
  }
  const carried = carryRevision(
    node.id,
    liveNow,
    { ...liveNow, implementsOwners: implementsOwnersOf(graph, node) },
    loaded.revision,
    loaded.body
  );
  carried.out.revision.updated_at = nowIso();
  const written = storeRevision(node, carried.out.revision, carried.out.body);
  return {
    rebased: true,
    conflicts: carried.out.revision.conflicts,
    ...(carried.readiness_reset ? { readiness_reset: carried.readiness_reset } : {}),
    changed_files: [written],
  };
}

/**
 * The revision as a ship carries it onto current live (`liveNow`): unchanged when its base still
 * matches live, else rebased with `rebase` (a section or scalar both edited becomes a conflict).
 * Pure: nothing is written.
 */
function revisionOntoCurrentLive(
  node: MindPlanNode,
  loaded: { revision: Revision; body: string },
  liveNow: RebaseLive
): { revision: Revision; body: string } {
  if (!liveMovedSince(loaded.revision, liveNow)) return loaded;
  const own = rebase({ liveOld: liveNow, liveNew: liveNow, revision: loaded.revision, revisionBody: loaded.body, nodeId: node.id });
  return { revision: own.revision, body: own.body };
}

/** The Block a ship raises when carrying its revision onto live that moved in place yields conflicts. */
function shipRebaseConflictMessage(nodeId: string, change: string, conflicts: RevisionConflict[]): string {
  return (
    `live "${nodeId}" changed in place since revision "${change}" last started from it, and both edited ` +
    `${conflicts.map(conflictLabel).join(", ")}; the revision now holds those conflicts. ` +
    `Resolve each with resolve_conflict({ node_id: "${nodeId}", change: "${change}", target, take }), then ship again.`
  );
}

/**
 * The check `shipRevision` makes before its first write, without writing: Blocked with the same
 * message when the revision of `change` would gain conflicts on being carried onto current live
 * (live changed in place since it opened). A validated walk uses it to foresee that Block.
 */
export function assertRevisionShipsOntoLive(node: MindPlanNode, change: string): void {
  const loaded = loadRevision(node, change);
  const own = revisionOntoCurrentLive(node, loaded, liveSide(node, liveBody(node).body));
  if (own !== loaded && own.revision.conflicts.length > 0) {
    throw blocked(shipRebaseConflictMessage(node.id, change, own.revision.conflicts));
  }
}

/**
 * Ships the revision of `change`: Blocked when it has unresolved conflicts. When live moved in
 * place since the revision's `base` (a live patch while it was open), the revision is first carried
 * onto current live with `rebase`; a section or scalar both changed is stored on the revision as a
 * conflict and the ship is Blocked naming resolve_conflict. Then everything that can Block is
 * checked before the first write (every sibling revision file parses, no decision file name
 * clashes with live's), and every sibling's rebase is computed in memory.
 *
 * The writes: live from live ⊕ revision (scalars, edges/claims/tests via `applyDelta`, body, role
 * — cleared when the revision removes it — and the split parts `splitParts` counts linked), with
 * `state` = `opts.newState`, `shipped_at` = `opts.now`, `revisions` and `churn` bumped; the
 * revision's decision files and attachments join live; every sibling is rewritten rebased onto the
 * new live (`implementsOwners` from `graph`), a `ready` / `in-review` sibling whose text the rebase
 * changed going back to `draft`; the revision folder is deleted. A failing write puts every file
 * back as it was (and `node` in memory) before the error is rethrown. Returns every path written
 * or deleted and, per sibling, the conflicts it holds after the rebase.
 */
export function shipRevision(
  graph: MindPlanGraph,
  node: MindPlanNode,
  change: string,
  opts: { now: string; newState: ProductionState }
): { changed_files: string[]; rebased: RebasedSibling[] } {
  const loaded = loadRevision(node, change);
  if (loaded.revision.conflicts.length > 0) {
    throw blocked(
      `revision "${change}" of "${node.id}" has unresolved conflicts (${loaded.revision.conflicts.map(conflictLabel).join(", ")}); ` +
        `resolve each with resolve_conflict first.`
    );
  }
  const before = liveBody(node);
  const liveOld = liveSide(node, before.body);

  // The revision onto live as it is now: live may have been patched in place while it was open.
  const own = revisionOntoCurrentLive(node, loaded, liveOld);
  if (own.revision.conflicts.length > 0) {
    const written = storeRevision(node, own.revision, own.body);
    // The conflicts are persisted before the Block: callers report the file as written.
    throw withWrittenFiles(blocked(shipRebaseConflictMessage(node.id, change, own.revision.conflicts)), [written]);
  }
  const revision = own.revision;
  const body = own.body;

  // Everything that can Block, before the first write.
  const siblings = (node.open_revisions ?? [])
    .filter((r) => r.change !== change)
    .map((r) => ({ change: r.change, ...loadRevision(node, r.change) }));
  const fromDecisions = revisionDecisionsDir(node, change);
  const toDecisions = decisionsDir(entityDir(node));
  assertNoDecisionClash(fromDecisions, toDecisions);

  const edges: Partial<Record<PlannedEdgeType, string[]>> = {};
  for (const type of PLANNED_EDGE_TYPES) edges[type] = applyDelta(node[type], revision.edges[type]);
  const implementsNew = applyDelta(node.implements, revision.implements);
  const testsNew = applyDelta(node.tests, revision.tests);
  const role = revision.role_removed ? undefined : revision.role ?? node.role;
  // The parts the dry-run walk counts: marked and linked (`splitParts`).
  const newParts = splitParts(graph, withRevision({ ...node, open_revisions: [revision] }, change));
  // Live decisions still in the `## Decisions` section stay there until the migration splits them.
  const liveDecisionSection = splitNodeDecisions(splitNodeRules(before.body).body).section;
  const eol = detectEol(body);
  const promotedBody = joinNodeDecisions(withoutOwnedSections(body), liveDecisionSection);

  // Siblings onto the new live, in memory.
  const implementsOwners = implementsOwnersOf(graph, node);
  const liveEdgesNew: Partial<Record<PlannedEdgeType, string[]>> = {};
  for (const type of PLANNED_EDGE_TYPES) if (edges[type]!.length) liveEdgesNew[type] = edges[type];
  const liveNew = {
    scalars: { title: revision.title, description: revision.description, role },
    body: withoutAtomicOps(promotedBody, node.type),
    edges: liveEdgesNew,
    implements: implementsNew,
    tests: testsNew,
    implementsOwners,
  };
  const carried = siblings.map((s) => ({
    change: s.change,
    ...carryRevision(node.id, liveOld, liveNew, s.revision, s.body),
  }));

  // The writes, put back as they were if one fails.
  const snap: FileSnapshot = new Map();
  snapshotFile(snap, path.join(projectRoot(), ...markdownRelativePath(node, "current").split("/")));
  snapshotTree(snap, revisionDir(entityDir(node), change));
  for (const name of decisionFolderFiles(fromDecisions)) snapshotFile(snap, path.join(toDecisions, name));
  const revAtt = revisionAttachmentsDir(node, change);
  const attachmentNames = fs.existsSync(revAtt)
    ? fs.readdirSync(revAtt, { withFileTypes: true }).filter((e) => e.isFile() && e.name !== ".gitkeep").map((e) => e.name)
    : [];
  for (const name of attachmentNames) snapshotFile(snap, path.join(attachmentsDir(node), name));
  for (const s of siblings) snapshotFile(snap, revisionFilePath(node, s.change));
  const nodeBefore = structuredClone(node);

  const changed = new Set<string>();
  try {
    for (const abs of moveDecisions(fromDecisions, toDecisions)) changed.add(repoRelative(abs));
    writePromotedLive(node, opts.newState, opts.now, {
      title: revision.title,
      description: revision.description,
      role,
      edges,
      implements: implementsNew,
      tests: testsNew,
      aliases: [...(node.aliases ?? [])],
      change,
      splitInto: newParts.length > 0 ? newParts : undefined,
      body: promotedBody,
      eol,
      separator: `${eol}${eol}`,
    });
    changed.add(markdownRelativePath(node, "current"));
    if (revision.decisions?.length) node.decisions = [...(node.decisions ?? []), ...revision.decisions];

    // Attachments join live.
    if (attachmentNames.length > 0) {
      const dest = attachmentsDir(node);
      fs.mkdirSync(dest, { recursive: true });
      for (const name of attachmentNames) {
        copyFileRetry(path.join(revAtt, name), path.join(dest, name));
        changed.add(repoRelative(path.join(dest, name)));
      }
    }
    for (const c of carried) changed.add(storeRevision(node, c.out.revision, c.out.body));
    for (const rel of deleteRevisionFolder(node, change)) changed.add(rel);
    dropRevision(node, change);
  } catch (err) {
    restoreSnapshot(snap);
    for (const key of Object.keys(node)) delete (node as unknown as Record<string, unknown>)[key];
    Object.assign(node, nodeBefore);
    throw err;
  }
  return {
    changed_files: [...changed],
    rebased: carried.map((c) => ({
      change: c.change,
      conflicts: c.out.revision.conflicts,
      ...(c.readiness_reset ? { readiness_reset: c.readiness_reset } : {}),
    })),
  };
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
  const isEdge = (PLANNED_EDGE_TYPES as readonly string[]).includes(field);
  if (!isEdge && field !== "implements" && field !== "tests") {
    throw blocked(`"${field}" is not a revision delta; use an edge type, implements, or tests.`);
  }
  const { revision, body } = loadRevision(node, change);
  const live = new Set(field === "implements" ? node.implements ?? [] : field === "tests" ? node.tests ?? [] : node[field] ?? []);
  const trimmed: EdgeDelta = {
    add: sortedUnique(delta.add.filter((v) => !live.has(v))),
    remove: sortedUnique(delta.remove.filter((v) => live.has(v))),
  };
  if (field === "implements") revision.implements = trimmed;
  else if (field === "tests") revision.tests = trimmed;
  else if (trimmed.add.length || trimmed.remove.length) revision.edges[field] = trimmed;
  else delete revision.edges[field];
  revision.updated_at = nowIso();
  return { changed_files: [storeRevision(node, revision, body)] };
}

/** The scalars `writeRevision` patches; `role: null` removes the role, `change_ref: ""` clears it. */
export type RevisionScalarsPatch = {
  title?: string;
  description?: string;
  role?: FoundationRole | null;
  change_ref?: string;
  attributed?: string[];
  split_into?: string[];
};

/**
 * One write of the revision of `change`: any of a new body (its `## Rules` and `## Decisions`
 * sections are ignored: rules are slot-independent, decisions live in files), scalars, and pipeline
 * `state`, applied to one loaded revision and stored once with a new `updated_at`. Everything is
 * checked before the write. Blocked when the node has no revision of `change`.
 */
export function writeRevision(
  node: MindPlanNode,
  change: string,
  patch: { body?: string; scalars?: RevisionScalarsPatch; state?: NextPipelineState }
): { changed_files: string[] } {
  const scalars = patch.scalars ?? {};
  if (scalars.change_ref !== undefined) validateChangeInput({ change_ref: scalars.change_ref });
  if (scalars.role != null && !isFoundationRole(scalars.role)) {
    throw blocked(`invalid Foundation role "${scalars.role}". Allowed: assembler, infra, design-system, adapter.`);
  }
  if (patch.state !== undefined && !isNextPipelineState(patch.state)) {
    throw blocked(`invalid revision state "${patch.state}". Allowed: draft, ready, in-progress, in-review.`);
  }
  const loaded = loadRevision(node, change);
  const revision = loaded.revision;
  const body = patch.body === undefined ? loaded.body : withoutOwnedSections(patch.body);
  if (scalars.title !== undefined) revision.title = scalars.title;
  if (scalars.description !== undefined) revision.description = scalars.description;
  if (scalars.role === null) {
    delete revision.role;
    revision.role_removed = true;
  } else if (scalars.role !== undefined) {
    revision.role = scalars.role;
    delete revision.role_removed;
  }
  if (scalars.change_ref === "") delete revision.change_ref;
  else if (scalars.change_ref !== undefined) revision.change_ref = scalars.change_ref;
  for (const key of ["attributed", "split_into"] as const) {
    const value = scalars[key];
    if (value === undefined) continue;
    if (value.length > 0) revision[key] = [...new Set(value)];
    else delete revision[key];
  }
  if (patch.state !== undefined) revision.state = patch.state;
  revision.updated_at = nowIso();
  return { changed_files: [storeRevision(node, revision, body)] };
}

/**
 * Patches the revision's scalars: a key present in `patch` replaces the stored value (`role`
 * `null` removes the role, so the ship clears live's; `change_ref` `""` clears it); sets `updated_at`. Blocked when the node has no
 * revision of `change`.
 */
export function writeRevisionScalars(
  node: MindPlanNode,
  change: string,
  patch: RevisionScalarsPatch
): { changed_files: string[] } {
  return writeRevision(node, change, { scalars: patch });
}

/**
 * Replaces the revision file's body (frontmatter kept); the `## Rules` and `## Decisions`
 * sections of `body` are ignored (rules are slot-independent, decisions live in files). Sets
 * `updated_at`. Blocked when the node has no revision of `change`.
 */
export function writeRevisionBody(node: MindPlanNode, change: string, body: string): { changed_files: string[] } {
  return writeRevision(node, change, { body });
}

/** Sets the revision's pipeline `state` and `updated_at`. Blocked when the node has no revision of `change`. */
export function writeRevisionState(
  node: MindPlanNode,
  change: string,
  state: NextPipelineState
): { changed_files: string[] } {
  return writeRevision(node, change, { state });
}

/**
 * `body` with section `heading` replaced by `text` (heading line included), or removed when
 * `text` is undefined; a missing section is added before `## Rules` / `## Decisions`, else at the
 * end (a missing `_preamble` at the top). Sections are rejoined with one blank line between them,
 * in the body's line endings.
 */
function replaceSection(body: string, heading: string, text: string | undefined): string {
  const eol = detectEol(body);
  const parts = splitSections(body).map((s) => ({ heading: s.heading, text: s.text }));
  const at = parts.findIndex((p) => p.heading === heading);
  if (text === undefined) {
    if (at >= 0) parts.splice(at, 1);
  } else if (at >= 0) {
    parts[at] = { heading, text };
  } else if (heading === PREAMBLE_SECTION) {
    parts.unshift({ heading, text });
  } else {
    const owned = parts.findIndex((p) => p.heading === "## Rules" || p.heading === "## Decisions");
    parts.splice(owned === -1 ? parts.length : owned, 0, { heading, text });
  }
  return joinSections(parts.map((p) => p.text), eol);
}

/**
 * Resolves one conflict of the revision of `change`. `target` names it: a section heading
 * (`"## Spec"`), a scalar field (`"title"`, `"description"`, `"role"`), or a claim path.
 * `take`: `"revision"` keeps the revision's value; `"live"` takes live's (a claim: drops the add);
 * `"text"` writes `text` (sections and scalars only; Blocked without `text`). Removes the conflict
 * and sets `updated_at`. Blocked when the revision holds no such conflict, and when `text` for a
 * section holds another level-2 heading (for `_preamble`, any). Returns the paths written and the
 * conflicts left.
 */
export function resolveConflict(
  node: MindPlanNode,
  change: string,
  target: string,
  take: "revision" | "live" | "text",
  text?: string
): { changed_files: string[]; conflicts: RevisionConflict[] } {
  const loaded = loadRevision(node, change);
  const { revision } = loaded;
  let body = loaded.body;
  const conflict = revision.conflicts.find(
    (c) =>
      (c.kind === "section" && c.section === target) ||
      (c.kind === "scalar" && c.field === target) ||
      (c.kind === "claim" && c.path === target)
  );
  if (!conflict) {
    const held = revision.conflicts.map(conflictLabel);
    throw blocked(
      `revision "${change}" of "${node.id}" holds no conflict on "${target}"; conflicts: ${held.length ? held.join(", ") : "(none)"}.`
    );
  }
  if (take !== "revision" && take !== "live" && take !== "text") {
    throw blocked(`take must be "revision", "live", or "text" (got "${String(take)}").`);
  }
  if (take === "text" && (conflict.kind === "claim" || text === undefined)) {
    throw blocked(
      conflict.kind === "claim"
        ? `a claim conflict takes "revision" or "live", not "text".`
        : `take "text" needs text for "${target}".`
    );
  }
  if (conflict.kind === "section") {
    const live = liveBody(node).body;
    if (take === "live") {
      body = replaceSection(body, target, splitSections(live).find((s) => s.heading === target)?.text);
    } else if (take === "text") {
      const t = text!.replace(/\r\n/g, "\n");
      const firstLine = t.replace(/^\n+/, "").split("\n")[0].trim();
      const headingText = target.replace(/ \(\d+\)$/, "");
      const withHeading = target === PREAMBLE_SECTION || firstLine === headingText ? t : `${headingText}\n\n${t}`;
      // The text stays one section: a level-2 heading in it (outside fenced code) would start
      // another section, or turn the preamble into one.
      const allowed = target === PREAMBLE_SECTION ? 0 : 1;
      const extra = levelTwoHeadings(withHeading.split("\n")).slice(allowed);
      if (extra.length > 0) {
        throw blocked(
          `take "text" for "${target}" holds the level-2 heading "## ${extra[0].name}"; the text replaces one ` +
            `${target === PREAMBLE_SECTION ? "preamble (the text above the first heading)" : "section"} and may not start another. ` +
            "Resolve this conflict without it and edit the other section with patch_node_territory."
        );
      }
      body = replaceSection(body, target, withHeading);
    }
    const hash = sectionHashes(live)[target];
    if (hash === undefined) delete revision.base.sections[target];
    else revision.base.sections[target] = hash;
  } else if (conflict.kind === "scalar") {
    const field = conflict.field;
    if (take === "live" || take === "text") {
      const value = take === "live" ? (field === "role" ? node.role ?? "" : node[field]) : text!;
      if (field === "role") {
        // Live with no role, taken: the revision removes the role (its ship clears it).
        if (value === "") {
          delete revision.role;
          revision.role_removed = true;
        } else if (isFoundationRole(value)) {
          revision.role = value;
          delete revision.role_removed;
        } else throw blocked(`invalid Foundation role "${value}". Allowed: assembler, infra, design-system, adapter.`);
      } else {
        revision[field] = value;
      }
    }
    revision.base.scalars[field] = scalarHashes({ title: node.title, description: node.description, role: node.role })[field];
  } else if (take === "live") {
    revision.implements = { ...revision.implements, add: revision.implements.add.filter((p) => p !== conflict.path) };
  }
  revision.conflicts = revision.conflicts.filter((c) => c !== conflict);
  revision.updated_at = nowIso();
  const written = storeRevision(node, revision, body);
  return { changed_files: [written], conflicts: revision.conflicts };
}
