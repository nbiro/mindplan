/**
 * Compact run_check results: each warning gets a stable id (`w-` + 10 hex of sha1 over its
 * category, node id, and text), the ids a check of this root showed are kept in
 * `.mindplan-cache/check-seen.json`, and acknowledged ids in `.mindplan-cache/acks.json`
 * (acknowledge_warning). A compact result lists only warnings neither seen before nor
 * acknowledged and counts the rest, so a repeated check stays small. `nodes` scopes warnings to
 * those nodes; failures stay graph-wide.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";

const CACHE_DIRNAME = ".mindplan-cache";
const SEEN_FILE = "check-seen.json";
const ACKS_FILE = "acks.json";

/** A warning id: `w-` and ten lowercase hex digits. */
export const WARNING_ID = /^w-[0-9a-f]{10}$/;

const NODE_ID_TOKEN = /^[a-z0-9][a-z0-9-_]*$/;

/** The warning's category: its `<word>:` prefix (`stale`, `description`, `hotspot`, …), else `other`. */
export function warningCategory(text: string): string {
  const m = /^([a-z][a-z-]*):\s/.exec(text);
  return m ? m[1] : "other";
}

/**
 * Node ids a warning names: every quoted token shaped like a node id (paths and files have `/` or
 * `.`), and the bare id after `fan-out:`. The first is the warning's node.
 */
export function warningNodeIds(text: string): string[] {
  const ids: string[] = [];
  const fan = /^fan-out: ([a-z0-9][a-z0-9-_]*)\s/.exec(text);
  if (fan) ids.push(fan[1]);
  for (const m of text.matchAll(/"([^"\s]+)"/g)) {
    if (NODE_ID_TOKEN.test(m[1]) && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** `w-` + the first 10 hex digits of sha1(category \0 node id \0 text). */
export function warningId(text: string): string {
  const category = warningCategory(text);
  const node = warningNodeIds(text)[0] ?? "";
  const hash = createHash("sha1").update(`${category}\0${node}\0${text}`).digest("hex");
  return `w-${hash.slice(0, 10)}`;
}

/** Whether a warning names one of `nodes`. */
export function inScope(text: string, nodes: Set<string>): boolean {
  return warningNodeIds(text).some((id) => nodes.has(id));
}

function cacheFile(root: string, name: string): string {
  return path.join(root, CACHE_DIRNAME, name);
}

function readIds(file: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { ids?: unknown };
    return new Set(Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeIds(file: string, ids: Iterable<string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ids: [...ids].sort() }) + "\n");
}

/**
 * Records what this check showed. A scoped check showed only its own warnings: those are seen
 * now, and an out-of-scope warning stays seen only if an earlier check showed it.
 */
export function recordSeen(root: string, warnings: string[], nodes?: Set<string>): Set<string> {
  const file = cacheFile(root, SEEN_FILE);
  const previous = readIds(file);
  const next = new Set<string>();
  for (const w of warnings) {
    const id = warningId(w);
    if (!nodes || inScope(w, nodes) || previous.has(id)) next.add(id);
  }
  try {
    writeIds(file, next);
  } catch {
    // A read-only checkout still gets its check; the next one just shows everything again.
  }
  return previous;
}

/** Warnings a scoped check reports: all of them without `nodes`. */
export function scopeWarnings(warnings: string[], nodes?: Set<string>): { kept: string[]; outside: number } {
  if (!nodes) return { kept: warnings, outside: 0 };
  const kept = warnings.filter((w) => inScope(w, nodes));
  return { kept, outside: warnings.length - kept.length };
}

/**
 * The compact result: per-category counts of the scoped warnings, every failure once, the
 * warnings neither seen in the previous check nor acknowledged, and how many were each.
 */
export function compactCheckResult(input: {
  ok: boolean;
  failures: string[];
  warnings: string[];
  outside: number;
  seen: Set<string>;
  root: string;
}): Record<string, unknown> {
  const acks = readIds(cacheFile(input.root, ACKS_FILE));
  const counts: Record<string, number> = {};
  const shown: { id: string; text: string }[] = [];
  let acknowledged = 0;
  let unchanged = 0;
  for (const text of input.warnings) {
    const category = warningCategory(text);
    counts[category] = (counts[category] ?? 0) + 1;
    const id = warningId(text);
    if (acks.has(id)) acknowledged++;
    else if (input.seen.has(id)) unchanged++;
    else shown.push({ id, text });
  }
  if (input.outside > 0) counts.out_of_scope = input.outside;
  return {
    ok: input.ok,
    counts,
    failures: [...new Set(input.failures)],
    warnings: shown,
    acknowledged,
    unchanged,
  };
}

/** acknowledge_warning: stores warning ids in `.mindplan-cache/acks.json` of this root. */
export function acknowledgeWarnings(root: string, args: { id?: string; ids?: string[] }): Record<string, unknown> {
  const given = [...(args.id !== undefined ? [args.id] : []), ...(args.ids ?? [])];
  if (given.length === 0) throw blocked('acknowledge_warning requires "id" or "ids" (the w- ids a compact run_check lists).');
  const bad = given.filter((id) => !WARNING_ID.test(id));
  if (bad.length > 0) {
    throw blocked(
      `acknowledge_warning takes warning ids shaped w-<10 hex> (a compact run_check lists them); not: ${bad.map((b) => JSON.stringify(b)).join(", ")}.`
    );
  }
  const file = cacheFile(root, ACKS_FILE);
  const ids = readIds(file);
  for (const id of given) ids.add(id);
  writeIds(file, ids);
  return { acknowledged: [...new Set(given)] };
}
