/**
 * Find text in node territory — owned by i-find-text: find_in_node (matches in one node's body, each
 * with a snippet unique in its slot, ready for patch_node_territory's replace.find) and search_graph
 * (matching lines across every non-retired node). Read-only: no orientation gate, no record, no rules.
 *
 * The searched text is exactly what a replace edit's find is matched against: the live body below
 * the frontmatter without the `## Rules` and `## Decisions` sections, or an open revision file's
 * body. Line endings are read as `\n`; replace turns a find's `\n` into the file's own line ending,
 * so a snippet works on CRLF files too.
 */

import { NODE_TYPES, type MindPlanNode, type NodeType } from "../../foundations/f-domain-model/types.js";
import {
  loadGraph,
  readMarkdown,
  splitContext,
  withoutOwnedSections,
} from "../../foundations/f-territory-store/store.js";
import { loadRevision } from "../../foundations/f-territory-store/revisions.js";
import { openChanges, resolveRevisionChange } from "../../foundations/f-revision-model/index.js";
import { blocked, findNode } from "../../foundations/f-compiler-rules/rules.js";
import { isRetired } from "../../foundations/f-plan-views/views.js";

export const FIND_SLOTS = ["current", "next"] as const;
export type FindSlot = (typeof FIND_SLOTS)[number];

export const DEFAULT_FIND_IN_NODE_LIMIT = 20;
export const MAX_FIND_IN_NODE_LIMIT = 100;
export const DEFAULT_SEARCH_GRAPH_LIMIT = 30;
export const MAX_SEARCH_GRAPH_LIMIT = 200;
/** A search_graph match line longer than this is cut around the match. */
const MAX_LINE_CHARS = 200;

type MatchOptions = { regex?: boolean; case_sensitive?: boolean };

/** One searched text: a slot of a node, its lines joined with `\n`. */
type SlotText = { slot: FindSlot; change?: string; text: string };

/** The line test for `text`: substring (case-insensitive unless asked) or a JS regex; -1 on no match. */
function lineMatcher(text: string, opts: MatchOptions): (line: string) => number {
  if (text.length === 0) throw blocked("text must be non-empty.");
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(text, opts.case_sensitive ? "" : "i");
    } catch (err) {
      throw blocked(`text is not a valid regex: ${err instanceof Error ? err.message : String(err)}.`);
    }
    return (line) => line.search(re);
  }
  if (/[\r\n]/.test(text)) {
    throw blocked("text must be one line (matches are found line by line); search for one line of it.");
  }
  if (opts.case_sensitive) return (line) => line.indexOf(text);
  const needle = text.toLowerCase();
  return (line) => line.toLowerCase().indexOf(needle);
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The live body a replace edit sees: below the frontmatter, Rules and Decisions sections removed. */
function liveText(node: MindPlanNode): string {
  const split = splitContext(readMarkdown(node, "current"));
  return normalize(withoutOwnedSections(split?.body ?? ""));
}

/** An open revision's body, as a replace edit on that revision sees it. */
function revisionText(node: MindPlanNode, change: string): string {
  return normalize(loadRevision(node, change).body);
}

/** How many non-overlapping times `needle` occurs in `text` (as replace counts them). */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The `## ` heading each line sits under (a heading inside fenced code is code), or null. */
function sectionsOf(lines: string[]): (string | null)[] {
  const out: (string | null)[] = [];
  let current: string | null = null;
  let fence: string | null = null;
  for (const line of lines) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
    } else if (fence === null && /^## /.test(line)) {
      current = line.trim();
    }
    out.push(current);
  }
  return out;
}

/**
 * The shortest run of whole lines around line `at` that occurs exactly once in `text`: the line
 * alone, then one more line at a time, alternating after and before. When no run is unique, the
 * whole text comes back with its count.
 */
function uniqueSnippet(text: string, lines: string[], at: number): { snippet: string; occurrences: number } {
  let start = at;
  let end = at;
  let after = true;
  for (;;) {
    const snippet = lines.slice(start, end + 1).join("\n");
    // An empty run (a blank line) is no find; grow it.
    const count = snippet.trim().length > 0 ? occurrences(text, snippet) : 0;
    if (count === 1) return { snippet, occurrences: 1 };
    const canAfter = end < lines.length - 1;
    const canBefore = start > 0;
    if (!canAfter && !canBefore) return { snippet, occurrences: count };
    if ((after && canAfter) || !canBefore) end++;
    else start--;
    after = !after;
  }
}

/** A long line cut to about MAX_LINE_CHARS around the match at `index`. */
function cutLine(line: string, index: number): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const from = Math.max(0, Math.min(index - 60, line.length - MAX_LINE_CHARS));
  const to = from + MAX_LINE_CHARS;
  return `${from > 0 ? "…" : ""}${line.slice(from, to)}${to < line.length ? "…" : ""}`;
}

type LineHit = { line: number; section: string | null; match: string; index: number };

/** Every line of `text` the matcher hits (`line` 1-based), with the section it sits under. */
function hits(text: string, test: (line: string) => number): { lines: string[]; found: LineHit[] } {
  const lines = text.split("\n");
  const sections = sectionsOf(lines);
  const found: LineHit[] = [];
  lines.forEach((line, i) => {
    const index = test(line);
    if (index >= 0) found.push({ line: i + 1, section: sections[i], match: line, index });
  });
  return { lines, found };
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

/**
 * The slots find_in_node searches: `current` live only; `next` the open revision `change` names, or
 * the only one (Blocked with none, or several and no change); omitted, live plus the revision
 * `change` names or the only open one (several and no change: live only, with a hint).
 */
function slotsToSearch(
  node: MindPlanNode,
  slot: FindSlot | undefined,
  change: string | undefined
): { slots: SlotText[]; hint?: string } {
  if (slot === "current") return { slots: [{ slot: "current", text: liveText(node) }] };
  const open = openChanges(node);
  if (slot === "next") {
    if (open.length === 0) {
      throw blocked(`"${node.id}" has no open revision; search slot "current", or open_next first.`);
    }
    const picked = resolveRevisionChange(node, change)!;
    return { slots: [{ slot: "next", change: picked, text: revisionText(node, picked) }] };
  }
  const slots: SlotText[] = [{ slot: "current", text: liveText(node) }];
  if (change !== undefined || open.length === 1) {
    const picked = resolveRevisionChange(node, change)!;
    slots.push({ slot: "next", change: picked, text: revisionText(node, picked) });
    return { slots };
  }
  if (open.length > 1) {
    return {
      slots,
      hint: `searched live only; open revisions ${open.map((c) => `"${c}"`).join(", ")}: pass change to search one.`,
    };
  }
  return { slots };
}

export function findInNode(args: {
  node_id: string;
  text: string;
  slot?: FindSlot;
  change?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  limit?: number;
}): Record<string, unknown> {
  const test = lineMatcher(args.text, args);
  const node = findNode(loadGraph(), args.node_id);
  const { slots, hint } = slotsToSearch(node, args.slot, args.change);
  const limit = clampLimit(args.limit, DEFAULT_FIND_IN_NODE_LIMIT, MAX_FIND_IN_NODE_LIMIT);
  const matches: Record<string, unknown>[] = [];
  let total = 0;
  for (const s of slots) {
    const { lines, found } = hits(s.text, test);
    total += found.length;
    for (const hit of found) {
      if (matches.length >= limit) break;
      const snippet = uniqueSnippet(s.text, lines, hit.line - 1);
      matches.push({
        slot: s.slot,
        ...(s.change ? { change: s.change } : {}),
        line: hit.line,
        section: hit.section,
        match: hit.match,
        snippet: snippet.snippet,
        occurrences: snippet.occurrences,
        ...(snippet.occurrences !== 1
          ? { note: "no run of lines around this match is unique in the slot; use replace with all: true, or a section edit." }
          : {}),
      });
    }
  }
  return {
    node_id: node.id,
    text: args.text,
    matches,
    total,
    ...(total > matches.length ? { more: total - matches.length } : {}),
    ...(hint ? { hint } : {}),
  };
}

export function searchGraph(args: {
  text: string;
  regex?: boolean;
  case_sensitive?: boolean;
  type?: NodeType;
  limit?: number;
}): Record<string, unknown> {
  const test = lineMatcher(args.text, args);
  if (args.type !== undefined && !(NODE_TYPES as readonly string[]).includes(args.type)) {
    throw blocked(`unknown type "${args.type}". Allowed: ${NODE_TYPES.join(", ")}.`);
  }
  const limit = clampLimit(args.limit, DEFAULT_SEARCH_GRAPH_LIMIT, MAX_SEARCH_GRAPH_LIMIT);
  const nodes = loadGraph()
    .nodes.filter((n) => !isRetired(n) && (args.type === undefined || n.type === args.type))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const matches: Record<string, unknown>[] = [];
  let total = 0;
  for (const node of nodes) {
    const slots: SlotText[] = [{ slot: "current", text: liveText(node) }];
    for (const change of openChanges(node)) slots.push({ slot: "next", change, text: revisionText(node, change) });
    for (const s of slots) {
      const { found } = hits(s.text, test);
      total += found.length;
      for (const hit of found) {
        if (matches.length >= limit) break;
        matches.push({
          node_id: node.id,
          type: node.type,
          slot: s.slot,
          ...(s.change ? { change: s.change } : {}),
          line: hit.line,
          section: hit.section,
          match: cutLine(hit.match, hit.index),
        });
      }
    }
  }
  return {
    text: args.text,
    matches,
    total,
    ...(total > matches.length ? { more: total - matches.length } : {}),
  };
}
