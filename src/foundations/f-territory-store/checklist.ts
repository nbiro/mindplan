/**
 * Checklist items: the task-list lines of a node's Atomic Ops (a Foundation's Checklist, a Bug's
 * Fix Checklist). An item may end with a tag `{#<id>}` or `{#<id> <kind>}` before any
 * ` — note:` / ` — n/a:` annotation: the id is a lowercase slug, stable across rewording, and the
 * kind says who closes it — `build` (the default: the agent building it), `review` (a person
 * reviewing it), or `deploy` (a person deploying it).
 */

export const CHECKLIST_KINDS = ["build", "review", "deploy"] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];

export function isChecklistKind(value: string): value is ChecklistKind {
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
  /** Position among the items. */
  index: number;
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
const ITEM_LINE = /^(\s*[-*+]\s+)\[([ xX])\](?:\s+(.*))?$/;
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
export function formatChecklistLine(item: NewChecklistItem, checked = false): string {
  const tag = formatChecklistTag(item.id, item.kind);
  return `- [${checked ? "x" : " "}] ${item.text}${tag ? ` ${tag}` : ""}`;
}

/** True for a lowercase slug id. */
export function isChecklistId(id: string): boolean {
  return ID.test(id);
}

/** A lowercase slug of `text`, for an item given a kind but no id. */
export function slugifyChecklistText(text: string): string {
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
  const headings: { index: number; name: string }[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      if (fence === null) fence = f[1];
      else if (fence === f[1]) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) headings.push({ index, name: m[1].trim().toLowerCase() });
  });
  const ranges: [number, number][] = [];
  headings.forEach((h, i) => {
    if (!CHECKLIST_SECTIONS.includes(h.name)) return;
    ranges.push([h.index + 1, i + 1 < headings.length ? headings[i + 1].index : lines.length]);
  });
  return ranges;
}

function parseLine(line: string, lineIndex: number, index: number): ChecklistItem | null {
  const m = line.match(ITEM_LINE);
  if (!m) return null;
  const checked = m[2] !== " ";
  const rest = (m[3] ?? "").replace(/\s+$/, "");
  const emptyNa = checked && EMPTY_NA.test(` ${rest}`);
  let text = rest.replace(ANNOTATION, "").replace(/\s+—\s+n\/a:\s*$/, "");
  let id: string | undefined;
  let kind: ChecklistKind = "build";
  const tag = text.match(TAG);
  if (tag && (tag[2] === undefined || isChecklistKind(tag[2]))) {
    id = tag[1];
    if (tag[2]) kind = tag[2] as ChecklistKind;
    text = text.slice(0, tag.index);
  }
  return { ...(id ? { id } : {}), kind, text: text.trim(), checked, done: checked && !emptyNa, line: lineIndex, index };
}

/** The checklist items of a body (or a whole MDX file): task-list lines under its checklist sections. */
export function parseChecklistItems(body: string): ChecklistItem[] {
  const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const items: ChecklistItem[] = [];
  for (const [start, end] of checklistRanges(lines)) {
    for (let i = start; i < end; i++) {
      const item = parseLine(lines[i], i, items.length);
      if (item) items.push(item);
    }
  }
  return items;
}

/** `"Spec written" {#spec}, "Review copy" {#copy review}` — the items a Blocked names. */
export function describeChecklistItems(items: ChecklistItem[]): string {
  if (items.length === 0) return "(none)";
  return items
    .map((i) => `"${i.text}"${i.id ? ` ${formatChecklistTag(i.id, i.kind)}` : i.kind !== "build" ? ` (${i.kind})` : ""}`)
    .join(", ");
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function oneLine(value: string, field: string): string {
  const text = value.replace(/\s*\r?\n\s*/g, " ").trim();
  if (!text) throw new Error(`Blocked: toggle_checkboxes ${field} must be non-empty.`);
  return text;
}

/**
 * Toggle checklist items by id or exact text. Only the checklist sections' items match; a text
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
  const lines = body.split(/\r?\n/);
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

    const items = parseChecklistItems(lines.join("\n"));
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
      let line = lines[hit.line].replace(
        /^(\s*[-*+]\s+)\[[ xX]\]/,
        (_, prefix) => `${prefix}[${checked ? "x" : " "}]`
      );
      // Unticking drops an annotation; a new annotation replaces the old one.
      if (!checked || suffix !== null) line = line.replace(ANNOTATION, "").replace(/\s+—\s+n\/a:\s*$/, "");
      if (suffix !== null) line = `${line.replace(/\s+$/, "")}${suffix}`;
      lines[hit.line] = line;
      toggled.push(line.trim());
    }
  }
  return { body: lines.join(eol), toggled };
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
  const lines = body.split(/\r?\n/);
  const ranges = checklistRanges(lines);
  if (ranges.length === 0) {
    throw new Error('Blocked: add_checklist_items needs a "## Atomic Ops" section in the slot; add one with section or body first.');
  }
  const existing = parseChecklistItems(body);
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
  // After the section's last item (or its heading when it has none).
  const [start, end] = ranges[0];
  let at = start;
  for (let i = start; i < end; i++) if (ITEM_LINE.test(lines[i])) at = i + 1;
  if (at === start) {
    const insert = ["", ...added, ...(lines[start] === undefined || lines[start].trim() === "" ? [] : [""])];
    // Keep one blank line under the heading.
    const skip = lines[start]?.trim() === "" ? 1 : 0;
    const block = skip ? [...added, ...(lines[start + 1]?.trim() ? [""] : [])] : insert;
    lines.splice(start + skip, 0, ...block);
  } else {
    lines.splice(at, 0, ...added);
  }
  return { body: lines.join(eol), added };
}
