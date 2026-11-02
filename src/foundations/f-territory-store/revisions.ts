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
  isMirrorState,
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
  emptyDelta,
  PREAMBLE_SECTION,
  rebase,
  resolveRevisionChange,
  revisionFor,
  scalarHashes,
  sectionHashes,
  splitSections,
  withRevision,
  type RebaseLive,
} from "../f-revision-model/index.js";
import { RM_MAX_RETRIES, copyFileRetry, readFileRetry, withTransientRetry, writeFileRetry } from "../f-source-index/io.js";
import { decisionsDir, moveDecisions, readDecisionFiles } from "./decisions-store.js";
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
  readNextFileState,
  splitContext,
  splitNodeDecisions,
  splitNodeRules,
  validateChangeInput,
  withFreshAtomicOps,
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

/** Deduped and sorted by code unit, so a list sorts the same on every locale. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** A list item as written: plain when it holds only path characters, else a JSON string. */
function formatItem(value: string): string {
  return /^[A-Za-z0-9_./@=:+*-]+$/.test(value) ? value : JSON.stringify(value);
}

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

function listLines(key: string, items: string[] | undefined): string[] {
  if (!items || items.length === 0) return [];
  return [`${key}:`, ...items.map((i) => `  - ${formatItem(i)}`)];
}

function conflictEntry(c: RevisionConflict): string {
  if (c.kind === "section") return `section:${c.section}`;
  if (c.kind === "scalar") return `scalar:${c.field}`;
  return `claim:${c.path}@${c.owner}`;
}

/**
 * One revision file's text: the flat frontmatter (LF line endings), a blank line, then `body`.
 * The revision's `decisions` are not written: they live in its `decisions/` folder.
 */
export function formatRevisionFile(nodeId: string, nodeType: NodeType, revision: Revision, body: string): string {
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
  lines.push(...listLines("conflicts", revision.conflicts.map(conflictEntry)));
  lines.push("---");
  return oneBlankLineBelowFrontmatter(`${lines.join("\n")}\n${body}`);
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
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const lines = split.frontmatter.split(/\r?\n/).slice(1, -1);
  for (let i = 0; i < lines.length; i++) {
    const keyOnly = lines[i].match(/^(\w+):\s*$/);
    if (keyOnly) {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s+-\s+/, "").trim()));
      }
      lists[keyOnly[1]] = items;
      continue;
    }
    const scalar = lines[i].match(/^(\w+):\s*(.*)$/);
    if (scalar) scalars[scalar[1]] = unquote(scalar[2].trim());
  }
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
 * Every open revision under `<nodeFolder>/revisions/`, sorted by change id. A folder whose
 * `<nodeId>.mdx` is missing is skipped; a file whose frontmatter does not parse into a `Revision`
 * (unknown state, change id not matching its folder name) is Blocked naming the path. Each
 * revision's `decisions` are read from its `decisions/` folder (`readDecisionFiles`). A missing
 * `revisions/` folder is an empty list. Read-only.
 */
export function readRevisions(nodeFolder: string, nodeId: string): RevisionFile[] {
  const dir = path.join(nodeFolder, REVISIONS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RevisionFile[] = [];
  for (const name of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
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
 * Sets the `next` view the gates still read: a legacy `<id>.next.mdx` evolution keeps its own;
 * otherwise exactly one open revision fills it (`withRevision`), and none or several leave it unset.
 */
export function syncNextView(node: MindPlanNode): void {
  const legacyState = readNextFileState(node);
  if (legacyState && !isMirrorState(legacyState)) return;
  const open = node.open_revisions ?? [];
  if (open.length === 1) node.next = withRevision(node, open[0].change).next;
  else delete node.next;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function repoRelative(abs: string): string {
  return path.relative(projectRoot(), abs).split(path.sep).join("/");
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Reads the revision of `change` from disk (decisions from memory); Blocked when it is not open. */
function loadRevision(node: MindPlanNode, change: string): { revision: Revision; body: string } {
  resolveRevisionChange(node, change);
  const file = revisionFilePath(node, change);
  if (!fs.existsSync(file)) throw blocked(`revision file of "${node.id}" for change "${change}" is missing (${file}).`);
  const parsed = parseRevisionFile(readFileRetry(file), node.id);
  const decisions = revisionFor(node, change)?.decisions;
  if (decisions?.length) parsed.revision.decisions = decisions;
  return parsed;
}

/** Writes one revision file, replaces it in `node.open_revisions`, and returns its repo path. */
function storeRevision(node: MindPlanNode, revision: Revision, body: string): string {
  const file = revisionFilePath(node, revision.change);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileRetry(file, formatRevisionFile(node.id, node.type, revision, body));
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
  const { revision, body } = loadRevision(node, change);
  if (revision.conflicts.length > 0) {
    throw blocked(
      `revision "${change}" of "${node.id}" has unresolved conflicts (${revision.conflicts.map(conflictEntry).join(", ")}); ` +
        `resolve each with resolve_conflict first.`
    );
  }
  const changed = new Set<string>();
  const before = liveBody(node);
  const liveOld = liveSide(node, before.body);

  // Decisions first: a name clash Blocks before anything is written.
  const moved = moveDecisions(revisionDecisionsDir(node, change), decisionsDir(entityDir(node)));
  for (const abs of moved) changed.add(repoRelative(abs));

  const edges: Partial<Record<PlannedEdgeType, string[]>> = {};
  for (const type of PLANNED_EDGE_TYPES) edges[type] = applyDelta(node[type], revision.edges[type]);
  const newParts = (revision.split_into ?? []).filter((id) => !(node.split_into ?? []).includes(id));
  // Live decisions still in the `## Decisions` section stay there until the migration splits them.
  const liveDecisionSection = splitNodeDecisions(splitNodeRules(before.body).body).section;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  writePromotedLive(node, opts.newState, opts.now, {
    title: revision.title,
    description: revision.description,
    role: revision.role ?? node.role,
    edges,
    implements: applyDelta(node.implements, revision.implements),
    tests: applyDelta(node.tests, revision.tests),
    aliases: [...(node.aliases ?? [])],
    change,
    splitInto: newParts.length > 0 ? newParts : undefined,
    body: joinNodeDecisions(withoutOwnedSections(body), liveDecisionSection),
    eol,
    separator: `${eol}${eol}`,
  });
  changed.add(markdownRelativePath(node, "current"));
  if (revision.decisions?.length) node.decisions = [...(node.decisions ?? []), ...revision.decisions];

  // Attachments join live.
  const revAtt = revisionAttachmentsDir(node, change);
  if (fs.existsSync(revAtt)) {
    const dest = attachmentsDir(node);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(revAtt, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === ".gitkeep") continue;
      copyFileRetry(path.join(revAtt, entry.name), path.join(dest, entry.name));
      changed.add(repoRelative(path.join(dest, entry.name)));
    }
  }
  for (const rel of deleteRevisionFolder(node, change)) changed.add(rel);
  dropRevision(node, change);

  // Siblings move onto the new live.
  const implementsOwners = new Map<string, string>();
  for (const other of graph.nodes) {
    if (other.id === node.id || isInactiveNode(other)) continue;
    for (const entry of other.implements ?? []) if (!implementsOwners.has(entry)) implementsOwners.set(entry, other.id);
  }
  const liveNew = { ...liveSide(node, liveBody(node).body), implementsOwners };
  const rebased: { change: string; conflicts: RevisionConflict[] }[] = [];
  for (const sibling of [...(node.open_revisions ?? [])]) {
    const current = loadRevision(node, sibling.change);
    const out = rebase({ liveOld, liveNew, revision: current.revision, revisionBody: current.body, nodeId: node.id });
    changed.add(storeRevision(node, out.revision, out.body));
    rebased.push({ change: sibling.change, conflicts: out.revision.conflicts });
  }
  return { changed_files: [...changed], rebased };
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
  if (patch.change_ref !== undefined) validateChangeInput({ change_ref: patch.change_ref });
  if (patch.role != null && !isFoundationRole(patch.role)) {
    throw blocked(`invalid Foundation role "${patch.role}". Allowed: assembler, infra, design-system, adapter.`);
  }
  const { revision, body } = loadRevision(node, change);
  if (patch.title !== undefined) revision.title = patch.title;
  if (patch.description !== undefined) revision.description = patch.description;
  if (patch.role === null) delete revision.role;
  else if (patch.role !== undefined) revision.role = patch.role;
  if (patch.change_ref === "") delete revision.change_ref;
  else if (patch.change_ref !== undefined) revision.change_ref = patch.change_ref;
  for (const key of ["attributed", "split_into"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value.length > 0) revision[key] = [...new Set(value)];
    else delete revision[key];
  }
  revision.updated_at = nowIso();
  return { changed_files: [storeRevision(node, revision, body)] };
}

/**
 * Replaces the revision file's body (frontmatter kept); the `## Rules` and `## Decisions`
 * sections of `body` are ignored (rules are slot-independent, decisions live in files). Sets
 * `updated_at`. Blocked when the node has no revision of `change`.
 */
export function writeRevisionBody(node: MindPlanNode, change: string, body: string): { changed_files: string[] } {
  const { revision } = loadRevision(node, change);
  revision.updated_at = nowIso();
  return { changed_files: [storeRevision(node, revision, withoutOwnedSections(body))] };
}

/** Sets the revision's pipeline `state` and `updated_at`. Blocked when the node has no revision of `change`. */
export function writeRevisionState(
  node: MindPlanNode,
  change: string,
  state: NextPipelineState
): { changed_files: string[] } {
  if (!isNextPipelineState(state)) {
    throw blocked(`invalid revision state "${state}". Allowed: draft, ready, in-progress, in-review.`);
  }
  const { revision, body } = loadRevision(node, change);
  revision.state = state;
  revision.updated_at = nowIso();
  return { changed_files: [storeRevision(node, revision, body)] };
}

/** Text as compared and rejoined: LF line endings, trailing whitespace dropped. */
function normalizedText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * `body` with section `heading` replaced by `text` (heading line included), or removed when
 * `text` is undefined; a missing section is added before `## Rules` / `## Decisions`, else at the
 * end. Sections are rejoined with one blank line between them, in the body's line endings.
 */
function replaceSection(body: string, heading: string, text: string | undefined): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const parts = splitSections(body).map((s) => ({ heading: s.heading, text: s.text }));
  const at = parts.findIndex((p) => p.heading === heading);
  if (text === undefined) {
    if (at >= 0) parts.splice(at, 1);
  } else if (at >= 0) {
    parts[at] = { heading, text };
  } else {
    const owned = parts.findIndex((p) => p.heading === "## Rules" || p.heading === "## Decisions");
    parts.splice(owned === -1 ? parts.length : owned, 0, { heading, text });
  }
  const kept = parts.map((p) => normalizedText(p.text)).filter((t) => t.length > 0);
  return kept.length ? `${kept.join("\n\n")}\n`.replace(/\n/g, eol) : "";
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
    const held = revision.conflicts.map(conflictEntry);
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
        if (value === "") delete revision.role;
        else if (isFoundationRole(value)) revision.role = value;
        else throw blocked(`invalid Foundation role "${value}". Allowed: assembler, infra, design-system, adapter.`);
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
