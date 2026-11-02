/**
 * Level-4 migrations — a node holds several open revisions in `revisions/<change>/` instead of one
 * `<id>.next.mdx`, its decisions live in `decisions/<id>.md` files instead of a `## Decisions`
 * section, and `mindplan/map.md` is a derived file git ignores. Each pass reads the files on disk
 * (not the graph), so it works whatever the store parses, and is idempotent. Run by runMigrations
 * after the earlier levels. Owned by Foundation f-graph-migrations.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  CHANGE_ID_PATTERN,
  DECISION_ID_PATTERN,
  PLANNED_EDGE_TYPES,
  isFoundationRole,
  type DecisionRecord,
  type NodeType,
  type Revision,
} from "../f-domain-model/types.js";
import { diffDelta, scalarHashes, sectionHashes } from "../f-revision-model/index.js";
import { RM_MAX_RETRIES, readFileRetry, unlinkRetry, withTransientRetry, writeFileRetry } from "../f-source-index/io.js";
import { decisionFileName, decisionsDir, parseDecisionFile } from "../f-territory-store/decisions-store.js";
import { REVISIONS_DIR, formatRevisionFile, parseRevisionFile } from "../f-territory-store/revisions.js";
import {
  ATTACHMENTS_DIR,
  MINDPLAN_DIR,
  liveMdxFilename,
  mindplanRoot,
  parseDecisions,
  parseFrontmatter,
  projectRoot,
  splitContext,
  splitNodeDecisions,
  withoutOwnedSections,
} from "../f-territory-store/store.js";
import { legacyNextAttachmentsDir, legacyNextFile, parseLegacyNext } from "./legacy-next.js";

/** A legacy next file moved into `revisions/<change>/`. */
export type RevisionMoved = { node_id: string; change: string };

/** A live `## Decisions` section split into `count` decision files. */
export type DecisionsSplit = { node_id: string; count: number };

const PIPELINE_DIRS = ["foundations", "interactions", "interfaces"] as const;
const NODE_DIRS = ["capabilities", ...PIPELINE_DIRS, "bugs"] as const;

const DECISION_HEADING_LINE = /^###[ \t]+\S/;

function blocked(message: string): Error {
  return new Error(`Blocked: ${message}`);
}

function repoRelative(abs: string): string {
  return path.relative(projectRoot(), abs).split(path.sep).join("/");
}

/** Node folders (with a live `<id>.mdx`) under the given type folders, sorted by type then id. */
function nodeFolders(dirs: readonly string[]): { id: string; folder: string; live: string }[] {
  const out: { id: string; folder: string; live: string }[] = [];
  for (const dir of dirs) {
    const typePath = path.join(mindplanRoot(), dir);
    if (!fs.existsSync(typePath)) continue;
    const entries = fs
      .readdirSync(typePath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const id of entries) {
      const folder = path.join(typePath, id);
      const live = path.join(folder, liveMdxFilename(id));
      if (fs.existsSync(live) && fs.statSync(live).isFile()) out.push({ id, folder, live });
    }
  }
  return out;
}

/** Ids of the decisions a node folder already holds live: its section entries and its files. */
function liveDecisionIds(folder: string, liveRaw: string): Set<string> {
  const ids = new Set(parseDecisions(splitNodeDecisions(liveRaw).section).map((d) => d.id));
  try {
    for (const name of fs.readdirSync(decisionsDir(folder))) {
      if (name.toLowerCase().endsWith(".md")) ids.add(name.slice(0, -3));
    }
  } catch {
    // No decisions/ folder.
  }
  return ids;
}

/** Moves every entry of `from` except a top-level `.gitkeep` into `to`; returns the names moved. */
function moveAttachments(from: string, to: string): string[] {
  if (!fs.existsSync(from)) return [];
  const names = fs.readdirSync(from).filter((n) => n !== ".gitkeep").sort();
  if (names.length > 0) fs.mkdirSync(to, { recursive: true });
  for (const name of names) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    withTransientRetry(() => fs.renameSync(src, dst));
  }
  return names;
}

/**
 * Each `### <id>` entry of a decisions section, verbatim: its id and its raw text from the heading
 * line up to the next heading of any level (or the end), trailing blank lines dropped. Blocked
 * when a `###` heading does not carry a decision id, or an entry has no `- Decision:` line, naming
 * `where`.
 */
function decisionEntries(section: string, where: string): { id: string; text: string }[] {
  const out: { id: string; lines: string[] }[] = [];
  let current: { id: string; lines: string[] } | null = null;
  for (const raw of section.replace(/\r/g, "").split("\n")) {
    if (DECISION_HEADING_LINE.test(raw)) {
      const m = raw.match(/^###[ \t]+(\S+)[ \t]*$/);
      if (!m || !DECISION_ID_PATTERN.test(m[1])) {
        throw blocked(
          `the decisions in ${where} hold a "###" entry whose id does not parse ("${raw.trim()}"; a decision id is "d-" then lowercase letters, digits, "-" or "_"). Fix it by hand, then call upgrade_project again.`
        );
      }
      current = { id: m[1], lines: [raw] };
      out.push(current);
      continue;
    }
    if (/^#{1,6}[ \t]/.test(raw)) {
      current = null;
      continue;
    }
    current?.lines.push(raw);
  }
  return out.map((e) => {
    const text = `${e.lines.join("\n").replace(/\s+$/, "")}\n`;
    if (parseDecisions(text).length !== 1) {
      throw blocked(
        `decision "${e.id}" in ${where} does not parse as a decision (a "- Decision:" line). Fix it by hand, then call upgrade_project again.`
      );
    }
    return { id: e.id, text };
  });
}

/** True when two decision file texts hold the same entry: the same text, or the same parsed record. */
function sameDecisionText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (norm(a) === norm(b)) return true;
  const ra = parseDecisionFile(a);
  const rb = parseDecisionFile(b);
  return ra !== null && rb !== null && JSON.stringify(ra) === JSON.stringify(rb);
}

/**
 * Writes each entry to `<dir>/<id>.md` verbatim (its first line ending kept for the whole file).
 * An existing file with the same entry is kept; one with another is Blocked naming `where`.
 */
function writeDecisionEntries(dir: string, entries: { id: string; text: string }[], where: string, eol: string): void {
  const toWrite: { file: string; text: string }[] = [];
  for (const e of entries) {
    const file = path.join(dir, decisionFileName(e.id));
    if (fs.existsSync(file)) {
      if (!sameDecisionText(readFileRetry(file), e.text)) {
        throw blocked(
          `cannot split decision "${e.id}" out of ${where}: ${repoRelative(file)} already holds a different decision of that id. Keep one, delete the other by hand, then call upgrade_project again.`
        );
      }
      continue;
    }
    toWrite.push({ file, text: e.text.replace(/\n/g, eol) });
  }
  if (toWrite.length > 0) fs.mkdirSync(dir, { recursive: true });
  for (const w of toWrite) writeFileRetry(w.file, w.text);
}

/** Writes `text` to `file` through a temp file and a rename, so a half-written file never exists. */
function writeAtomically(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileRetry(tmp, text);
  withTransientRetry(() => fs.renameSync(tmp, file));
}

/** True when the revision file on disk is the one this migration would write. */
function sameRevisionFile(file: string, id: string, revision: Revision, body: string): boolean {
  try {
    const onDisk = parseRevisionFile(readFileRetry(file), id);
    const norm = (t: string) => t.replace(/\r\n/g, "\n").replace(/\s+$/, "");
    return JSON.stringify(onDisk.revision) === JSON.stringify(revision) && norm(onDisk.body) === norm(body);
  } catch {
    return false;
  }
}

/**
 * Moves every legacy `<id>.next.mdx` of a Foundation, Interaction, or Interface into
 * `revisions/<change>/<id>.mdx` (change: the file's `change`, else `rev-<id>`). The revision's
 * edges, claims, and tests are the deltas from the live file to the next snapshot; its scalars,
 * state, dates, `change_ref`, `attributed`, and `split_into` come from the next file; `base` hashes
 * the live file as it reads once its `## Decisions` section is split out, so nothing conflicts. The
 * body drops `## Rules` and `## Decisions`; each next decision live does not hold is copied verbatim
 * to `revisions/<change>/decisions/<id>.md`, and `next-attachments/` (but `.gitkeep`) moves to
 * `revisions/<change>/attachments/`. The revision file is written last but one (atomically), then
 * the next file and `next-attachments/` are deleted. A run stopped part way resumes: a
 * `revisions/<change>/` with no revision file, or with the very file this pass would write, is
 * finished. A `state: mirror` leftover is skipped. Blocked when `revisions/<change>/` holds a
 * different revision, the change id is invalid, or a next decision's `###` id does not parse.
 * Returns the moves, in folder order.
 */
export function moveNextToRevisions(): RevisionMoved[] {
  const moved: RevisionMoved[] = [];
  for (const { id, folder, live } of nodeFolders(PIPELINE_DIRS)) {
    const nextFile = legacyNextFile(folder, id);
    if (!fs.existsSync(nextFile) || !fs.statSync(nextFile).isFile()) continue;
    const next = parseLegacyNext(id, nextFile);
    if (!next) continue;
    const change = next.change ?? `rev-${id}`;
    if (!CHANGE_ID_PATTERN.test(change)) {
      throw blocked(
        `cannot move ${repoRelative(nextFile)}: its change id "${change}" is not a slug (lowercase letters, digits, "-" or "_"). Fix it by hand, then call upgrade_project again.`
      );
    }
    const revDir = path.join(folder, REVISIONS_DIR, change);
    const revFile = path.join(revDir, liveMdxFilename(id));
    const liveRaw = readFileRetry(live);
    const liveFm = parseFrontmatter(liveRaw);
    if (!liveFm) throw blocked(`${repoRelative(live)} has no YAML frontmatter.`);
    // Hash live as splitDecisionSections will leave it: its `## Decisions` section removed.
    const liveBody = splitNodeDecisions(splitContext(liveRaw)?.body ?? "").body;
    const liveRole = liveFm.scalars.role && isFoundationRole(liveFm.scalars.role) ? liveFm.scalars.role : undefined;

    const edges: Revision["edges"] = {};
    for (const type of PLANNED_EDGE_TYPES) {
      const d = diffDelta(liveFm.arrays[type], next.edges[type]);
      if (d.add.length > 0 || d.remove.length > 0) edges[type] = d;
    }
    const revision: Revision = {
      change,
      state: next.state,
      opened_at: next.opened_at ?? next.updated_at,
      updated_at: next.updated_at,
      title: next.title,
      description: next.description,
      edges,
      implements: diffDelta(liveFm.implements, next.implements),
      tests: diffDelta(liveFm.tests, next.tests),
      base: {
        scalars: scalarHashes({ title: liveFm.scalars.title ?? "", description: liveFm.scalars.description ?? "", role: liveRole }),
        sections: sectionHashes(liveBody),
      },
      conflicts: [],
    };
    if (next.change_ref) revision.change_ref = next.change_ref;
    if (next.role) revision.role = next.role;
    if (next.attributed.length > 0) revision.attributed = next.attributed;
    if (next.split_into.length > 0) revision.split_into = next.split_into;
    const eol = liveRaw.includes("\r\n") ? "\r\n" : "\n";
    const body = withoutOwnedSections(next.body);
    const text = formatRevisionFile(id, liveFm.scalars.type as NodeType, revision, body, eol);

    // A folder already there is this pass's own unfinished work, or Blocks.
    if (fs.existsSync(revDir) && fs.existsSync(revFile) && !sameRevisionFile(revFile, id, revision, body)) {
      throw blocked(
        `cannot move ${repoRelative(nextFile)} to ${repoRelative(revDir)}/: that folder already holds a different revision. Keep one of the two, delete the other by hand, then call upgrade_project again.`
      );
    }

    const known = liveDecisionIds(folder, liveRaw);
    const own = decisionEntries(splitNodeDecisions(next.body).section, repoRelative(nextFile)).filter((e) => !known.has(e.id));
    fs.mkdirSync(revDir, { recursive: true });
    writeDecisionEntries(decisionsDir(revDir), own, repoRelative(nextFile), eol);
    const nextAtt = legacyNextAttachmentsDir(folder);
    moveAttachments(nextAtt, path.join(revDir, ATTACHMENTS_DIR));
    if (!fs.existsSync(revFile)) writeAtomically(revFile, text);
    unlinkRetry(nextFile);
    if (fs.existsSync(nextAtt)) fs.rmSync(nextAtt, { recursive: true, force: true, maxRetries: RM_MAX_RETRIES });
    moved.push({ node_id: id, change });
  }
  return moved;
}

/** True when the first `## Decisions` section of `body` (as splitNodeDecisions reads it) ends at EOF. */
function decisionsSectionRunsToEnd(body: string): boolean {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^## Decisions[ \t]*$/.test(l.replace(/\r$/, "")));
  if (start === -1) return false;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}[ \t]/.test(lines[end])) end++;
  return end === lines.length;
}

/**
 * Moves each entry of every live file's `## Decisions` section to `decisions/<id>.md`, its raw
 * text copied verbatim (heading to the next heading of any level), and removes the section from
 * the body, keeping every other byte and the file's line endings. A file already there with the
 * same entry is kept; one with another is Blocked, as is a section holding a `###` entry whose id
 * does not parse or that has no `- Decision:` line. Returns the nodes split, in folder order.
 */
export function splitDecisionSections(): DecisionsSplit[] {
  const split: DecisionsSplit[] = [];
  for (const { id, folder, live } of nodeFolders(NODE_DIRS)) {
    const raw = readFileRetry(live);
    const parts = splitContext(raw);
    if (!parts) continue;
    const { body, section } = splitNodeDecisions(parts.body);
    if (body === parts.body) continue;
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const entries = decisionEntries(section, repoRelative(live));
    writeDecisionEntries(decisionsDir(folder), entries, repoRelative(live), eol);
    // A section at the end leaves its leading blank line (and, in CRLF files, a lone \r): end on one EOL.
    let newBody = body;
    if (decisionsSectionRunsToEnd(parts.body)) {
      const trimmed = body.replace(/[\r\n]+$/, "");
      newBody = trimmed ? `${trimmed}${eol}` : "";
    }
    writeFileRetry(live, `${parts.frontmatter}${parts.separator}${newBody}`);
    split.push({ node_id: id, count: entries.length });
  }
  return split;
}

const MAP_REL = `${MINDPLAN_DIR}/map.md`;

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: projectRoot(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

/**
 * Lists `map.md` in `mindplan/.gitignore` (creating the file) unless a line already ignores it.
 * True when it wrote the file. setup_project starts every new graph with it.
 */
export function ignoreMapLine(): boolean {
  const ignoreFile = path.join(mindplanRoot(), ".gitignore");
  const current = fs.existsSync(ignoreFile) ? readFileRetry(ignoreFile) : "";
  const listed = current.split(/\r?\n/).some((l) => ["map.md", "/map.md"].includes(l.trim()));
  if (listed) return false;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const sep = current === "" || current.endsWith("\n") ? "" : eol;
  writeFileRetry(ignoreFile, `${current}${sep}map.md${eol}`);
  return true;
}

/**
 * `mindplan/map.md` is derived (rewritten after every mutation), so git should not track it. When
 * it is present or tracked: adds a `map.md` line to `mindplan/.gitignore` (creating the file) and,
 * inside git, untracks it (`git rm --cached`), never deleting the working copy. Returns true when
 * this run changed either.
 */
export function ignoreDerivedMap(): boolean {
  const mapAbs = path.join(mindplanRoot(), "map.md");
  const tracked = git(["ls-files", "--error-unmatch", "--", MAP_REL]) !== null;
  if (!tracked && !fs.existsSync(mapAbs)) return false;
  let changed = ignoreMapLine();
  if (tracked && git(["rm", "--cached", "--quiet", "--", MAP_REL]) !== null) changed = true;
  return changed;
}
