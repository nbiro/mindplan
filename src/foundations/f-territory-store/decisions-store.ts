/**
 * Decision files: one file per decision, `decisions/<decision-id>.md`, beside a node's live file
 * or inside one of its revision folders. Each file holds exactly the `### <id>` entry the
 * `## Decisions` section held (`formatDecisionEntry`), plus an optional `- Nodes:` line, so moving
 * a section into files is a straight split.
 */

import * as fs from "fs";
import * as path from "path";
import { DECISION_ID_PATTERN, type DecisionRecord } from "../f-domain-model/types.js";
import { readFileRetry, withTransientRetry, writeFileRetry } from "../f-source-index/io.js";
import { formatDecisionEntry, parseDecisions } from "./store.js";

/** Folder name that holds decision files. */
export const DECISIONS_DIR = "decisions";

const NODES_LINE = /^[-*][ \t]+Nodes:[ \t]*(.*)$/i;

/** The decisions folder inside a node folder or revision folder (absolute in, absolute out). */
export function decisionsDir(folder: string): string {
  return path.join(folder, DECISIONS_DIR);
}

/** File name of one decision: `<decision-id>.md`. */
export function decisionFileName(id: string): string {
  return `${id}.md`;
}

/**
 * One decision file's text: the `### <id>` entry as the `## Decisions` section writes it, then
 * `- Nodes: a, b` when `record.nodes` is not empty; LF line endings and a final newline.
 */
export function formatDecisionFile(record: DecisionRecord): string {
  const lines = [formatDecisionEntry(record)];
  if (record.nodes?.length) lines.push(`- Nodes: ${record.nodes.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/** Parses one decision file (any line endings); null when it holds no valid `### <id>` entry. */
export function parseDecisionFile(text: string): DecisionRecord | null {
  const record = parseDecisions(text)[0];
  if (!record) return null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const m = raw.match(NODES_LINE);
    if (!m) continue;
    const nodes = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (nodes.length) record.nodes = nodes;
  }
  return record;
}

/**
 * Every decision file in `dir` (`*.md` whose text parses), in recorded order: by `date`, then by
 * file name. A missing folder is an empty list. Unparsable files are skipped.
 */
export function readDecisionFiles(dir: string): DecisionRecord[] {
  const out: { name: string; record: DecisionRecord }[] = [];
  for (const name of decisionFileNames(dir)) {
    const record = parseDecisionFile(readFileRetry(path.join(dir, name)));
    if (record) out.push({ name, record });
  }
  out.sort((a, b) => {
    const da = a.record.date ?? "";
    const db = b.record.date ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out.map((e) => e.record);
}

/** Names of the `*.md` files in `dir` (any case), sorted; a missing or unreadable folder is empty. Never throws. */
export function decisionFileNames(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

/**
 * Writes `record` to `dir/<id>.md` (creating `dir`), with `formatDecisionFile`. Blocked when a
 * file of that id already exists there (decisions are never rewritten). Returns the absolute path
 * written; callers report it repo-relative in `changed_files`.
 */
export function appendDecisionFile(dir: string, record: DecisionRecord): string {
  if (!DECISION_ID_PATTERN.test(record.id)) {
    throw new Error(`Blocked: decision id "${record.id}" must be "d-" followed by a slug.`);
  }
  const file = path.join(dir, decisionFileName(record.id));
  if (fs.existsSync(file)) {
    throw new Error(`Blocked: decision "${record.id}" is already recorded (${file}); decisions are never rewritten.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  writeFileRetry(file, formatDecisionFile(record));
  return file;
}

/** Every file name in `dir` (what a ship moves), sorted; empty when it is missing. */
export function decisionFolderFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/** Blocked when a decision file of `fromDir` already exists in `toDir` (checked before any move). */
export function assertNoDecisionClash(fromDir: string, toDir: string): void {
  const clash = decisionFolderFiles(fromDir).filter((name) => fs.existsSync(path.join(toDir, name)));
  if (clash.length > 0) {
    throw new Error(
      `Blocked: ${clash.map((n) => `"${n}"`).join(", ")} already exist in ${toDir}; no decision file was moved.`
    );
  }
}

/**
 * Moves every decision file of `fromDir` into `toDir` (creating it; used when a revision ships:
 * its decisions join live). Blocked before moving anything when a file of the same name exists in
 * `toDir`. Removes `fromDir` when it ends empty. Returns the absolute paths touched (each source
 * and each destination). A missing `fromDir` moves nothing.
 */
export function moveDecisions(fromDir: string, toDir: string): string[] {
  if (!fs.existsSync(fromDir)) return [];
  assertNoDecisionClash(fromDir, toDir);
  const names = decisionFolderFiles(fromDir);
  const touched: string[] = [];
  if (names.length > 0) fs.mkdirSync(toDir, { recursive: true });
  for (const name of names) {
    const from = path.join(fromDir, name);
    const to = path.join(toDir, name);
    withTransientRetry(() => fs.renameSync(from, to));
    touched.push(from, to);
  }
  if (fs.readdirSync(fromDir).length === 0) withTransientRetry(() => fs.rmdirSync(fromDir));
  return touched;
}
