/**
 * File system persistence for MindPlan.
 *
 * Layout (relative to the project root, i.e. MINDPLAN_ROOT or process.cwd()):
 *   /mindplan/map.md                       — auto-generated Mermaid snapshot (after each mutation)
 *   /mindplan/components/                  — project-specific MDX components (opaque to the compiler)
 *   /mindplan/journeys/<id>/<id>.mdx          (legacy: current.mdx)
 *   /mindplan/foundations/<id>/<id>.mdx       (+ optional <id>.next.mdx; legacy: current.mdx / next.mdx)
 *   /mindplan/interactions/<id>/<id>.mdx      (+ optional <id>.next.mdx; legacy: current.mdx / next.mdx)
 *   /mindplan/interfaces/<id>/<id>.mdx        (+ optional <id>.next.mdx; legacy: current.mdx / next.mdx)
 *   /mindplan/bugs/<id>/<id>.mdx              (legacy: current.mdx)
 *
 * Owned source files are declared via server-owned `implements` (not prescribed folders).
 * Live node records and outgoing edge arrays live in the live MDX YAML frontmatter.
 * While evolving a shipped Foundation/Interaction/Interface, the evolution file holds the draft pipeline + proposed edges.
 * After first ship, `<id>.next.mdx` stays as a standing twin with `state: mirror` (not an open evolution).
 * New files use the id names. An existing current.mdx / next.mdx stays in use.
 * When both names exist for one slot, the id-named file is kept and the legacy file is deleted.
 * Callers report those deletions via drainRemovedLegacyFiles().
 */

import * as fs from "fs";
import * as path from "path";
import type {
  BugSeverity,
  DecisionRecord,
  EdgeType,
  FoundationRole,
  MindPlanEdge,
  MindPlanGraph,
  MindPlanNode,
  NextPipelineState,
  NextSlot,
  NodeType,
} from "../f-domain-model/types.js";
import {
  BUG_SEVERITIES,
  CHANGE_ID_PATTERN,
  DECISION_ID_PATTERN,
  GRAPH_VERSION,
  isFoundationRole,
  isInactiveNode,
  isMirrorState,
  isNextPipelineState,
  isPipelineNodeType,
  isProductionState,
  MIRROR_STATE,
  NODE_TYPES,
} from "../f-domain-model/types.js";
import { claimCoversPath, isGlobClaim, normalizeClaimList } from "../f-source-index/claims.js";
import { loadProjectConfig } from "../f-source-index/config.js";

export {
  CONFIG_FILENAME,
  loadProjectConfig,
  projectConfigPath,
  projectConfigRelativePath,
  writeProjectConfig,
  type MindPlanProjectConfig,
  type WriteProjectConfigResult,
} from "../f-source-index/config.js";
const TYPE_DIRS: Record<NodeType, string> = {
  Journey: "journeys",
  Foundation: "foundations",
  Interaction: "interactions",
  Interface: "interfaces",
  Bug: "bugs",
};

const DIR_TO_TYPE: Record<string, NodeType> = {
  journeys: "Journey",
  foundations: "Foundation",
  interactions: "Interaction",
  interfaces: "Interface",
  bugs: "Bug",
};

const EDGE_FIELDS = [
  "belongs_to",
  "depends_on",
  "exposes",
  "leads_to",
  "affects",
  "mounts",
] as const;
type EdgeField = (typeof EDGE_FIELDS)[number];

/**
 * Array fields parsed like edges (YAML list or inline). `added_claims` is parsed here but is not
 * stripped by `stripListFieldLines`, so frontmatter rewriters that do not know it keep it verbatim.
 */
const LIST_FIELDS = [...EDGE_FIELDS, "implements", "added_claims"] as const;
type ListField = (typeof LIST_FIELDS)[number];

export const MINDPLAN_DIR = "mindplan";
export const AGENT_DIR = "agent";
export const SRC_DIR = "src";
/** Live territory record for new nodes. Named by node id so review diffs show which node changed. */
export function liveMdxFilename(id: string): string {
  return `${id}.mdx`;
}
/** In-flight evolution file for new nodes. */
export function nextMdxFilename(id: string): string {
  return `${id}.next.mdx`;
}
/** Previous live filename. Still read and written when that file is the one on disk. */
export const LEGACY_LIVE_FILENAME = "current.mdx";
/** Previous evolution filename. Still read and written when that file is the one on disk. */
export const LEGACY_NEXT_FILENAME = "next.mdx";
export const ATTACHMENTS_DIR = "attachments";
export const NEXT_ATTACHMENTS_DIR = "next-attachments";
export const COMPONENTS_DIR = "components";

export type TerritorySlot = "current" | "next";
export function mindplanRoot(): string {
  return path.join(process.env.MINDPLAN_ROOT ?? process.cwd(), MINDPLAN_DIR);
}

export function agentRoot(): string {
  return path.join(mindplanRoot(), AGENT_DIR);
}

export function typeDir(type: NodeType): string {
  return TYPE_DIRS[type];
}

/** Absolute path to an entity's folder, e.g. /mindplan/interactions/i-orient-plan */
export function entityDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(mindplanRoot(), TYPE_DIRS[node.type], node.id);
}

/** Project-relative path to an entity folder, e.g. mindplan/interactions/i-orient-plan */
export function entityRelativePath(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.posix.join(MINDPLAN_DIR, TYPE_DIRS[node.type], node.id);
}

/**
 * Historical package path hint (src/<kind>/<id>). Not ownership authority —
 * use `implements` / set_implementation_files. Kept for init migration seeding.
 */
export function implementationRelativePath(
  node: Pick<MindPlanNode, "id" | "type">
): string | null {
  if (!isPipelineNodeType(node.type)) return null;
  return path.posix.join(SRC_DIR, TYPE_DIRS[node.type], node.id);
}

/** Absolute path to the historical package directory, or null. */
export function implementationDir(node: Pick<MindPlanNode, "id" | "type">): string | null {
  const rel = implementationRelativePath(node);
  if (!rel) return null;
  return path.join(projectRoot(), ...rel.split("/"));
}

export function markdownPath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  return path.join(entityDir(node), territorySlotFilename(node, slot));
}

/** Project-relative path of the live or evolution MDX file actually on disk (or the name a new file will use). */
export function markdownRelativePath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  return `${entityRelativePath(node)}/${territorySlotFilename(node, slot)}`;
}

function preferredSlotFilename(id: string, slot: TerritorySlot): string {
  return slot === "next" ? nextMdxFilename(id) : liveMdxFilename(id);
}

function legacySlotFilename(slot: TerritorySlot): string {
  return slot === "next" ? LEGACY_NEXT_FILENAME : LEGACY_LIVE_FILENAME;
}

export type RemovedLegacyFile = { from: string; to: string };

const removedLegacyFiles: RemovedLegacyFile[] = [];

/** Paths deleted because the id-named file was kept. Clears the list. */
export function drainRemovedLegacyFiles(): RemovedLegacyFile[] {
  return removedLegacyFiles.splice(0, removedLegacyFiles.length);
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** True when both paths are the same directory entry (including a case-only difference on Windows). */
function sameFilesystemEntry(preferredPath: string, legacyPath: string): boolean {
  if (path.basename(preferredPath).toLowerCase() === path.basename(legacyPath).toLowerCase()) {
    return true;
  }
  try {
    return fs.realpathSync.native(preferredPath) === fs.realpathSync.native(legacyPath);
  } catch {
    return false;
  }
}

/**
 * When both the id-named file and the legacy file exist, the id-named file wins.
 * Returns true when the legacy file was deleted. A same-file pair (id `current`, or a
 * case-only alias) is left in place. A non-file at the id name is not treated as the winner.
 */
export function removeLegacyIfIdNamedExists(
  folder: string,
  id: string,
  slot: TerritorySlot,
  folderRel: string
): boolean {
  const preferred = preferredSlotFilename(id, slot);
  const legacy = legacySlotFilename(slot);
  if (preferred.toLowerCase() === legacy.toLowerCase()) return false;
  const preferredPath = path.join(folder, preferred);
  const legacyPath = path.join(folder, legacy);
  if (!isRegularFile(preferredPath) || !isRegularFile(legacyPath)) return false;
  if (sameFilesystemEntry(preferredPath, legacyPath)) return false;
  const legacyRel = `${folderRel}/${legacy}`;
  const preferredRel = `${folderRel}/${preferred}`;
  try {
    fs.unlinkSync(legacyPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Blocked: could not remove ${legacyRel} while keeping ${preferredRel} (${detail}). Fix ${legacyRel} by hand.`
    );
  }
  removedLegacyFiles.push({ from: legacyRel, to: preferredRel });
  return true;
}

/**
 * Filename for this slot. An existing legacy file wins over creating an id-named one.
 * New files use the id name, except a new evolution follows a legacy live file.
 * When both names exist, the legacy file is deleted and the id name is used.
 */
export function territorySlotFilename(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  const preferred = preferredSlotFilename(node.id, slot);
  const legacy = legacySlotFilename(slot);
  if (preferred === legacy) return preferred;
  const folder = entityDir(node);
  removeLegacyIfIdNamedExists(folder, node.id, slot, entityRelativePath(node));
  const preferredExists = fs.existsSync(path.join(folder, preferred));
  const legacyExists = fs.existsSync(path.join(folder, legacy));
  if (preferredExists) return preferred;
  if (legacyExists) return legacy;
  if (slot === "next" && liveFileIsLegacy(folder, node.id)) return legacy;
  return preferred;
}

function liveFileIsLegacy(folder: string, id: string): boolean {
  const preferred = liveMdxFilename(id);
  if (preferred === LEGACY_LIVE_FILENAME) return false;
  return (
    fs.existsSync(path.join(folder, LEGACY_LIVE_FILENAME)) &&
    !fs.existsSync(path.join(folder, preferred))
  );
}

/** Absolute path of the live or evolution file when one name exists. Null when neither does. */
function existingSlotFile(
  folder: string,
  id: string,
  slot: TerritorySlot,
  folderRel: string
): string | null {
  const preferred = preferredSlotFilename(id, slot);
  const legacy = legacySlotFilename(slot);
  const preferredPath = path.join(folder, preferred);
  const legacyPath = path.join(folder, legacy);
  if (preferred === legacy) return fs.existsSync(preferredPath) ? preferredPath : null;
  removeLegacyIfIdNamedExists(folder, id, slot, folderRel);
  const preferredExists = fs.existsSync(preferredPath);
  const legacyExists = fs.existsSync(legacyPath);
  if (preferredExists) return preferredPath;
  if (legacyExists) return legacyPath;
  return null;
}

export function attachmentsDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(entityDir(node), ATTACHMENTS_DIR);
}

export function nextAttachmentsDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(entityDir(node), NEXT_ATTACHMENTS_DIR);
}

/** True when the next-slot path exists on disk (mirror twin or open evolution). */
export function nextFileExists(node: Pick<MindPlanNode, "id" | "type">): boolean {
  return fs.existsSync(markdownPath(node, "next"));
}

/**
 * @deprecated Prefer `nextFileExists` (path on disk) or `node.next` (open evolution).
 * Kept for callers that only need "path present"; does not mean an evolution is open.
 */
export function nextExists(node: Pick<MindPlanNode, "id" | "type">): boolean {
  return nextFileExists(node);
}

/** Read `state:` from a next-slot file without requiring a pipeline state. */
export function readNextFileState(node: Pick<MindPlanNode, "id" | "type">): string | null {
  const file = markdownPath(node, "next");
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = parseFrontmatter(raw);
    return parsed?.scalars.state ?? null;
  } catch {
    return null;
  }
}

/** True when the next file exists and is a standing twin (`state: mirror`). */
export function isMirrorTwin(node: Pick<MindPlanNode, "id" | "type">): boolean {
  const state = readNextFileState(node);
  return state !== null && isMirrorState(state);
}

/**
 * Copy live territory bytes into `<id>.next.mdx` with only `state: mirror` changed.
 * Used after first ship, after ship of an evolution, after discard, and after live writes.
 */
export function writeMirrorTwin(node: Pick<MindPlanNode, "id" | "type">): string {
  const livePath = markdownPath(node, "current");
  if (!fs.existsSync(livePath)) {
    throw new Error(
      `Blocked: cannot write mirror twin for "${node.id}" — live file missing at ${livePath}.`
    );
  }
  const liveRaw = fs.readFileSync(livePath, "utf-8");
  const match = liveRaw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!match) {
    throw new Error(
      `Blocked: live file for "${node.id}" has no YAML frontmatter; cannot write mirror twin.`
    );
  }
  const nl = match[1].endsWith("\r\n") ? "\r\n" : "\n";
  let inner = match[2];
  if (/^state:\s*/m.test(inner)) {
    inner = inner.replace(/^state:\s*.*$/m, `state: ${MIRROR_STATE}`);
  } else {
    inner = `state: ${MIRROR_STATE}${nl}${inner}`;
  }
  const twin = `${match[1]}${inner}${match[3]}${liveRaw.slice(match[0].length)}`;
  ensureEntityDir(node);
  const nextPath = markdownPath(node, "next");
  if (fs.existsSync(nextPath) && !fs.statSync(nextPath).isFile()) {
    throw new Error(
      `Blocked: cannot write mirror twin for "${node.id}" — ${path.basename(nextPath)} exists and is not a file.`
    );
  }
  fs.writeFileSync(nextPath, twin, "utf-8");
  return markdownRelativePath(node, "next");
}

/** Delete the standing twin / next file and next-attachments/ (retire, force_unship). */
export function deleteNextSlotFiles(node: Pick<MindPlanNode, "id" | "type">): string[] {
  const removed: string[] = [];
  const nextFile = markdownPath(node, "next");
  if (fs.existsSync(nextFile)) {
    fs.unlinkSync(nextFile);
    removed.push(markdownRelativePath(node, "next"));
  }
  const nextAtt = nextAttachmentsDir(node);
  if (fs.existsSync(nextAtt)) {
    const dirRel = `${entityRelativePath(node)}/${NEXT_ATTACHMENTS_DIR}`;
    // List every file the removal deletes (e.g. `.gitkeep`), not only the folder.
    const walk = (abs: string, rel: string): void => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(abs, entry.name), childRel);
        else removed.push(childRel);
      }
    };
    walk(nextAtt, dirRel);
    fs.rmSync(nextAtt, { recursive: true, force: true });
    removed.push(dirRel);
  }
  return removed;
}

/**
 * After a live-slot write on a shipped node with no open evolution, refresh the mirror twin.
 * No-op when the node is not shipped, has an open evolution, or is not a pipeline type.
 */
export function syncMirrorAfterLiveWrite(node: MindPlanNode): string | null {
  if (!isPipelineNodeType(node.type)) return null;
  if (!isProductionState(node.state)) return null;
  if (node.next) return null;
  return writeMirrorTwin(node);
}

/**
 * Compare live vs next file ignoring only the `state:` line.
 * Returns null when they match as a state-only twin; otherwise a short reason.
 */
export function mirrorDriftReason(node: Pick<MindPlanNode, "id" | "type">): string | null {
  const livePath = markdownPath(node, "current");
  const nextPath = markdownPath(node, "next");
  if (!fs.existsSync(nextPath)) {
    return `missing ${path.basename(nextPath)} mirror twin`;
  }
  const nextState = readNextFileState(node);
  if (!nextState || !isMirrorState(nextState)) {
    return `${path.basename(nextPath)} is not state: ${MIRROR_STATE} (got "${nextState ?? ""}")`;
  }
  const liveRaw = fs.readFileSync(livePath, "utf-8");
  const nextRaw = fs.readFileSync(nextPath, "utf-8");
  const stripState = (raw: string) =>
    raw.replace(/^state:\s*.*$/m, "state: <ignored>");
  if (stripState(liveRaw) !== stripState(nextRaw)) {
    return `${path.basename(nextPath)} drifted from live (expected state-only twin)`;
  }
  return null;
}

/** Lists filenames in the entity's attachments/ folder (non-recursive). */
export function listAttachments(node: Pick<MindPlanNode, "id" | "type">): string[] {
  const dir = attachmentsDir(node);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== ".gitkeep")
    .map((e) => e.name)
    .sort();
}

export function projectRoot(): string {
  return process.env.MINDPLAN_ROOT ?? process.cwd();
}

/** Creates /mindplan, top-level type directories, and components/ if missing. */
export function ensureDirectories(): void {
  fs.mkdirSync(mindplanRoot(), { recursive: true });
  for (const dir of Object.values(TYPE_DIRS)) {
    fs.mkdirSync(path.join(mindplanRoot(), dir), { recursive: true });
  }
  const componentsDir = path.join(mindplanRoot(), COMPONENTS_DIR);
  fs.mkdirSync(componentsDir, { recursive: true });
  const keep = path.join(componentsDir, ".gitkeep");
  if (!fs.existsSync(keep)) {
    fs.writeFileSync(keep, "", "utf-8");
  }
}

function ensureEntityDir(node: Pick<MindPlanNode, "id" | "type">): void {
  ensureDirectories();
  fs.mkdirSync(entityDir(node), { recursive: true });
  fs.mkdirSync(attachmentsDir(node), { recursive: true });
}

export type ParsedFrontmatter = {
  scalars: Record<string, string>;
  arrays: Record<EdgeField, string[]>;
  implements: string[];
  /** Claim entries a shipped node added in place, still awaiting a body mention. */
  added_claims: string[];
};

function isEdgeField(key: string): key is EdgeField {
  return (EDGE_FIELDS as readonly string[]).includes(key);
}

function isListField(key: string): key is ListField {
  return (LIST_FIELDS as readonly string[]).includes(key);
}

/** Parses YAML frontmatter scalars and MCP edge / implements array fields. */
export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const scalars: Record<string, string> = {};
  const arrays: Record<EdgeField, string[]> = {
    belongs_to: [],
    depends_on: [],
    exposes: [],
    leads_to: [],
    affects: [],
    mounts: [],
  };
  let implementsList: string[] = [];
  let addedClaims: string[] = [];

  const lines = match[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const keyOnly = line.match(/^([\w]+):\s*$/);
    if (keyOnly && isListField(keyOnly[1])) {
      const field = keyOnly[1];
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s+-\s+/, "").trim());
        i++;
      }
      if (field === "implements") implementsList = items;
      else if (field === "added_claims") addedClaims = items;
      else arrays[field] = items;
      continue;
    }

    const inlineArray = line.match(/^([\w]+):\s*\[(.*)\]\s*$/);
    if (inlineArray && isListField(inlineArray[1])) {
      const field = inlineArray[1];
      const inner = inlineArray[2].trim();
      const items = inner
        ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : [];
      if (field === "implements") implementsList = items;
      else if (field === "added_claims") addedClaims = items;
      else arrays[field] = items;
      i++;
      continue;
    }

    const scalar = line.match(/^([\w]+):\s*(.*)$/);
    if (scalar) {
      let val = scalar[2].trim();
      if (val.startsWith('"')) {
        try {
          val = JSON.parse(val) as string;
        } catch {
          /* use raw */
        }
      }
      scalars[scalar[1]] = val;
    }
    i++;
  }

  return { scalars, arrays, implements: implementsList, added_claims: addedClaims };
}

function stripListFieldLines(inner: string): string {
  const lines = inner.split(/\r?\n/);
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^(belongs_to|depends_on|exposes|leads_to|affects|mounts|implements):/.test(lines[i])) {
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) i++;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n").replace(/\n+$/, "");
}

function formatEdgeFieldLines(arrays: Partial<Record<EdgeField, string[]>>): string {
  const parts: string[] = [];
  for (const field of EDGE_FIELDS) {
    const ids = arrays[field];
    if (!ids || ids.length === 0) continue;
    parts.push(`${field}:`);
    for (const id of ids) parts.push(`  - ${id}`);
  }
  return parts.join("\n");
}

function formatImplementsLines(entries: string[]): string {
  if (entries.length === 0) return "";
  const parts = ["implements:"];
  for (const e of entries) parts.push(`  - ${e}`);
  return parts.join("\n");
}

function stripAddedClaimsLines(inner: string): string {
  const lines = inner.split(/\r?\n/);
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^added_claims:/.test(lines[i])) {
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) i++;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n").replace(/\n+$/, "");
}

function formatAddedClaimsLines(entries: string[]): string {
  if (entries.length === 0) return "";
  return ["added_claims:", ...entries.map((e) => `  - ${e}`)].join("\n");
}

/**
 * The in-place claim markers still awaiting review: deduped and sorted, keeping only entries the
 * claim list still holds (verbatim, or a file under a non-glob directory entry) and the body
 * (owned sections excluded) does not yet name verbatim.
 */
function pendingAddedClaims(entries: string[], claims: string[], body: string): string[] {
  const text = withoutOwnedSections(body);
  const kept = new Set<string>();
  for (const e of entries) {
    const claimed = claims.some(
      (c) => c === e || (c.endsWith("/") && !isGlobClaim(c) && claimCoversPath(c, e))
    );
    if (claimed && !text.includes(e)) kept.add(e);
  }
  return [...kept].sort((a, b) => a.localeCompare(b));
}

/** Rewrites the `added_claims` list in a `---` fenced frontmatter block (removed when empty). */
function replaceAddedClaimsInFence(fence: string, entries: string[]): string {
  const match = fence.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)$/);
  if (!match) return fence;
  const nl = match[1].endsWith("\r\n") ? "\r\n" : "\n";
  const inner = stripAddedClaimsLines(match[2]);
  const lines = formatAddedClaimsLines(entries);
  const rebuilt = lines ? `${inner}\n${lines}` : inner;
  return `${match[1]}${rebuilt.replace(/\r?\n/g, nl)}${match[3]}`;
}

function stripEdgeFieldLines(inner: string): string {
  return stripListFieldLines(inner);
}

function parseNodeFromFrontmatter(
  folderId: string,
  expectedType: NodeType,
  contextFile: string
): MindPlanNode {
  const raw = fs.readFileSync(contextFile, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `Blocked: current file for "${folderId}" has no YAML frontmatter (expected at ${contextFile}).`
    );
  }
  const fm = parsed.scalars;
  const id = fm.id ?? folderId;
  const type = fm.type as NodeType;
  if (id !== folderId) {
    throw new Error(
      `Blocked: folder "${folderId}" does not match frontmatter id "${id}" in ${contextFile}.`
    );
  }
  if (!NODE_TYPES.includes(type)) {
    throw new Error(`Blocked: invalid type "${fm.type}" in ${contextFile}.`);
  }
  if (type !== expectedType) {
    throw new Error(
      `Blocked: frontmatter type "${type}" does not match directory type "${expectedType}" for "${folderId}".`
    );
  }
  if (!fm.state || !fm.created_at || !fm.updated_at) {
    throw new Error(
      `Blocked: current frontmatter for "${folderId}" must include state, created_at, and updated_at.`
    );
  }
  const node: MindPlanNode = {
    id,
    type,
    title: fm.title ?? "",
    description: fm.description ?? "",
    state: fm.state as MindPlanNode["state"],
    created_at: fm.created_at,
    updated_at: fm.updated_at,
  };
  const ownRules = splitNodeRules(raw).rules;
  if (ownRules) node.rules = ownRules;
  const ownDecisions = parseDecisions(splitNodeDecisions(raw).section);
  if (ownDecisions.length > 0) node.decisions = ownDecisions;
  if (fm.shipped_at) node.shipped_at = fm.shipped_at;
  if (fm.change) node.change = fm.change;
  if (fm.change_ref) node.change_ref = fm.change_ref;
  if (fm.severity && (BUG_SEVERITIES as readonly string[]).includes(fm.severity)) {
    node.severity = fm.severity as BugSeverity;
  }
  if (parsed.arrays.belongs_to.length > 0) node.belongs_to = [...parsed.arrays.belongs_to];
  if (parsed.arrays.depends_on.length > 0) node.depends_on = [...parsed.arrays.depends_on];
  if (parsed.arrays.exposes.length > 0) node.exposes = [...parsed.arrays.exposes];
  if (parsed.arrays.leads_to.length > 0) node.leads_to = [...parsed.arrays.leads_to];
  if (parsed.arrays.mounts.length > 0) node.mounts = [...parsed.arrays.mounts];
  if (parsed.arrays.affects.length > 0) node.affects = [...parsed.arrays.affects];
  if (parsed.implements.length > 0) node.implements = [...parsed.implements];
  if (parsed.added_claims.length > 0) node.added_claims = [...parsed.added_claims];
  if (fm.role) {
    if (!isFoundationRole(fm.role)) {
      throw new Error(
        `Blocked: invalid Foundation role "${fm.role}" in ${contextFile}. ` +
          `Allowed: assembler, infra, design-system, adapter.`
      );
    }
    node.role = fm.role;
  }
  return node;
}

/**
 * Parse an open-evolution next slot. Returns null when the file is a standing `mirror` twin
 * (not an evolution). Throws on missing required fields or illegal states.
 */
function parseNextSlot(folderId: string, nextFile: string): NextSlot | null {
  const raw = fs.readFileSync(nextFile, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `Blocked: next file for "${folderId}" has no YAML frontmatter (expected at ${nextFile}).`
    );
  }
  const fm = parsed.scalars;
  if (!fm.state || !fm.updated_at) {
    throw new Error(
      `Blocked: next frontmatter for "${folderId}" must include state and updated_at.`
    );
  }
  if (isMirrorState(fm.state)) {
    return null;
  }
  if (!isNextPipelineState(fm.state)) {
    throw new Error(
      `Blocked: ${path.basename(nextFile)} for "${folderId}" has invalid next state "${fm.state}". ` +
        `Allowed: ${MIRROR_STATE}, draft, ready, in-progress, in-review.`
    );
  }
  const slot: NextSlot = {
    state: fm.state as NextPipelineState,
    title: fm.title ?? "",
    description: fm.description ?? "",
    updated_at: fm.updated_at,
  };
  if (fm.change) slot.change = fm.change;
  if (fm.change_ref) slot.change_ref = fm.change_ref;
  if (fm.opened_at) slot.opened_at = fm.opened_at;
  const nextDecisions = parseDecisions(splitNodeDecisions(raw).section);
  if (nextDecisions.length > 0) slot.decisions = nextDecisions;
  if (parsed.arrays.belongs_to.length > 0) slot.belongs_to = [...parsed.arrays.belongs_to];
  if (parsed.arrays.depends_on.length > 0) slot.depends_on = [...parsed.arrays.depends_on];
  if (parsed.arrays.exposes.length > 0) slot.exposes = [...parsed.arrays.exposes];
  if (parsed.arrays.leads_to.length > 0) slot.leads_to = [...parsed.arrays.leads_to];
  if (parsed.arrays.mounts.length > 0) slot.mounts = [...parsed.arrays.mounts];
  if (parsed.implements.length > 0) slot.implements = [...parsed.implements];
  if (fm.role) {
    if (!isFoundationRole(fm.role)) {
      throw new Error(
        `Blocked: invalid Foundation role "${fm.role}" in ${path.basename(nextFile)} for "${folderId}". ` +
          `Allowed: assembler, infra, design-system, adapter.`
      );
    }
    slot.role = fm.role;
  }
  return slot;
}

/** Scans territory folders and assembles nodes from <id>.mdx (+ optional <id>.next.mdx). */
export function discoverNodes(): MindPlanNode[] {
  const nodes: MindPlanNode[] = [];
  const root = mindplanRoot();
  if (!fs.existsSync(root)) return nodes;

  for (const [dirName, nodeType] of Object.entries(DIR_TO_TYPE)) {
    const typePath = path.join(root, dirName);
    if (!fs.existsSync(typePath)) continue;
    for (const entry of fs.readdirSync(typePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(typePath, entry.name);
      const folderRel = path.posix.join(MINDPLAN_DIR, dirName, entry.name);
      const currentFile = existingSlotFile(folder, entry.name, "current", folderRel);
      if (!currentFile) continue;
      const node = parseNodeFromFrontmatter(entry.name, nodeType, currentFile);
      const nextFile = existingSlotFile(folder, entry.name, "next", folderRel);
      if (nextFile) {
        // Non-file next paths (e.g. a directory occupying the twin name) are not evolutions;
        // leave node.next unset so init can report a skip when healing fails.
        if (fs.statSync(nextFile).isFile()) {
          if (!isPipelineNodeType(nodeType)) {
            throw new Error(
              `Blocked: ${path.basename(nextFile)} is only allowed for Foundations, Interactions, and Interfaces (found on ${nodeType} "${entry.name}").`
            );
          }
          const evolution = parseNextSlot(entry.name, nextFile);
          if (evolution) node.next = evolution;
        }
      }
      nodes.push(node);
    }
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands outgoing edge arrays on nodes into flat edge triples (live/current edges only). */
export function discoverEdges(nodes: MindPlanNode[]): MindPlanEdge[] {
  const edges: MindPlanEdge[] = [];
  for (const node of nodes) {
    if (node.belongs_to) {
      for (const target of node.belongs_to) {
        edges.push({ source: node.id, target, type: "belongs_to" });
      }
    }
    if (node.depends_on) {
      for (const target of node.depends_on) {
        edges.push({ source: node.id, target, type: "depends_on" });
      }
    }
    if (node.exposes) {
      for (const target of node.exposes) {
        edges.push({ source: node.id, target, type: "exposes" });
      }
    }
    if (node.leads_to) {
      for (const target of node.leads_to) {
        edges.push({ source: node.id, target, type: "leads_to" });
      }
    }
    if (node.mounts) {
      for (const target of node.mounts) {
        edges.push({ source: node.id, target, type: "mounts" });
      }
    }
    if (node.affects) {
      for (const target of node.affects) {
        edges.push({ source: node.id, target, type: "affects" });
      }
    }
  }
  return edges.sort((a, b) => {
    const ka = `${a.source}:${a.type}:${a.target}`;
    const kb = `${b.source}:${b.type}:${b.target}`;
    return ka.localeCompare(kb);
  });
}

export function loadGraph(): MindPlanGraph {
  const nodes = discoverNodes();
  return { version: GRAPH_VERSION, nodes, edges: discoverEdges(nodes) };
}

/** Returns { id, type } if a territory folder exists for this id. */
export function findNodeRef(id: string): Pick<MindPlanNode, "id" | "type"> {
  for (const [dirName, nodeType] of Object.entries(DIR_TO_TYPE)) {
    const folder = path.join(mindplanRoot(), dirName, id);
    const currentFile = existingSlotFile(
      folder,
      id,
      "current",
      path.posix.join(MINDPLAN_DIR, dirName, id)
    );
    if (currentFile) {
      return { id, type: nodeType };
    }
  }
  throw new Error(`Blocked: node "${id}" does not exist in mindplan territory.`);
}

export function nodeExists(id: string): boolean {
  for (const dirName of Object.values(TYPE_DIRS)) {
    const folder = path.join(mindplanRoot(), dirName, id);
    if (
      existingSlotFile(folder, id, "current", path.posix.join(MINDPLAN_DIR, dirName, id))
    ) {
      return true;
    }
  }
  return false;
}

export function readMarkdown(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  const file = markdownPath(node, slot);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Blocked: ${slot} file not found for node "${node.id}" (expected at ${file}).`
    );
  }
  return fs.readFileSync(file, "utf-8");
}

export function writeMarkdown(
  node: Pick<MindPlanNode, "id" | "type">,
  content: string,
  slot: TerritorySlot = "current"
): void {
  ensureEntityDir(node);
  const file = markdownPath(node, slot);
  if (slot === "next" && fs.existsSync(file)) {
    const state = readNextFileState(node);
    if (state && isMirrorState(state)) {
      throw new Error(
        `Blocked: cannot write "${node.id}" next while it is a ${MIRROR_STATE} twin. ` +
          `Change the live file via MCP, or call open_next first.`
      );
    }
  }
  fs.writeFileSync(file, content, "utf-8");
}

/** Requires a territory MDX file with parseable YAML frontmatter for mutations. */
function requireMutableFrontmatter(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot
): { file: string; raw: string; fence: string; inner: string } {
  const file = markdownPath(node, slot);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Blocked: ${slot} file not found for node "${node.id}" (expected at ${file}).`
    );
  }
  const raw = fs.readFileSync(file, "utf-8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(
      `Blocked: ${slot} file for "${node.id}" has no YAML frontmatter; cannot mutate graph state.`
    );
  }
  return { file, raw, fence: match[0], inner: match[1] };
}

/**
 * Patches server-owned state fields in `<id>.mdx` or `<id>.next.mdx` frontmatter.
 * Returns the mirror twin path when a live write on a shipped node re-synced it, else null.
 */
export function patchFrontmatter(
  node: Pick<MindPlanNode, "id" | "type" | "state" | "updated_at" | "shipped_at">,
  slot: TerritorySlot = "current",
  opts?: { clearShippedAt?: boolean }
): string | null {
  const { file, raw, fence } = requireMutableFrontmatter(node, slot);

  let patched = fence
    .replace(/^state:.*$/m, `state: ${node.state}`)
    .replace(/^updated_at:.*$/m, `updated_at: ${node.updated_at}`);

  if (slot === "current") {
    if (opts?.clearShippedAt) {
      patched = patched.replace(/\r?\nshipped_at:.*$/m, "");
    } else if (node.shipped_at) {
      if (/^shipped_at:/m.test(patched)) {
        patched = patched.replace(/^shipped_at:.*$/m, `shipped_at: ${node.shipped_at}`);
      } else {
        patched = patched.replace(/^(state:.*)$/m, `$1\nshipped_at: ${node.shipped_at}`);
      }
    }
  }

  if (patched !== fence) {
    fs.writeFileSync(file, raw.replace(fence, patched), "utf-8");
  }
  if (slot === "current" && "state" in node && isProductionState(String(node.state))) {
    const full = node as MindPlanNode;
    if (isPipelineNodeType(full.type) && !full.next) {
      return writeMirrorTwin(node);
    }
  }
  return null;
}

/** Patches MCP-owned outgoing edge arrays in `<id>.mdx` or `<id>.next.mdx` frontmatter. */
export function patchFrontmatterEdges(
  node: Pick<MindPlanNode, "id" | "type">,
  edges: Partial<Record<EdgeField, string[]>>,
  updated_at: string,
  slot: TerritorySlot = "current"
): void {
  const { file, raw, fence, inner: rawInner } = requireMutableFrontmatter(node, slot);

  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `Blocked: ${slot} file for "${node.id}" has unreadable YAML frontmatter; cannot mutate edges.`
    );
  }

  const merged: Record<EdgeField, string[]> = {
    belongs_to: edges.belongs_to ?? parsed.arrays.belongs_to,
    depends_on: edges.depends_on ?? parsed.arrays.depends_on,
    exposes: edges.exposes ?? parsed.arrays.exposes,
    leads_to: edges.leads_to ?? parsed.arrays.leads_to,
    affects: edges.affects ?? parsed.arrays.affects,
    mounts: edges.mounts ?? parsed.arrays.mounts,
  };

  let inner = stripEdgeFieldLines(rawInner);
  inner = inner.replace(/^updated_at:.*$/m, `updated_at: ${updated_at}`);

  const edgeLines = formatEdgeFieldLines(merged);
  const implLines = formatImplementsLines(parsed.implements);
  const extras = [edgeLines, implLines].filter(Boolean).join("\n");
  const rebuiltInner = extras ? `${inner}\n${extras}` : inner;
  const rebuilt = `---\n${rebuiltInner}\n---`;
  fs.writeFileSync(file, raw.replace(fence, rebuilt), "utf-8");
}

/** Resolves which territory slot receives edge mutations for pipeline nodes. */
export function edgeWriteSlot(node: MindPlanNode, edgeType: EdgeType): TerritorySlot {
  if (
    node.next &&
    isPipelineNodeType(node.type) &&
    (edgeType === "belongs_to" ||
      edgeType === "depends_on" ||
      edgeType === "exposes" ||
      edgeType === "leads_to" ||
      edgeType === "mounts")
  ) {
    return "next";
  }
  return "current";
}

/**
 * What a contract write to one node's frontmatter reports: whether it sent a `ready` slot back to
 * `draft`, and the mirror twin path it re-synced after a live write on a shipped node (else null).
 */
export type FrontmatterWrite = { readinessReset: boolean; twin: string | null };

/** Appends a target id to the source node's outgoing edge array for edge_type. */
export function addEdgeToFrontmatter(
  node: MindPlanNode,
  edgeType: EdgeType,
  targetId: string
): FrontmatterWrite {
  const slot = edgeWriteSlot(node, edgeType);
  const raw = readMarkdown(node, slot);
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `Blocked: ${slot} file for "${node.id}" has unreadable YAML frontmatter; cannot add ${edgeType} edge.`
    );
  }

  const field = edgeType as EdgeField;
  const current = [...parsed.arrays[field]];
  if (!current.includes(targetId)) current.push(targetId);
  const now = new Date().toISOString();
  patchFrontmatterEdges(node, { [field]: current }, now, slot);
  const twin = slot === "current" ? syncMirrorAfterLiveWrite(node) : null;
  return { readinessReset: demoteReadySlot(node, slot), twin };
}

/** Removes target_id from all outgoing edge arrays on the source node (current and open evolution). */
export function removeEdgesFromFrontmatter(
  node: MindPlanNode,
  targetId: string
): FrontmatterWrite {
  const now = new Date().toISOString();
  let twin: string | null = null;
  for (const slot of ["current", "next"] as const) {
    // Mirror twins are not evolutions — only patch next when node.next is set.
    if (slot === "next" && !node.next) continue;
    const raw = readMarkdown(node, slot);
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      throw new Error(
        `Blocked: ${slot} file for "${node.id}" has unreadable YAML frontmatter; cannot remove edges.`
      );
    }
    patchFrontmatterEdges(
      node,
      {
        belongs_to: parsed.arrays.belongs_to.filter((id) => id !== targetId),
        depends_on: parsed.arrays.depends_on.filter((id) => id !== targetId),
        exposes: parsed.arrays.exposes.filter((id) => id !== targetId),
        leads_to: parsed.arrays.leads_to.filter((id) => id !== targetId),
        affects: parsed.arrays.affects.filter((id) => id !== targetId),
        mounts: parsed.arrays.mounts.filter((id) => id !== targetId),
      },
      now,
      slot
    );
    if (slot === "current") twin = syncMirrorAfterLiveWrite(node);
  }
  return { readinessReset: demoteReadySlot(node, node.next ? "next" : "current"), twin };
}

/** Scaffolds an entity folder: `<id>.mdx` + empty attachments/ directory. */
export function scaffoldEntity(
  node: Pick<MindPlanNode, "id" | "type" | "state" | "created_at" | "updated_at" | "role">,
  meta: Pick<MindPlanNode, "title" | "description">
): void {
  // Validate project config before any FS writes so invalid config cannot leave a partial node.
  loadProjectConfig();

  ensureEntityDir(node);
  const attachmentsKeep = path.join(attachmentsDir(node), ".gitkeep");
  if (!fs.existsSync(attachmentsKeep)) {
    fs.writeFileSync(attachmentsKeep, "", "utf-8");
  }

  const frontmatterLines = [
    "---",
    `id: ${node.id}`,
    `type: ${node.type}`,
    `title: ${JSON.stringify(meta.title)}`,
    `description: ${JSON.stringify(meta.description)}`,
    `state: ${node.state}`,
    `created_at: ${node.created_at}`,
    `updated_at: ${node.updated_at}`,
  ];
  if (node.type === "Foundation" && node.role) {
    frontmatterLines.push(`role: ${node.role}`);
  }
  frontmatterLines.push("---");
  const frontmatter = frontmatterLines.join("\n");

  let body: string;
  switch (node.type) {
    case "Journey":
      body = [
        `# ${meta.title}`,
        "",
        meta.description,
        "",
        "## Overview",
        "",
        "_Name the domain capability this Journey owns and which use cases belong inside it. Journey titles alone should scream the product purpose — not the tech stack._",
        "",
        "## Linked Interactions",
        "",
        "_Interactions link here via `belongs_to` in their frontmatter. The Journey state is computed automatically from member Interactions._",
        "",
        "## Attachments",
        "",
        `_Place supporting files in \`attachments/\` alongside this file. Reference them with relative links, e.g. \`![diagram](attachments/diagram.png)\`._`,
        "",
        "{/* This file is MDX. MindPlan standard components (AtomicOp, AcceptanceCriteria, Attachment, StateBadge, DependsOn, BelongsTo) may be used here; see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
    case "Foundation":
      body = [
        `# ${meta.title}`,
        "",
        meta.description,
        "",
        "## Purpose",
        "",
        "_Name the purpose of this Foundation — what shared substrate it owns and why other nodes depend on it._",
        "",
        "## Shared Substrate Spec",
        "",
        "_Role belongs in frontmatter `role` / `description` at create time (assembler / infra / design-system / adapter). Document shared substrate here: schemas, adapters, design system, contracts. MUST NOT own stakeholder-recognizable Interaction behaviour — that belongs in Interactions. Declare owned files with `set_implementation_files` (not prescribed `src/foundations/<id>/`)._",
        "",
        "## Acceptance Criteria",
        "",
        "_Checkable outcomes for this Foundation._",
        "",
        "## Atomic Ops",
        "",
        "- [ ] Spec written",
        "- [ ] Implementation complete",
        "- [ ] Verified in target environment",
        "",
        "## Attachments",
        "",
        `_Schemas, OpenAPI exports, ER diagrams, design tokens, etc. go in \`attachments/\`._`,
        "",
        "{/* This file is MDX. MindPlan standard components (AtomicOp, AcceptanceCriteria, Attachment, StateBadge, DependsOn, BelongsTo) may be used here; see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
    case "Interaction":
      body = [
        `# ${meta.title}`,
        "",
        meta.description,
        "",
        "## Purpose",
        "",
        "_Self-contained unit of behavior initiated by an actor (user, system, scheduler, external service, CLI/MCP/API caller). Not a screen, button, or endpoint — Interfaces expose this Interaction._",
        "",
        "## Actor & Trigger",
        "",
        "_Who initiates this Interaction and how (user action, cron, webhook, MCP tool call, …)._",
        "",
        "## Inputs & Outputs",
        "",
        "_Inputs consumed and outputs produced. Shared application state belongs in Foundations — Interactions must not depend_on other Interactions._",
        "",
        "## PRD / Execution Logic",
        "",
        "_Describe the behavior step by step. Declare owned files with `set_implementation_files` (not prescribed `src/interactions/<id>/`). Before inventing shared UI, depend on a Foundation (e.g. design system)._",
        "",
        "## Acceptance Criteria",
        "",
        "_Checkable outcomes for this Interaction._",
        "",
        "## Atomic Ops",
        "",
        "- [ ] Requirements defined",
        "- [ ] Implementation complete",
        "- [ ] Tests passing",
        "",
        "## Attachments",
        "",
        `_Wireframes, screenshots, and spec PDFs go in \`attachments/\`._`,
        "",
        "{/* This file is MDX. MindPlan standard components (AtomicOp, AcceptanceCriteria, Attachment, StateBadge, DependsOn, BelongsTo) may be used here; see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
    case "Interface":
      body = [
        `# ${meta.title}`,
        "",
        meta.description,
        "",
        "## Purpose",
        "",
        "_Name the purpose of this Interface — which actor surface it is and which Interactions it mounts or wires._",
        "",
        "## Kind",
        "",
        "_How an actor enters or accesses Interactions: Page, Dialog, CLI command, MCP tool, REST endpoint, Webhook, Cron, Message queue consumer, …_",
        "",
        "## Exposed Interactions",
        "",
        "_List Interactions this Interface exposes (also link via `exposes` edges). An Interface must not contain core Interaction behavior._",
        "",
        "## Spec",
        "",
        "_Presentation/transport/exposure only. Declare owned files with `set_implementation_files` (not prescribed `src/interfaces/<id>/`). Connect to Foundations as needed via `depends_on`._",
        "",
        "## Acceptance Criteria",
        "",
        "_Checkable outcomes for this Interface._",
        "",
        "## Atomic Ops",
        "",
        "- [ ] Spec written",
        "- [ ] Implementation complete",
        "- [ ] Verified against exposed Interactions",
        "",
        "## Attachments",
        "",
        `_Wireframes, OpenAPI snippets, CLI help dumps go in \`attachments/\`._`,
        "",
        "{/* This file is MDX. MindPlan standard components (AtomicOp, AcceptanceCriteria, Attachment, StateBadge, DependsOn, BelongsTo) may be used here; see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
    case "Bug":
      body = [
        `# ${meta.title}`,
        "",
        meta.description,
        "",
        "## Summary",
        "",
        "_One-line description of the defect._",
        "",
        "## Repro Steps",
        "",
        "1. _Step one_",
        "2. _Step two_",
        "",
        "## Expected / Actual",
        "",
        "**Expected:** _What should happen_",
        "",
        "**Actual:** _What happens instead_",
        "",
        "## Fix Checklist",
        "",
        "- [ ] Root cause identified",
        "- [ ] Fix implemented",
        "- [ ] Regression test added",
        "",
        "## Attachments",
        "",
        `_Logs, screenshots, and HAR files go in \`attachments/\`._`,
        "",
        "{/* MDX: Affects, ReproSteps, Severity, ExpectedActual — see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
  }

  writeMarkdown(node, `${frontmatter}\n\n${body}`, "current");
}

/**
 * Completion Check helper: returns the number of unchecked `[ ]` checkboxes
 * in `<id>.mdx` or `<id>.next.mdx`. Markdown checkboxes are `- [ ]` / `- [x]` list items.
 */
export function countUncheckedBoxes(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): number {
  return countCheckboxesInText(readMarkdown(node, slot)).unchecked;
}

/** Treat lone CR (open_next copies) and CRLF as line breaks. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Counts markdown task-list checkboxes in a territory body or full MDX string. */
export function countCheckboxesInText(text: string): {
  unchecked: number;
  checked: number;
} {
  const normalized = withoutOwnedSections(normalizeNewlines(text));
  // A not-applicable tick with no reason is not done.
  const emptyNa = normalized.match(/^[ \t]*[-*+][ \t]+\[[xX]\].*[ \t]—[ \t]+n\/a:[ \t]*$/gm)?.length ?? 0;
  const unchecked = (normalized.match(/^\s*[-*+]\s+\[ \]/gm)?.length ?? 0) + emptyNa;
  const checked = (normalized.match(/^\s*[-*+]\s+\[[xX]\]/gm)?.length ?? 0) - emptyNa;
  return { unchecked, checked };
}

/** True when there is at least one checkbox and none remain unchecked. */
export function isChecklistComplete(text: string): boolean {
  const { unchecked, checked } = countCheckboxesInText(text);
  return checked > 0 && unchecked === 0;
}

/** Sorted task-list labels, ignoring checked state. */
export function checkboxLabels(text: string): string[] {
  const labels: string[] = [];
  for (const line of withoutOwnedSections(normalizeNewlines(text)).split("\n")) {
    const match = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.*)$/);
    if (match) labels.push(match[1].replace(/\s+—\s+(?:note|n\/a):.*$/, "").trim());
  }
  labels.sort();
  return labels;
}

const NODE_RULES_HEADING = "## Rules";
const NODE_RULES_HEADING_LINE = /^## Rules[ \t]*$/;
const SECTION_BREAK_LINE = /^#{1,2}[ \t]/;
const ATTACHMENTS_HEADING_LINE = /^## Attachments[ \t]*$/;

/**
 * Splits a territory body (or full MDX) into the body without the node `## Rules` section and the
 * section's trimmed text. The section runs from a `## Rules` line to the next level-1/2 heading or EOF.
 * Only the first section is read.
 */
export function splitNodeRules(text: string): { body: string; rules: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => NODE_RULES_HEADING_LINE.test(line.replace(/\r$/, "")));
  if (start === -1) return { body: text, rules: "" };
  let end = start + 1;
  while (end < lines.length && !SECTION_BREAK_LINE.test(lines[end])) end++;
  const rules = lines
    .slice(start + 1, end)
    .join("\n")
    .replace(/\r/g, "")
    .trim();
  return { body: [...lines.slice(0, start), ...lines.slice(end)].join("\n"), rules };
}

/** True when `text` contains a `## Rules` heading line. */
export function hasNodeRulesHeading(text: string): boolean {
  return text.split("\n").some((line) => NODE_RULES_HEADING_LINE.test(line.replace(/\r$/, "")));
}

/**
 * Inserts the `## Rules` section before `## Attachments` (else at the end). Empty `rules` returns the
 * body unchanged. `body` must not already contain a Rules section.
 */
export function joinNodeRules(body: string, rules: string): string {
  const text = rules.replace(/\r\n/g, "\n").trim();
  if (!text) return body;
  const nl = body.includes("\r\n") ? "\r\n" : "\n";
  const section = `${NODE_RULES_HEADING}\n\n${text}\n`.replace(/\n/g, nl);
  const lines = body.split("\n");
  const at = lines.findIndex((line) => ATTACHMENTS_HEADING_LINE.test(line.replace(/\r$/, "")));
  if (at === -1) {
    return `${body.replace(/\s+$/, "")}${nl}${nl}${section}`;
  }
  const before = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const after = lines.slice(at).join("\n");
  return `${before}${nl}${nl}${section}${nl}${after}`;
}

/** Throws unless `rules` can live in a `## Rules` section (a level-1/2 heading would end it). */
function assertValidNodeRules(rules: string): void {
  for (const line of rules.split(/\r?\n/)) {
    if (SECTION_BREAK_LINE.test(line) || /^#{1,2}$/.test(line.trim())) {
      throw new Error(
        `Blocked: rules text contains a level-1 or level-2 heading ("${line.trim()}"). ` +
          `Use plain text, lists, or level-3+ headings inside rules.`
      );
    }
  }
}

/** The node's own rules read from a territory file. */
export function readNodeRules(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  return splitNodeRules(readMarkdown(node, slot)).rules;
}

/**
 * The only writer of a node's `## Rules` section. Writes the live file and, when an evolution is
 * open, the same text into the next file; otherwise refreshes the mirror twin. Frontmatter,
 * state, and edges are untouched. Returns the slots written and repo-relative paths.
 */
export function writeNodeRules(
  node: MindPlanNode,
  rules: string
): { slots: TerritorySlot[]; paths: string[] } {
  if (isInactiveNode(node)) {
    throw new Error(
      `Blocked: "${node.id}" is ${node.state}; node rules cannot be written on a retired or closed node.`
    );
  }
  assertValidNodeRules(rules);
  const text = rules.replace(/\r\n/g, "\n").trim();
  const slots: TerritorySlot[] = ["current"];
  if (node.next) slots.push("next");
  const paths: string[] = [];
  for (const slot of slots) {
    const raw = readMarkdown(node, slot);
    const match = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
    if (!match) {
      throw new Error(`Blocked: ${slot} file for "${node.id}" has no YAML frontmatter.`);
    }
    const stripped = splitNodeRules(match[2]).body;
    writeMarkdown(node, `${match[1]}${joinNodeRules(stripped, text)}`, slot);
    paths.push(markdownRelativePath(node, slot));
  }
  if (!node.next) {
    const twin = syncMirrorAfterLiveWrite(node);
    if (twin) paths.push(twin);
  }
  if (text) node.rules = text;
  else delete node.rules;
  return { slots, paths };
}

// ---------------------------------------------------------------------------
// Decisions section
// ---------------------------------------------------------------------------

const NODE_DECISIONS_HEADING = "## Decisions";
const NODE_DECISIONS_HEADING_LINE = /^## Decisions[ \t]*$/;

/**
 * A body with the Rules and Decisions sections removed: the editable body that checkbox counting,
 * labels, stale-text warnings, and node context read.
 */
export function withoutOwnedSections(text: string): string {
  return splitNodeDecisions(splitNodeRules(text).body).body;
}

/**
 * Splits a territory body (or full MDX) into the body without the `## Decisions` section and the
 * section's text (heading excluded, surrounding blank lines trimmed, CR removed). The section runs
 * from a `## Decisions` line to the next level-1/2 heading or EOF. Only the first section is read.
 */
export function splitNodeDecisions(text: string): { body: string; section: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => NODE_DECISIONS_HEADING_LINE.test(line.replace(/\r$/, "")));
  if (start === -1) return { body: text, section: "" };
  let end = start + 1;
  while (end < lines.length && !SECTION_BREAK_LINE.test(lines[end])) end++;
  const section = lines
    .slice(start + 1, end)
    .join("\n")
    .replace(/\r/g, "")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  return { body: [...lines.slice(0, start), ...lines.slice(end)].join("\n"), section };
}

/** True when `text` contains a `## Decisions` heading line. */
export function hasNodeDecisionsHeading(text: string): boolean {
  return text.split("\n").some((line) => NODE_DECISIONS_HEADING_LINE.test(line.replace(/\r$/, "")));
}

/**
 * Inserts the `## Decisions` section before `## Rules` when present, else before `## Attachments`,
 * else at the end, in the body's own line endings. An empty section returns the body unchanged.
 * `body` must not already contain a Decisions section.
 */
export function joinNodeDecisions(body: string, section: string): string {
  const text = section.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
  if (!text) return body;
  const nl = body.includes("\r\n") ? "\r\n" : "\n";
  const block = `${NODE_DECISIONS_HEADING}\n\n${text}\n`.replace(/\n/g, nl);
  const lines = body.split("\n");
  let at = lines.findIndex((line) => NODE_RULES_HEADING_LINE.test(line.replace(/\r$/, "")));
  if (at === -1) at = lines.findIndex((line) => ATTACHMENTS_HEADING_LINE.test(line.replace(/\r$/, "")));
  if (at === -1) return `${body.replace(/\s+$/, "")}${nl}${nl}${block}`;
  const before = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const after = lines.slice(at).join("\n");
  return `${before}${nl}${nl}${block}${nl}${after}`;
}

const DECISION_ENTRY_HEADING = /^###[ \t]+(\S+)[ \t]*$/;
const DECISION_FIELD_LINE = /^[-*][ \t]+([A-Za-z]+):[ \t]*(.*)$/;
const DECISION_ALTERNATIVE_LINE = /^[ \t]+[-*][ \t]+(.+)$/;

/**
 * Parses the `### <id>` entries of a Decisions section. Lines outside an entry, entries whose id
 * is not a decision id, and entries with no `Decision:` value are skipped.
 */
export function parseDecisions(section: string): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  let current: DecisionRecord | null = null;
  let inAlternatives = false;
  for (const raw of section.replace(/\r/g, "").split("\n")) {
    const heading = raw.match(DECISION_ENTRY_HEADING);
    if (heading) {
      if (current?.decision) out.push(current);
      inAlternatives = false;
      current = DECISION_ID_PATTERN.test(heading[1])
        ? { id: heading[1], decision: "", alternatives: [], why: "" }
        : null;
      continue;
    }
    if (!current) continue;
    const alternative = raw.match(DECISION_ALTERNATIVE_LINE);
    if (inAlternatives && alternative) {
      current.alternatives.push(alternative[1].trim());
      continue;
    }
    const field = raw.match(DECISION_FIELD_LINE);
    if (!field) {
      if (raw.trim()) inAlternatives = false;
      continue;
    }
    inAlternatives = false;
    const value = field[2].trim();
    switch (field[1].toLowerCase()) {
      case "decision":
        current.decision = value;
        break;
      case "alternatives":
        inAlternatives = true;
        if (value) current.alternatives.push(value);
        break;
      case "why":
        current.why = value;
        break;
      case "consequences":
        if (value) current.consequences = value;
        break;
      case "supersedes":
        if (value) current.supersedes = value;
        break;
      case "change":
        if (value) current.change = value;
        break;
      case "date":
        if (value) current.date = value;
        break;
    }
  }
  if (current?.decision) out.push(current);
  return out;
}

function oneLineValue(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** One `### <id>` entry with LF line endings and no trailing newline. */
export function formatDecisionEntry(record: DecisionRecord): string {
  const lines = [
    `### ${record.id}`,
    "",
    `- Decision: ${oneLineValue(record.decision)}`,
    "- Alternatives:",
    ...record.alternatives.map((a) => `  - ${oneLineValue(a)}`),
    `- Why: ${oneLineValue(record.why)}`,
  ];
  if (record.consequences) lines.push(`- Consequences: ${oneLineValue(record.consequences)}`);
  if (record.supersedes) lines.push(`- Supersedes: ${record.supersedes}`);
  if (record.change) lines.push(`- Change: ${record.change}`);
  if (record.date) lines.push(`- Date: ${record.date}`);
  return lines.join("\n");
}

/**
 * The only writer of the `## Decisions` section. Appends one entry to the active slot (the open
 * next file while a shipped node evolves, else the live file, then re-syncs the mirror twin).
 * Frontmatter, state, and readiness are untouched: a decision explains the contract, it does not
 * change it. Returns the slot and repo-relative paths written.
 */
export function appendDecision(
  node: MindPlanNode,
  record: DecisionRecord
): { slot: TerritorySlot; paths: string[] } {
  if (isInactiveNode(node)) {
    throw new Error(
      `Blocked: "${node.id}" is ${node.state}; decisions cannot be recorded on a retired or closed node.`
    );
  }
  const slot: TerritorySlot = node.next ? "next" : "current";
  const raw = readMarkdown(node, slot);
  const match = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) {
    throw new Error(`Blocked: ${slot} file for "${node.id}" has no YAML frontmatter.`);
  }
  const { body: withoutRules, rules } = splitNodeRules(match[2]);
  const { body, section } = splitNodeDecisions(withoutRules);
  const entry = formatDecisionEntry(record);
  const nextSection = section ? `${section}\n\n${entry}` : entry;
  // joinNodeDecisions writes the section in the body's own line endings.
  const written = joinNodeRules(joinNodeDecisions(body, nextSection), rules);
  writeMarkdown(node, `${match[1]}${written}`, slot);
  const paths = [markdownRelativePath(node, slot)];
  if (slot === "next" && node.next) {
    node.next.decisions = [...(node.next.decisions ?? []), record];
  } else {
    node.decisions = [...(node.decisions ?? []), record];
    const twin = syncMirrorAfterLiveWrite(node);
    if (twin) paths.push(twin);
  }
  return { slot, paths };
}

/**
 * Splits raw territory MDX into YAML frontmatter block, the newline after its closing `---`
 * (`separator`), and body. `frontmatter + separator + body` is the raw text, so writers that rebuild
 * a file keep its layout; the body keeps any blank lines that follow.
 */
export function splitContext(
  raw: string
): { frontmatter: string; separator: string; body: string } | null {
  const match = raw.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n?)([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1], separator: match[2], body: match[3] };
}

/** Compact node summary for blast-radius / reachability payloads. */
export function summarizeGraphNode(n: MindPlanNode): {
  id: string;
  type: MindPlanNode["type"];
  state: MindPlanNode["state"];
  title: string;
} {
  return { id: n.id, type: n.type, state: n.state, title: n.title };
}

/** Authoritative graph slice for MCP read responses (excludes raw frontmatter duplication). */
export function nodeToRecord(node: MindPlanNode): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    state: node.state,
    title: node.title,
    description: node.description,
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
  if (node.shipped_at) record.shipped_at = node.shipped_at;
  if (node.severity) record.severity = node.severity;
  if (node.role) record.role = node.role;
  if (node.belongs_to?.length) record.belongs_to = [...node.belongs_to];
  if (node.depends_on?.length) record.depends_on = [...node.depends_on];
  if (node.exposes?.length) record.exposes = [...node.exposes];
  if (node.leads_to?.length) record.leads_to = [...node.leads_to];
  if (node.mounts?.length) record.mounts = [...node.mounts];
  if (node.affects?.length) record.affects = [...node.affects];
  if (node.implements?.length) record.implements = [...node.implements];
  if (node.added_claims?.length) record.added_claims = [...node.added_claims];
  if (node.change) record.change = node.change;
  if (node.change_ref) record.change_ref = node.change_ref;
  if (node.next) {
    record.next = {
      state: node.next.state,
      title: node.next.title,
      description: node.next.description,
      updated_at: node.next.updated_at,
      ...(node.next.opened_at ? { opened_at: node.next.opened_at } : {}),
      ...(node.next.belongs_to?.length ? { belongs_to: [...node.next.belongs_to] } : {}),
      ...(node.next.depends_on?.length ? { depends_on: [...node.next.depends_on] } : {}),
      ...(node.next.exposes?.length ? { exposes: [...node.next.exposes] } : {}),
      ...(node.next.leads_to?.length ? { leads_to: [...node.next.leads_to] } : {}),
      ...(node.next.mounts?.length ? { mounts: [...node.next.mounts] } : {}),
      ...(node.next.implements?.length ? { implements: [...node.next.implements] } : {}),
      ...(node.next.role ? { role: node.next.role } : {}),
      ...(node.next.change ? { change: node.next.change } : {}),
      ...(node.next.change_ref ? { change_ref: node.next.change_ref } : {}),
    };
  }
  return record;
}

export type PatchNodeTerritoryInput = {
  title?: string;
  description?: string;
  body?: string;
  /** Foundation role — same slot rules as title/description. */
  role?: FoundationRole;
  toggle_checkboxes?: CheckboxToggle[];
  /** Set (or clear with "") the change id of this slot. Grouping metadata, not contract. */
  change?: string;
  /** Set (or clear with "") the branch or PR reference of this slot's change. */
  change_ref?: string;
  /** Replace the text under one `## heading` (heading line kept, other sections untouched). */
  section?: { heading: string; text: string };
  /** Replace one exact text occurrence in the body (`all` replaces every occurrence). */
  replace?: { find: string; with: string; all?: boolean };
  /** Override default slot selection. */
  slot?: TerritorySlot;
};

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeHeadingName(heading: string): string {
  return heading.replace(/^\s*##\s*/, "").trim();
}

/** Replaces the content under one level-2 heading; Blocked when the heading is missing. */
export function replaceSectionInBody(
  body: string,
  heading: string,
  text: string
): string {
  const name = normalizeHeadingName(heading);
  if (!name) throw new Error('Blocked: section requires a heading such as "## Purpose".');
  const eol = detectEol(body);
  const lines = body.split(/\r?\n/);
  const headings: { index: number; name: string }[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    // A '## ' line inside a fenced code block is code, not a heading.
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      if (fence === null) fence = f[1];
      else if (fence === f[1]) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) headings.push({ index, name: m[1] });
  });
  const hit = headings.find((h) => h.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    throw new Error(
      `Blocked: no "## ${name}" section in territory body. ` +
        `Sections: ${headings.map((h) => `"## ${h.name}"`).join(", ") || "(none)"}.`
    );
  }
  const nextHeading = headings.find((h) => h.index > hit.index);
  const end = nextHeading ? nextHeading.index : lines.length;
  const replacement = text.replace(/^(\r?\n)+/, "").replace(/(\r?\n)+$/, "").split(/\r?\n/);
  const out = [
    ...lines.slice(0, hit.index + 1),
    "",
    ...replacement,
    ...(nextHeading ? [""] : []),
    ...lines.slice(end),
    ...(nextHeading ? [] : [""]),
  ];
  return out.join(eol);
}

/** Replaces one exact occurrence of `find` in the body; Blocked on zero or ambiguous matches. */
export function replaceTextInBody(
  body: string,
  find: string,
  replacement: string,
  all = false
): string {
  if (!find) throw new Error("Blocked: replace.find must be non-empty.");
  const eol = detectEol(body);
  const normalizedFind = find.replace(/\r?\n/g, eol);
  const normalizedWith = replacement.replace(/\r?\n/g, eol);
  const parts = body.split(normalizedFind);
  const count = parts.length - 1;
  if (count === 0) {
    throw new Error(`Blocked: replace.find text not found in territory body: "${find.slice(0, 80)}".`);
  }
  if (count > 1 && !all) {
    throw new Error(
      `Blocked: replace.find matches ${count} places in territory body; make it unique or pass all: true.`
    );
  }
  return parts.join(normalizedWith);
}

/**
 * Default patch target: when a shipped Foundation/Interaction/Interface has `<id>.next.mdx`, patches go to next.
 * Otherwise current. Explicit `slot` overrides.
 */
export function resolveTerritorySlot(
  node: MindPlanNode,
  explicit?: TerritorySlot
): TerritorySlot {
  if (explicit) {
    if (explicit === "next" && !node.next) {
      throw new Error(
        `Blocked: node "${node.id}" has no open evolution (standing mirror twins are not writable; call open_next first).`
      );
    }
    return explicit;
  }
  if (
    node.next &&
    isPipelineNodeType(node.type) &&
    (node.state === "stable" || node.state === "unstable")
  ) {
    return "next";
  }
  return "current";
}

/** One checkbox toggle: match by substring, tick or untick, optionally annotate. */
export type CheckboxToggle = {
  contains: string;
  /** true for [x], false for [ ]. Defaults to true when `not_applicable` is set. */
  checked?: boolean;
  /** Toggle every matching line instead of Blocking on an ambiguous match. */
  all?: boolean;
  /** Tick with a note: appends ` — note: <text>`. */
  note?: string;
  /** Tick as not applicable: appends ` — n/a: <reason>`. */
  not_applicable?: string;
};

const CHECKBOX_LINE = /^\s*[-*+]\s+\[[ xX]\]/;
/** A trailing annotation written by a toggle: ` — note: …` or ` — n/a: …`. */
const CHECKBOX_ANNOTATION = /\s+—\s+(?:note|n\/a):.*$/;

function oneLine(value: string, field: string): string {
  const text = value.replace(/\s*\r?\n\s*/g, " ").trim();
  if (!text) throw new Error(`Blocked: toggle_checkboxes ${field} must be non-empty.`);
  return text;
}

/**
 * Toggle checkbox lines by substring. A substring that matches several checkbox lines is
 * Blocked (listing them) unless the toggle passes `all`. A note or not-applicable reason is
 * appended to the line, so the item's own wording never changes; unticking strips it.
 * Returns the new body and the lines as written.
 */
export function toggleCheckboxesInBody(
  body: string,
  toggles: CheckboxToggle[]
): { body: string; toggled: string[] } {
  const eol = detectEol(body);
  const lines = body.split(/\r?\n/);
  const toggled: string[] = [];
  for (const toggle of toggles) {
    if (toggle.note !== undefined && toggle.not_applicable !== undefined) {
      throw new Error("Blocked: a toggle takes note or not_applicable, not both.");
    }
    const checked = toggle.checked ?? (toggle.not_applicable !== undefined ? true : undefined);
    if (checked === undefined) {
      throw new Error(`Blocked: toggle for "${toggle.contains}" needs checked (true or false).`);
    }
    if (!checked && (toggle.note !== undefined || toggle.not_applicable !== undefined)) {
      throw new Error(
        `Blocked: note and not_applicable tick the item; they cannot be combined with checked: false.`
      );
    }
    const suffix =
      toggle.note !== undefined
        ? ` — note: ${oneLine(toggle.note, "note")}`
        : toggle.not_applicable !== undefined
          ? ` — n/a: ${oneLine(toggle.not_applicable, "not_applicable")}`
          : null;

    const hits: number[] = [];
    lines.forEach((line, i) => {
      if (CHECKBOX_LINE.test(line) && line.includes(toggle.contains)) hits.push(i);
    });
    if (hits.length === 0) {
      throw new Error(
        `Blocked: no checkbox line containing "${toggle.contains}" in territory body.`
      );
    }
    if (hits.length > 1 && !toggle.all) {
      throw new Error(
        `Blocked: "${toggle.contains}" matches ${hits.length} checkbox lines; make it unique or pass all: true. Matches:\n` +
          hits.map((i) => `- ${lines[i].trim()}`).join("\n")
      );
    }
    for (const i of hits) {
      let line = lines[i].replace(
        /^(\s*[-*+]\s+)\[[ xX]\]/,
        (_, prefix) => `${prefix}[${checked ? "x" : " "}]`
      );
      // Unticking drops an annotation; a new annotation replaces the old one.
      if (!checked || suffix !== null) line = line.replace(CHECKBOX_ANNOTATION, "");
      if (suffix !== null) line = `${line.replace(/\s+$/, "")}${suffix}`;
      lines[i] = line;
      toggled.push(line.trim());
    }
  }
  return { body: lines.join(eol), toggled };
}

function patchTerritoryScalars(
  frontmatter: string,
  scalars: { title?: string; description?: string; role?: FoundationRole },
  updated_at: string
): string {
  let patched = frontmatter;
  if (scalars.title !== undefined) {
    patched = patched.replace(/^title:.*$/m, `title: ${JSON.stringify(scalars.title)}`);
  }
  if (scalars.description !== undefined) {
    patched = patched.replace(
      /^description:.*$/m,
      `description: ${JSON.stringify(scalars.description)}`
    );
  }
  if (scalars.role !== undefined) {
    if (/^role:/m.test(patched)) {
      patched = patched.replace(/^role:.*$/m, `role: ${scalars.role}`);
    } else {
      patched = patched.replace(/^(type:.*)$/m, `$1\nrole: ${scalars.role}`);
    }
  }
  return patched.replace(/^updated_at:.*$/m, `updated_at: ${updated_at}`);
}

/**
 * Patches territory-owned content (body and title/description scalars).
 * Server-owned frontmatter fields (except updated_at on territory edits) are never modified here.
 * `twin` is the mirror twin path a live write on a shipped node re-synced, else null.
 */
export function patchNodeTerritory(
  node: MindPlanNode,
  input: PatchNodeTerritoryInput
): {
  patched_fields: string[];
  slot: TerritorySlot;
  readinessReset: boolean;
  twin: string | null;
  toggled?: string[];
} {
  const slot = resolveTerritorySlot(node, input.slot);
  const raw = readMarkdown(node, slot);
  const split = splitContext(raw);
  if (!split) {
    throw new Error(`Blocked: ${slot} file for "${node.id}" has no YAML frontmatter.`);
  }

  const patched_fields: string[] = [];
  const now = new Date().toISOString();
  let { frontmatter, separator, body } = split;
  // The Rules and Decisions sections have their own writers; body edits and checkbox toggles
  // never see or drop them.
  const { body: bodyWithoutRules, rules: existingRules } = splitNodeRules(body);
  const { body: bodyWithoutOwned, section: existingDecisions } = splitNodeDecisions(bodyWithoutRules);
  body = bodyWithoutOwned;

  if (input.title !== undefined) {
    frontmatter = patchTerritoryScalars(frontmatter, { title: input.title }, now);
    patched_fields.push("title");
  }
  if (input.description !== undefined) {
    frontmatter = patchTerritoryScalars(frontmatter, { description: input.description }, now);
    patched_fields.push("description");
  }
  if (input.role !== undefined) {
    frontmatter = patchTerritoryScalars(frontmatter, { role: input.role }, now);
    patched_fields.push("role");
    if (slot === "next" && node.next) node.next.role = input.role;
    else node.role = input.role;
  }
  if (input.body !== undefined) {
    if (hasNodeRulesHeading(input.body)) {
      throw new Error(
        `Blocked: body contains a "${NODE_RULES_HEADING}" heading. ` +
          `Node rules are written only by patch_node_rules; remove the section from the body.`
      );
    }
    if (hasNodeDecisionsHeading(input.body)) {
      throw new Error(
        `Blocked: body contains a "${NODE_DECISIONS_HEADING}" heading. ` +
          `Decisions are written only by record_decision; remove the section from the body.`
      );
    }
    // Keep the file's own line endings so a rewritten body does not mix LF into CRLF territory.
    const eol = detectEol(raw);
    body = input.body.replace(/\r?\n/g, eol);
    // One blank line below the frontmatter, unless the new body starts with its own.
    separator = /^\r?\n/.test(body) ? eol : `${eol}${eol}`;
    patched_fields.push("body");
    frontmatter = frontmatter.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  }
  if (input.section !== undefined) {
    if (normalizeHeadingName(input.section.heading).toLowerCase() === "rules") {
      throw new Error(
        `Blocked: "${NODE_RULES_HEADING}" is written only by patch_node_rules; it cannot be patched as a section.`
      );
    }
    if (hasNodeRulesHeading(input.section.text)) {
      throw new Error(
        `Blocked: section text contains a "${NODE_RULES_HEADING}" heading. Node rules are written only by patch_node_rules.`
      );
    }
    if (normalizeHeadingName(input.section.heading).toLowerCase() === "decisions") {
      throw new Error(
        `Blocked: "${NODE_DECISIONS_HEADING}" is written only by record_decision; it cannot be patched as a section.`
      );
    }
    if (hasNodeDecisionsHeading(input.section.text)) {
      throw new Error(
        `Blocked: section text contains a "${NODE_DECISIONS_HEADING}" heading. Decisions are written only by record_decision.`
      );
    }
    body = replaceSectionInBody(body, input.section.heading, input.section.text);
    patched_fields.push("section");
    frontmatter = frontmatter.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  }
  if (input.replace !== undefined) {
    if (hasNodeRulesHeading(input.replace.with)) {
      throw new Error(
        `Blocked: replace.with contains a "${NODE_RULES_HEADING}" heading. Node rules are written only by patch_node_rules.`
      );
    }
    if (hasNodeDecisionsHeading(input.replace.with)) {
      throw new Error(
        `Blocked: replace.with contains a "${NODE_DECISIONS_HEADING}" heading. Decisions are written only by record_decision.`
      );
    }
    body = replaceTextInBody(body, input.replace.find, input.replace.with, input.replace.all);
    patched_fields.push("replace");
    frontmatter = frontmatter.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  }
  let toggled: string[] | undefined;
  if (input.toggle_checkboxes?.length) {
    const result = toggleCheckboxesInBody(body, input.toggle_checkboxes);
    body = result.body;
    toggled = result.toggled;
    patched_fields.push("toggle_checkboxes");
    frontmatter = frontmatter.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  }
  if (input.change !== undefined || input.change_ref !== undefined) {
    frontmatter = applyChangeScalars(frontmatter, input);
    if (input.change !== undefined) patched_fields.push("change");
    if (input.change_ref !== undefined) patched_fields.push("change_ref");
    assignChange(slot === "next" && node.next ? node.next : node, input);
  }

  if (patched_fields.length === 0) {
    throw new Error(
      "Blocked: patch_node_territory requires at least one of title, description, role, body, section, replace, toggle_checkboxes, change, or change_ref."
    );
  }

  // An in-place claim marker clears once the live body names its path verbatim.
  if (slot === "current" && node.added_claims?.length) {
    const pending = pendingAddedClaims(node.added_claims, node.implements ?? [], body);
    if (pending.length !== node.added_claims.length) {
      frontmatter = replaceAddedClaimsInFence(frontmatter, pending);
      if (pending.length > 0) node.added_claims = pending;
      else delete node.added_claims;
    }
  }

  writeMarkdown(
    node,
    `${frontmatter}${separator}${joinNodeRules(joinNodeDecisions(body, existingDecisions), existingRules)}`,
    slot
  );
  const twin = slot === "current" ? syncMirrorAfterLiveWrite(node) : null;
  // Change ids are grouping metadata; every other field is the contract readiness was judged on.
  const contractWrite = patched_fields.some((f) => f !== "change" && f !== "change_ref");
  const readinessReset = contractWrite && demoteReadySlot(node, slot);
  return { patched_fields, slot, readinessReset, twin, ...(toggled ? { toggled } : {}) };
}

/**
 * A contract write (territory text, claims, edges) to a slot in `ready` sends that slot back to
 * `draft`: readiness was judged against the contract before the write. Every store writer of
 * contract calls this after writing. Returns true when it demoted the slot.
 */
export function demoteReadySlot(node: MindPlanNode, slot: TerritorySlot): boolean {
  if (!isPipelineNodeType(node.type)) return false;
  const now = new Date().toISOString();
  if (slot === "next") {
    if (!node.next || node.next.state !== "ready") return false;
    node.next.state = "draft";
    node.next.updated_at = now;
    patchFrontmatter({ id: node.id, type: node.type, state: "draft", updated_at: now }, "next");
    return true;
  }
  if (node.next || node.shipped_at || node.state !== "ready") return false;
  node.state = "draft";
  node.updated_at = now;
  patchFrontmatter(node);
  return true;
}

/** Validates change scalars: "" clears; a change id is a slug; a ref is one line. */
export function validateChangeInput(input: { change?: string; change_ref?: string }): void {
  if (input.change !== undefined && input.change !== "" && !CHANGE_ID_PATTERN.test(input.change)) {
    throw new Error(
      `Blocked: change id "${input.change}" must be a slug (lowercase letters, digits, "-" or "_").`
    );
  }
  if (input.change_ref !== undefined && /[\r\n]/.test(input.change_ref)) {
    throw new Error("Blocked: change_ref must be one line (a branch name or PR URL).");
  }
}

/** Sets or removes `change` / `change_ref` lines in a `---` fenced frontmatter block. */
function applyChangeScalars(
  frontmatter: string,
  input: { change?: string; change_ref?: string }
): string {
  validateChangeInput(input);
  const nl = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  let out = frontmatter;
  for (const key of ["change", "change_ref"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const line = new RegExp(`^${key}:.*$`, "m");
    if (value === "") {
      out = out.replace(new RegExp(`\\r?\\n${key}:.*$`, "m"), "");
    } else if (line.test(out)) {
      out = out.replace(line, `${key}: ${JSON.stringify(value)}`);
    } else {
      out = out.replace(/(\r?\n---)$/, `${nl}${key}: ${JSON.stringify(value)}$1`);
    }
  }
  return out;
}

function assignChange(
  target: { change?: string; change_ref?: string },
  input: { change?: string; change_ref?: string }
): void {
  if (input.change !== undefined) {
    if (input.change) target.change = input.change;
    else delete target.change;
  }
  if (input.change_ref !== undefined) {
    if (input.change_ref) target.change_ref = input.change_ref;
    else delete target.change_ref;
  }
}

/**
 * Set or clear (empty string) the change id and ref on one slot's frontmatter.
 * Grouping metadata: never touches state or `updated_at`.
 */
export function writeChangeFrontmatter(
  node: MindPlanNode,
  input: { change?: string; change_ref?: string },
  slot: TerritorySlot = "current"
): void {
  if (input.change === undefined && input.change_ref === undefined) return;
  if (slot === "next" && !node.next) {
    throw new Error(`Blocked: node "${node.id}" has no open evolution to carry a change id.`);
  }
  const { file, raw, fence } = requireMutableFrontmatter(node, slot);
  const patched = applyChangeScalars(fence, input);
  if (patched !== fence) fs.writeFileSync(file, raw.replace(fence, patched), "utf-8");
  assignChange(slot === "next" && node.next ? node.next : node, input);
}

/**
 * Label a shipped node with no open next as a neighbor of `change` (the live `change` scalar; an
 * empty string clears it), then re-sync its mirror twin. One label per node: a different id
 * replaces the old one, returned as `replaced`. `twin` is null when nothing was written.
 */
export function writeNeighborLabel(
  node: MindPlanNode,
  change: string
): { twin: string | null; replaced?: string } {
  if (!node.shipped_at || node.next) {
    throw new Error(
      `Blocked: "${node.id}" is not a shipped node with no open next; only those take a neighbor label.`
    );
  }
  const previous = node.change;
  if ((previous ?? "") === change) return { twin: null };
  writeChangeFrontmatter(node, { change }, "current");
  const twin = syncMirrorAfterLiveWrite(node);
  return { twin, ...(previous && change ? { replaced: previous } : {}) };
}

/**
 * Remove the live `added_claims` review marker. Returns true when the file changed. Does not
 * re-sync a mirror twin: callers that keep the node shipped call `syncMirrorAfterLiveWrite`.
 */
export function clearAddedClaims(node: MindPlanNode): boolean {
  const { file, raw, fence } = requireMutableFrontmatter(node, "current");
  const patched = replaceAddedClaimsInFence(fence, []);
  delete node.added_claims;
  if (patched === fence) return false;
  fs.writeFileSync(file, raw.replace(fence, patched), "utf-8");
  return true;
}

/**
 * Opens an evolution: flips a standing `mirror` twin to `draft` (or seeds from live when missing).
 * Does not reset checkboxes — the standing diff is `state` only until the agent edits the successor.
 */
export function openNextSlot(
  node: MindPlanNode,
  meta?: { title?: string; description?: string }
): NextSlot {
  if (node.next) {
    throw new Error(
      `Blocked: "${node.id}" already has a ${territorySlotFilename(node, "next")} evolution in state "${node.next.state}".`
    );
  }
  const nextPath = markdownPath(node, "next");
  const existingState = readNextFileState(node);
  if (existingState && !isMirrorState(existingState)) {
    throw new Error(
      `Blocked: "${node.id}" next file has unexpected state "${existingState}". ` +
        `Expected ${MIRROR_STATE} or a missing file.`
    );
  }
  // Seed from live only when the twin is missing (old consumer repos). An existing
  // mirror is flipped in place — do not rewrite body/checkboxes from live again.
  if (!fs.existsSync(nextPath)) {
    writeMirrorTwin(node);
  } else {
    const drift = mirrorDriftReason(node);
    if (drift) {
      throw new Error(
        `Blocked: "${node.id}" ${drift}. ` +
          `Heal with mindplan-mcp init or a live MCP write before open_next.`
      );
    }
  }

  const now = new Date().toISOString();
  const raw = fs.readFileSync(nextPath, "utf-8");
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!match) {
    throw new Error(`Blocked: next file for "${node.id}" has no YAML frontmatter.`);
  }
  let inner = match[2].replace(/^state:\s*.*$/m, "state: draft");
  if (/^updated_at:/m.test(inner)) {
    inner = inner.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  } else {
    const nl = match[1].endsWith("\r\n") ? "\r\n" : "\n";
    inner = `${inner}${nl}updated_at: ${now}`;
  }
  // When this revision opened: the decision gate only counts change-id decisions from then on.
  {
    const nl = match[1].endsWith("\r\n") ? "\r\n" : "\n";
    inner = `${inner.replace(/\r?\nopened_at:.*$/m, "")}${nl}opened_at: ${now}`;
  }
  const title = meta?.title;
  const description = meta?.description;
  if (title !== undefined) {
    if (/^title:/m.test(inner)) {
      inner = inner.replace(/^title:.*$/m, `title: ${JSON.stringify(title)}`);
    } else {
      const nl = match[1].endsWith("\r\n") ? "\r\n" : "\n";
      inner = `${inner}${nl}title: ${JSON.stringify(title)}`;
    }
  }
  if (description !== undefined) {
    if (/^description:/m.test(inner)) {
      inner = inner.replace(/^description:.*$/m, `description: ${JSON.stringify(description)}`);
    } else {
      const nl = match[1].endsWith("\r\n") ? "\r\n" : "\n";
      inner = `${inner}${nl}description: ${JSON.stringify(description)}`;
    }
  }
  // Bypass writeMarkdown mirror guard — we are intentionally leaving mirror for draft.
  fs.writeFileSync(nextPath, `${match[1]}${inner}${match[3]}${raw.slice(match[0].length)}`, "utf-8");

  fs.mkdirSync(nextAttachmentsDir(node), { recursive: true });
  const keep = path.join(nextAttachmentsDir(node), ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf-8");

  const parsed = parseFrontmatter(fs.readFileSync(nextPath, "utf-8"));
  if (!parsed) {
    throw new Error(`Blocked: next file for "${node.id}" unreadable after open_next.`);
  }
  const slot: NextSlot = {
    state: "draft",
    title: parsed.scalars.title ?? node.title,
    description: parsed.scalars.description ?? node.description,
    updated_at: now,
    opened_at: now,
  };
  if (parsed.arrays.belongs_to.length) slot.belongs_to = [...parsed.arrays.belongs_to];
  if (parsed.arrays.depends_on.length) slot.depends_on = [...parsed.arrays.depends_on];
  if (parsed.arrays.exposes.length) slot.exposes = [...parsed.arrays.exposes];
  if (parsed.arrays.leads_to.length) slot.leads_to = [...parsed.arrays.leads_to];
  if (parsed.arrays.mounts.length) slot.mounts = [...parsed.arrays.mounts];
  if (parsed.implements.length) slot.implements = [...parsed.implements];
  if (parsed.scalars.role && isFoundationRole(parsed.scalars.role)) {
    slot.role = parsed.scalars.role;
  } else if (node.role) {
    slot.role = node.role;
  }
  return slot;
}

/**
 * Abandons an in-flight evolution by restoring the standing mirror twin from live.
 * Does not delete `<id>.next.mdx`.
 */
export function discardNextSlot(node: Pick<MindPlanNode, "id" | "type">): void {
  const nextFile = markdownPath(node, "next");
  if (!fs.existsSync(nextFile)) {
    throw new Error(`Blocked: node "${node.id}" has no ${territorySlotFilename(node, "next")} to discard.`);
  }
  const nextAtt = nextAttachmentsDir(node);
  if (fs.existsSync(nextAtt)) {
    fs.rmSync(nextAtt, { recursive: true, force: true });
  }
  writeMirrorTwin(node);
  fs.mkdirSync(nextAttachmentsDir(node), { recursive: true });
  const keep = path.join(nextAttachmentsDir(node), ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf-8");
}

/**
 * Promotes `<id>.next.mdx` over `<id>.mdx`: copies next body/scalars/edges into the live file with
 * production state, then restores the next file as a `mirror` twin.
 */
export function promoteNextSlot(
  node: MindPlanNode,
  productionState: string,
  shippedAt: string
): void {
  if (!node.next) {
    throw new Error(`Blocked: node "${node.id}" has no ${territorySlotFilename(node, "next")} to promote.`);
  }
  const nextRaw = readMarkdown(node, "next");
  const nextSplit = splitContext(nextRaw);
  if (!nextSplit) {
    throw new Error(`Blocked: next file for "${node.id}" has no YAML frontmatter.`);
  }
  const nextParsed = parseFrontmatter(nextRaw);
  if (!nextParsed) {
    throw new Error(`Blocked: next file for "${node.id}" has no YAML frontmatter.`);
  }

  const title = nextParsed.scalars.title ?? node.next.title;
  const description = nextParsed.scalars.description ?? node.next.description;
  const belongs_to = nextParsed.arrays.belongs_to;
  const depends_on = nextParsed.arrays.depends_on;
  const exposes = nextParsed.arrays.exposes;
  const leads_to = nextParsed.arrays.leads_to;
  const mounts = nextParsed.arrays.mounts;
  const implementsList = nextParsed.implements;
  const role =
    nextParsed.scalars.role && isFoundationRole(nextParsed.scalars.role)
      ? (nextParsed.scalars.role as FoundationRole)
      : node.next.role ?? node.role;

  const frontmatterLines = [
    "---",
    `id: ${node.id}`,
    `type: ${node.type}`,
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `state: ${productionState}`,
    `shipped_at: ${shippedAt}`,
    `created_at: ${node.created_at}`,
    `updated_at: ${shippedAt}`,
  ];
  if (belongs_to.length > 0) {
    frontmatterLines.push("belongs_to:");
    for (const id of belongs_to) frontmatterLines.push(`  - ${id}`);
  }
  if (depends_on.length > 0) {
    frontmatterLines.push("depends_on:");
    for (const id of depends_on) frontmatterLines.push(`  - ${id}`);
  }
  if (exposes.length > 0) {
    frontmatterLines.push("exposes:");
    for (const id of exposes) frontmatterLines.push(`  - ${id}`);
  }
  if (leads_to.length > 0) {
    frontmatterLines.push("leads_to:");
    for (const id of leads_to) frontmatterLines.push(`  - ${id}`);
  }
  if (mounts.length > 0) {
    frontmatterLines.push("mounts:");
    for (const id of mounts) frontmatterLines.push(`  - ${id}`);
  }
  if (implementsList.length > 0) {
    frontmatterLines.push("implements:");
    for (const p of implementsList) frontmatterLines.push(`  - ${p}`);
  }
  if (role) {
    frontmatterLines.push(`role: ${role}`);
  }
  frontmatterLines.push("---");

  const liveRules = readNodeRules(node, "current");
  const promotedBody = joinNodeRules(splitNodeRules(nextSplit.body).body, liveRules);
  // The live file takes the next file's line endings and frontmatter-to-body layout.
  writeMarkdown(
    node,
    `${frontmatterLines.join(detectEol(nextRaw))}${nextSplit.separator}${promotedBody}`,
    "current"
  );

  // Merge next-attachments into attachments when present
  const nextAtt = nextAttachmentsDir(node);
  if (fs.existsSync(nextAtt)) {
    const dest = attachmentsDir(node);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(nextAtt, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === ".gitkeep") continue;
      fs.copyFileSync(path.join(nextAtt, entry.name), path.join(dest, entry.name));
    }
  }

  discardNextSlot(node);

  node.title = title;
  node.description = description;
  node.state = productionState as MindPlanNode["state"];
  node.shipped_at = shippedAt;
  node.updated_at = shippedAt;
  if (belongs_to.length > 0) node.belongs_to = [...belongs_to];
  else delete node.belongs_to;
  if (depends_on.length > 0) node.depends_on = [...depends_on];
  else delete node.depends_on;
  if (exposes.length > 0) node.exposes = [...exposes];
  else delete node.exposes;
  if (leads_to.length > 0) node.leads_to = [...leads_to];
  else delete node.leads_to;
  if (mounts.length > 0) node.mounts = [...mounts];
  else delete node.mounts;
  if (implementsList.length > 0) node.implements = [...implementsList];
  else delete node.implements;
  if (role) node.role = role;
  else delete node.role;
  delete node.next;
}

/**
 * Write (replace) the `implements` list on current or next frontmatter.
 * Updates the in-memory node accordingly. Used by set_implementation_files and init migration.
 * Only a changed list sends a `ready` slot back to `draft`; an identical list does not.
 * On the live slot, `addedInPlace` entries join the `added_claims` review marker, and markers no
 * longer claimed (or already named by the body) are dropped.
 */
export function writeImplementsFrontmatter(
  node: MindPlanNode,
  files: string[],
  slot: TerritorySlot = "current",
  addedInPlace: string[] = []
): FrontmatterWrite {
  const normalized = normalizeClaimList(files);
  const { file, raw, fence, inner: rawInner } = requireMutableFrontmatter(node, slot);
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `Blocked: ${slot} file for "${node.id}" has unreadable YAML frontmatter; cannot set implements.`
    );
  }
  const now = new Date().toISOString();
  const unchanged = normalizeClaimList(parsed.implements).join("\n") === normalized.join("\n");
  let inner = stripListFieldLines(rawInner);
  inner = inner.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  const edgeLines = formatEdgeFieldLines(parsed.arrays);
  const implLines = formatImplementsLines(normalized);
  let added: string[] = [];
  if (slot === "current") {
    added = pendingAddedClaims(
      [...parsed.added_claims, ...addedInPlace],
      normalized,
      splitContext(raw)?.body ?? ""
    );
    inner = stripAddedClaimsLines(inner);
  }
  const addedLines = formatAddedClaimsLines(added);
  const extras = [edgeLines, implLines, addedLines].filter(Boolean).join("\n");
  const rebuiltInner = extras ? `${inner}\n${extras}` : inner;
  const rebuilt = `---\n${rebuiltInner}\n---`;
  fs.writeFileSync(file, raw.replace(fence, rebuilt), "utf-8");

  let twin: string | null = null;
  if (slot === "next") {
    if (!node.next) {
      throw new Error(`Blocked: node "${node.id}" has no ${territorySlotFilename(node, "next")}.`);
    }
    node.next.implements = normalized.length > 0 ? normalized : undefined;
    node.next.updated_at = now;
  } else {
    if (normalized.length > 0) node.implements = normalized;
    else delete node.implements;
    if (added.length > 0) node.added_claims = added;
    else delete node.added_claims;
    node.updated_at = now;
    twin = syncMirrorAfterLiveWrite(node);
  }
  return { readinessReset: !unchanged && demoteReadySlot(node, slot), twin };
}

/**
 * Write Foundation `role` on current or next frontmatter (migration / create helpers).
 */
export function writeRoleFrontmatter(
  node: MindPlanNode,
  role: FoundationRole,
  slot: TerritorySlot = "current"
): void {
  const { file, raw, fence } = requireMutableFrontmatter(node, slot);
  const now = new Date().toISOString();
  let patched = fence;
  if (/^role:/m.test(patched)) {
    patched = patched.replace(/^role:.*$/m, `role: ${role}`);
  } else {
    patched = patched.replace(/^(type:.*)$/m, `$1\nrole: ${role}`);
  }
  patched = patched.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  fs.writeFileSync(file, raw.replace(fence, patched), "utf-8");
  if (slot === "next" && node.next) {
    node.next.role = role;
    node.next.updated_at = now;
  } else {
    node.role = role;
    node.updated_at = now;
  }
}
