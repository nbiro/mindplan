/**
 * Checklist items: every task-list line the Completion Check counts — the whole body (or MDX
 * file) except the sections the node owns apart from its text (`## Rules`, `## Decisions`). Most
 * live under Atomic Ops (a Foundation's Checklist, a Bug's Fix Checklist), but an Acceptance
 * Criteria box counts the same. An item may end with a tag `{#<id>}` or `{#<id> <kind>}` before any
 * ` — note:` / ` — n/a:` annotation: the id is a lowercase slug, stable across rewording, and the
 * kind says who closes it — `build` (the default: the agent building it), `review` (a person
 * reviewing it), or `deploy` (a person deploying it).
 */

import { detectEol, fenceBlockEnds, fencedLines, levelTwoHeadings, ownedLines } from "../f-revision-model/index.js";

const CHECKLIST_KINDS = ["build", "review", "deploy"] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];

function isChecklistKind(value: string): value is ChecklistKind {
  return (CHECKLIST_KINDS as readonly string[]).includes(value);
}

export type ChecklistItem = {
  id?: string;
  kind: ChecklistKind;
  /** The item's wording: tag and annotation excluded, whitespace-trimmed. */
  text: string;
  /** The box is ticked. */
  checked: boolean;
  /** Ticked and not an n/a without a reason (what the Completion Check counts as done). */
  done: boolean;
  /** 0-based line index in the text parsed. */
  line: number;
  /** The `## ` heading the item sits under (as written, trimmed); empty above the first heading. */
  section: string;
};

/** One checkbox toggle: an item by `id`, or by its exact text (`contains`). */
export type CheckboxToggle = {
  /** The item's id (its `{#id}` tag). */
  id?: string;
  /** The item's full text, tag and annotation excluded (exact match, whitespace-trimmed). */
  contains?: string;
  /** true for [x], false for [ ]. Defaults to true when `note` or `not_applicable` is set. */
  checked?: boolean;
  /** Toggle every item with that exact text instead of Blocking on several. */
  all?: boolean;
  /** Tick with a note: appends ` — note: <text>`. */
  note?: string;
  /** Tick as not applicable: appends ` — n/a: <reason>`. */
  not_applicable?: string;
};

/** One item to append with `add_checklist_items`. */
export type NewChecklistItem = { text: string; id?: string; kind?: ChecklistKind };

const CHECKLIST_SECTIONS = ["atomic ops", "checklist", "fix checklist"];
/** A task-list line, as the Completion Check counts it (`countCheckboxesInText`). */
const ITEM_LINE = /^(\s*[-*+]\s+)\[([ xX])\](.*)$/;
/** A trailing annotation written by a toggle: ` — note: …` or ` — n/a: …`. */
const ANNOTATION = /\s+—\s+(?:note|n\/a):.*$/;
const EMPTY_NA = /\s—\s+n\/a:\s*$/;
const TAG = /\s*\{#([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([a-z]+))?\}\s*$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The `{#id}` / `{#id kind}` tag for an item; empty when it has no id. */
export function formatChecklistTag(id: string | undefined, kind: ChecklistKind = "build"): string {
  if (!id) return "";
  return kind === "build" ? `{#${id}}` : `{#${id} ${kind}}`;
}

/** An item's markdown line: `- [ ] <text> {#id kind}`. */
function formatChecklistLine(item: NewChecklistItem, checked = false): string {
  const tag = formatChecklistTag(item.id, item.kind);
  return `- [${checked ? "x" : " "}] ${item.text}${tag ? ` ${tag}` : ""}`;
}

/** True for a lowercase slug id. */
function isChecklistId(id: string): boolean {
  return ID.test(id);
}

/** A lowercase slug of `text`, for an item given a kind but no id. */
function slugifyChecklistText(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "item"
  );
}

/** Line ranges `[start, end)` (heading excluded) of the checklist sections in `lines`. */
function checklistRanges(lines: string[]): [number, number][] {
  const headings = levelTwoHeadings(lines);
  const ranges: [number, number][] = [];
  headings.forEach((h, i) => {
    if (!CHECKLIST_SECTIONS.includes(h.name.toLowerCase())) return;
    ranges.push([h.index + 1, i + 1 < headings.length ? headings[i + 1].index : lines.length]);
  });
  return ranges;
}

function parseLine(line: string, lineIndex: number, section: string): ChecklistItem | null {
  const m = line.match(ITEM_LINE);
  if (!m) return null;
  const checked = m[2] !== " ";
  const rest = (m[3] ?? "").trim();
  const emptyNa = checked && EMPTY_NA.test(` ${rest}`);
  let text = rest.replace(ANNOTATION, "");
  let id: string | undefined;
  let kind: ChecklistKind = "build";
  const tag = text.match(TAG);
  if (tag && (tag[2] === undefined || isChecklistKind(tag[2]))) {
    id = tag[1];
    if (tag[2]) kind = tag[2] as ChecklistKind;
    text = text.slice(0, tag.index);
  }
  return { ...(id ? { id } : {}), kind, text: text.trim(), checked, done: checked && !emptyNa, line: lineIndex, section };
}

/**
 * The checklist items of a body (or a whole MDX file): every task-list line the Completion Check
 * counts, each with the `## ` section it sits under.
 */
export function parseChecklistItems(body: string): ChecklistItem[] {
  return itemsOfLines(splitLines(body).lines);
}

/**
 * The checklist items of `lines` (see parseChecklistItems); each item's `line` indexes `lines`.
 * The sections the store owns are skipped exactly as `withoutOwnedSections` strips them.
 */
function itemsOfLines(lines: string[]): ChecklistItem[] {
  const owned = ownedLines(lines);
  const fenced = fencedLines(lines);
  const items: ChecklistItem[] = [];
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    // A line inside a fenced code block is example text: neither a heading nor an item.
    if (owned[i] || fenced[i]) continue;
    const heading = lines[i].match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const item = parseLine(lines[i], i, section);
    if (item) items.push(item);
  }
  return items;
}

/** `"Spec written" {#spec}, "Review copy" {#copy review}` — the items a Blocked names. */
function describeChecklistItems(items: ChecklistItem[]): string {
  if (items.length === 0) return "(none)";
  return items
    .map((i) => `"${i.text}"${i.id ? ` ${formatChecklistTag(i.id, i.kind)}` : i.kind !== "build" ? ` (${i.kind})` : ""}`)
    .join(", ");
}

/**
 * The one line splitter parse and edit share: every CRLF, LF, or lone CR ends a line, and
 * `breaks[i]` keeps the break that followed `lines[i]`, so a write puts each one back as it was.
 */
function splitLines(text: string): { lines: string[]; breaks: string[] } {
  const lines: string[] = [];
  const breaks: string[] = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    lines.push(text.slice(last, m.index));
    breaks.push(m[0]);
    last = m.index + m[0].length;
  }
  lines.push(text.slice(last));
  return { lines, breaks };
}

/** `lines` joined with their own breaks; a line without one (an inserted line) takes `eol`. */
function joinLines(lines: string[], breaks: string[], eol: string): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) out += i < lines.length - 1 ? lines[i] + (breaks[i] ?? eol) : lines[i];
  return out;
}

function oneLine(value: string, field: string): string {
  const text = value.replace(/\s*\r?\n\s*/g, " ").trim();
  if (!text) throw new Error(`Blocked: toggle_checkboxes ${field} must be non-empty.`);
  return text;
}

/**
 * Toggle checklist items by id or exact text. Every box the Completion Check counts matches (any
 * section but Rules and Decisions); a text
 * that is not exactly one item's (tag and annotation excluded) is Blocked, naming the items. Text
 * matching several items is Blocked unless the toggle passes `all`. A note or not-applicable
 * reason is appended to the line, so the item's own wording never changes; unticking strips it.
 * Returns the new body and the lines as written.
 */
export function toggleChecklistItems(
  body: string,
  toggles: CheckboxToggle[]
): { body: string; toggled: string[] } {
  const eol = detectEol(body);
  const { lines, breaks } = splitLines(body);
  const toggled: string[] = [];
  for (const toggle of toggles) {
    const label = toggle.id !== undefined ? `id "${toggle.id}"` : `"${toggle.contains}"`;
    if ((toggle.id === undefined) === (toggle.contains === undefined)) {
      throw new Error("Blocked: a toggle takes id or contains (an item's exact text), exactly one of them.");
    }
    if (toggle.note !== undefined && toggle.not_applicable !== undefined) {
      throw new Error("Blocked: a toggle takes note or not_applicable, not both.");
    }
    const annotated = toggle.note !== undefined || toggle.not_applicable !== undefined;
    const checked = toggle.checked ?? (annotated ? true : undefined);
    if (checked === undefined) {
      throw new Error(`Blocked: toggle for ${label} needs checked (true or false).`);
    }
    if (!checked && annotated) {
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

    const items = itemsOfLines(lines);
    let hits: ChecklistItem[];
    if (toggle.id !== undefined) {
      hits = items.filter((i) => i.id === toggle.id);
      if (hits.length === 0) {
        throw new Error(`Blocked: no item with id "${toggle.id}"; items: ${describeChecklistItems(items)}.`);
      }
    } else {
      const want = toggle.contains!.trim();
      hits = items.filter((i) => i.text === want);
      if (hits.length === 0) {
        throw new Error(
          `Blocked: no item with that exact text ("${want}"); items: ${describeChecklistItems(items)}. ` +
            "Pass an item's id, or its full text without tag or annotation."
        );
      }
      if (hits.length > 1 && !toggle.all) {
        throw new Error(
          `Blocked: "${want}" matches ${hits.length} items; pass an id, or all: true. Matches:\n` +
            hits.map((i) => `- ${lines[i.line].trim()}`).join("\n")
        );
      }
    }
    for (const hit of hits) {
      if (lines[hit.line] === undefined) {
        throw new Error(`Blocked: toggle for ${label} names line ${hit.line + 1}, which the slot does not have; nothing was written.`);
      }
      let line = lines[hit.line].replace(
        /^(\s*[-*+]\s+)\[[ xX]\]/,
        (_, prefix) => `${prefix}[${checked ? "x" : " "}]`
      );
      // Unticking drops an annotation; a new annotation replaces the old one.
      if (!checked || suffix !== null) line = line.replace(ANNOTATION, "");
      if (suffix !== null) line = `${line.replace(/\s+$/, "")}${suffix}`;
      lines[hit.line] = line;
      toggled.push(line.trim());
    }
  }
  return { body: joinLines(lines, breaks, eol), toggled };
}

/**
 * Appends unticked items to the first checklist section of `body`. Ids are unique per slot
 * (Blocked on a duplicate, within the batch too); an item given a non-build kind and no id gets
 * one slugged from its text. Blocked when the body has no Atomic Ops section.
 */
export function appendChecklistItems(
  body: string,
  items: NewChecklistItem[]
): { body: string; added: string[] } {
  const eol = detectEol(body);
  const { lines, breaks } = splitLines(body);
  const ranges = checklistRanges(lines);
  if (ranges.length === 0) {
    throw new Error('Blocked: add_checklist_items needs a "## Atomic Ops" section in the slot; add one with section or body first.');
  }
  const existing = itemsOfLines(lines);
  const ids = new Set(existing.flatMap((i) => (i.id ? [i.id] : [])));
  const added: string[] = [];
  for (const raw of items) {
    const text = raw.text.replace(/\s*\r?\n\s*/g, " ").trim();
    if (!text) throw new Error("Blocked: add_checklist_items text must be non-empty.");
    if (/\{#/.test(text) || /\s—\s+(?:note|n\/a):/.test(text)) {
      throw new Error(`Blocked: add_checklist_items text "${text}" carries a tag or annotation; pass id and kind as fields.`);
    }
    const kind = raw.kind ?? "build";
    if (!isChecklistKind(kind)) {
      throw new Error(`Blocked: invalid checklist kind "${kind}". Valid: ${CHECKLIST_KINDS.join(", ")}.`);
    }
    let id = raw.id?.trim() || undefined;
    if (id !== undefined && !isChecklistId(id)) {
      throw new Error(`Blocked: checklist id "${id}" must be a lowercase slug (a-z, 0-9, hyphens).`);
    }
    if (id !== undefined && ids.has(id)) {
      throw new Error(`Blocked: checklist id "${id}" is already used in this slot; items: ${describeChecklistItems(existing)}.`);
    }
    if (id === undefined && kind !== "build") {
      const base = slugifyChecklistText(text);
      id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    }
    if (id !== undefined) ids.add(id);
    added.push(formatChecklistLine({ text, id, kind }));
  }
  // After the section's last item (or its heading when it has none); a task line inside fenced
  // code is example text, not an item, so new items never land inside a fence.
  const [start, end] = ranges[0];
  const fenceEnds = fenceBlockEnds(lines);
  const fenced = fenceEnds.map((e) => e >= 0);
  let at = start;
  let contentColumn = -1;
  for (let i = start; i < end; i++) {
    const m = fenced[i] ? null : lines[i].match(ITEM_LINE);
    if (m) {
      at = i + 1;
      contentColumn = itemContentColumn(m[1]);
    }
  }
  if (contentColumn >= 0) at = afterContinuation(lines, fenceEnds, at, end, contentColumn);
  if (at === start) {
    const insert = ["", ...added, ...(lines[start] === undefined || lines[start].trim() === "" ? [] : [""])];
    // Keep one blank line under the heading.
    const skip = lines[start]?.trim() === "" ? 1 : 0;
    const block = skip ? [...added, ...(lines[start + 1]?.trim() ? [""] : [])] : insert;
    lines.splice(start + skip, 0, ...block);
    breaks.splice(start + skip, 0, ...block.map(() => eol));
  } else {
    lines.splice(at, 0, ...added);
    breaks.splice(at, 0, ...added.map(() => eol));
  }
  return { body: joinLines(lines, breaks, eol), added };
}

/** A heading, or a list item marker: ends the item when indented less than its content column. */
const CONTINUATION_BREAK = /^(?:#{1,6}[ \t]|[ \t]*(?:[-*+]|\d+[.)])[ \t])/;
/** A thematic break (`---`, `***`, `___`, spaces allowed between): never a lazy continuation. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** The column `prefix` (whitespace and a marker) ends at, tabs expanded to 4-column tab stops (CommonMark). */
function columnOf(prefix: string): number {
  let col = 0;
  for (const ch of prefix) col = ch === "	" ? col + 4 - (col % 4) : col + 1;
  return col;
}

/** A line's indentation in columns, tabs expanded to 4-column tab stops. */
function indentColumn(line: string): number {
  return columnOf(line.slice(0, line.length - line.trimStart().length));
}

/**
 * The content column of a list item whose leading indent, marker, and following whitespace are
 * `lead` (CommonMark, tabs to 4-column stops): the marker's end plus the whitespace after it, or
 * plus one column when five or more follow (the item then starts with indented code).
 */
function itemContentColumn(lead: string): number {
  const markerEnd = indentColumn(lead) + 1;
  const end = columnOf(lead);
  return end - markerEnd > 4 ? markerEnd + 1 : end;
}

/**
 * The line index just past the continuation lines of the item that ends before `from` (its content
 * column `contentColumn`, as `itemContentColumn` gives it), within `[from, end)`: lines indented to
 * the content column (blank lines between them included), lazy lines straight after it, and fenced
 * code indented to the content column, consumed whole to its closing fence. A heading, a list item
 * or thematic break indented less than the content column, a fence indented less, or a line
 * indented less after a blank line ends it (as in CommonMark, a thematic break or a fence is never
 * a lazy line). The index returned is never inside fenced code: a fence that runs past `end` ends
 * the scan before it. `fenceEnds` is `fenceBlockEnds(lines)`.
 */
function afterContinuation(lines: string[], fenceEnds: number[], from: number, end: number, contentColumn: number): number {
  let last = from;
  for (let j = from; j < end; j++) {
    const line = lines[j];
    if (line.trim() === "") continue;
    const inside = indentColumn(line) >= contentColumn;
    const afterBlank = j > last;
    // `j` is never inside a fence here: the item line before `from` is outside one, and a fence
    // reached is either skipped whole or ends the scan.
    if (fenceEnds[j] >= 0) {
      if (!inside || fenceEnds[j] > end) break;
      last = fenceEnds[j];
      j = last - 1;
      continue;
    }
    if (CONTINUATION_BREAK.test(line) && !inside) break;
    if (THEMATIC_BREAK.test(line) && !inside) break;
    if (inside || !afterBlank) {
      last = j + 1;
      continue;
    }
    break;
  }
  return last;
}
