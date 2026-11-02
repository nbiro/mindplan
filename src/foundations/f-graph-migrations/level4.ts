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
  PLANNED_EDGE_TYPES,
  isFoundationRole,
  type DecisionRecord,
  type NodeType,
  type Revision,
} from "../f-domain-model/types.js";
import { diffDelta, scalarHashes, sectionHashes } from "../f-revision-model/index.js";
import { RM_MAX_RETRIES, readFileRetry, unlinkRetry, withTransientRetry, writeFileRetry } from "../f-source-index/io.js";
import { decisionFileName, decisionsDir, formatDecisionFile } from "../f-territory-store/decisions-store.js";
import { REVISIONS_DIR, formatRevisionFile } from "../f-territory-store/revisions.js";
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
 * Moves every legacy `<id>.next.mdx` of a Foundation, Interaction, or Interface into
 * `revisions/<change>/<id>.mdx` (change: the file's `change`, else `rev-<id>`). The revision's
 * edges, claims, and tests are the deltas from the live file to the next snapshot; its scalars,
 * state, dates, `change_ref`, `attributed`, and `split_into` come from the next file; `base` hashes
 * the current live file, so nothing conflicts. The body drops `## Rules` and `## Decisions`; next
 * decisions live does not hold become `revisions/<change>/decisions/<id>.md`, and
 * `next-attachments/` (but `.gitkeep`) moves to `revisions/<change>/attachments/`. The next file
 * and `next-attachments/` are then deleted. A `state: mirror` leftover is skipped. Blocked when
 * `revisions/<change>/` already exists or the change id is invalid. Returns the moves, in folder order.
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
    if (fs.existsSync(revDir)) {
      throw blocked(
        `cannot move ${repoRelative(nextFile)} to ${repoRelative(revDir)}/: that revision folder already exists. Keep one of the two, delete the other by hand, then call upgrade_project again.`
      );
    }
    const liveRaw = readFileRetry(live);
    const liveFm = parseFrontmatter(liveRaw);
    if (!liveFm) throw blocked(`${repoRelative(live)} has no YAML frontmatter.`);
    const liveBody = splitContext(liveRaw)?.body ?? "";
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

    const known = liveDecisionIds(folder, liveRaw);
    const own: DecisionRecord[] = parseDecisions(splitNodeDecisions(next.body).section).filter((d) => !known.has(d.id));

    const revFile = path.join(revDir, liveMdxFilename(id));
    fs.mkdirSync(revDir, { recursive: true });
    writeFileRetry(revFile, formatRevisionFile(id, liveFm.scalars.type as NodeType, revision, withoutOwnedSections(next.body)));
    for (const record of own) {
      const dir = decisionsDir(revDir);
      fs.mkdirSync(dir, { recursive: true });
      writeFileRetry(path.join(dir, decisionFileName(record.id)), formatDecisionFile(record));
    }
    const nextAtt = legacyNextAttachmentsDir(folder);
    moveAttachments(nextAtt, path.join(revDir, ATTACHMENTS_DIR));
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
 * Moves each entry of every live file's `## Decisions` section to `decisions/<id>.md`
 * (`formatDecisionFile`) and removes the section from the body, keeping every other byte and the
 * file's line endings. A file already there with the same content is kept; one with other content
 * is Blocked, as is a section holding a `###` entry that does not parse as a decision. Returns the
 * nodes split, in folder order.
 */
export function splitDecisionSections(): DecisionsSplit[] {
  const split: DecisionsSplit[] = [];
  for (const { id, folder, live } of nodeFolders(NODE_DIRS)) {
    const raw = readFileRetry(live);
    const parts = splitContext(raw);
    if (!parts) continue;
    const { body, section } = splitNodeDecisions(parts.body);
    if (body === parts.body) continue;
    const records = parseDecisions(section);
    const headings = section.split("\n").filter((l) => DECISION_HEADING_LINE.test(l)).length;
    if (headings !== records.length) {
      throw blocked(
        `the ## Decisions section of ${repoRelative(live)} holds ${headings - records.length} "###" entr${headings - records.length === 1 ? "y" : "ies"} that do not parse as decisions (a "d-" id and a "- Decision:" line). Fix them by hand, then call upgrade_project again.`
      );
    }
    const dir = decisionsDir(folder);
    const toWrite: { file: string; text: string }[] = [];
    for (const record of records) {
      const file = path.join(dir, decisionFileName(record.id));
      const text = formatDecisionFile(record);
      if (fs.existsSync(file)) {
        if (readFileRetry(file).replace(/\r\n/g, "\n") !== text) {
          throw blocked(
            `cannot split decision "${record.id}" out of ${repoRelative(live)}: ${repoRelative(file)} already holds a different decision of that id. Keep one, delete the other by hand, then call upgrade_project again.`
          );
        }
        continue;
      }
      toWrite.push({ file, text });
    }
    if (toWrite.length > 0) fs.mkdirSync(dir, { recursive: true });
    for (const w of toWrite) writeFileRetry(w.file, w.text);
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    // A section at the end leaves its leading blank line (and, in CRLF files, a lone \r): end on one EOL.
    let newBody = body;
    if (decisionsSectionRunsToEnd(parts.body)) {
      const trimmed = body.replace(/[\r\n]+$/, "");
      newBody = trimmed ? `${trimmed}${eol}` : "";
    }
    writeFileRetry(live, `${parts.frontmatter}${parts.separator}${newBody}`);
    split.push({ node_id: id, count: records.length });
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
 * `mindplan/map.md` is derived (rewritten after every mutation), so git should not track it. When
 * it is present or tracked: adds a `map.md` line to `mindplan/.gitignore` (creating the file) and,
 * inside git, untracks it (`git rm --cached`), never deleting the working copy. Returns true when
 * this run changed either.
 */
export function ignoreDerivedMap(): boolean {
  const mapAbs = path.join(mindplanRoot(), "map.md");
  const tracked = git(["ls-files", "--error-unmatch", "--", MAP_REL]) !== null;
  if (!tracked && !fs.existsSync(mapAbs)) return false;
  let changed = false;
  const ignoreFile = path.join(mindplanRoot(), ".gitignore");
  const current = fs.existsSync(ignoreFile) ? readFileRetry(ignoreFile) : "";
  const listed = current.split(/\r?\n/).some((l) => ["map.md", "/map.md"].includes(l.trim()));
  if (!listed) {
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const sep = current === "" || current.endsWith("\n") ? "" : eol;
    writeFileRetry(ignoreFile, `${current}${sep}map.md${eol}`);
    changed = true;
  }
  if (tracked && git(["rm", "--cached", "--quiet", "--", MAP_REL]) !== null) changed = true;
  return changed;
}
