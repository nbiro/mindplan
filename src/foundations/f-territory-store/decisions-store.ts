/**
 * Decision files: one file per decision, `decisions/<decision-id>.md`, beside a node's live file
 * or inside one of its revision folders. Each file holds exactly the `### <id>` entry the
 * `## Decisions` section held (`formatDecisionEntry`), plus an optional `- Nodes:` line, so moving
 * a section into files is a straight split.
 */

import * as path from "path";
import type { DecisionRecord } from "../f-domain-model/types.js";
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
  throw new Error("not implemented: readDecisionFiles");
}

/**
 * Writes `record` to `dir/<id>.md` (creating `dir`), with `formatDecisionFile`. Blocked when a
 * file of that id already exists there (decisions are never rewritten). Returns the absolute path
 * written; callers report it repo-relative in `changed_files`.
 */
export function appendDecisionFile(dir: string, record: DecisionRecord): string {
  throw new Error("not implemented: appendDecisionFile");
}

/**
 * Moves every decision file of `fromDir` into `toDir` (creating it; used when a revision ships:
 * its decisions join live). Blocked before moving anything when a file of the same name exists in
 * `toDir`. Removes `fromDir` when it ends empty. Returns the absolute paths touched (each source
 * and each destination). A missing `fromDir` moves nothing.
 */
export function moveDecisions(fromDir: string, toDir: string): string[] {
  throw new Error("not implemented: moveDecisions");
}
