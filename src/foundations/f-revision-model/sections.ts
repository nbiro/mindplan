/**
 * The one section scanner every body reader shares: line endings, fenced code, level-2 headings,
 * and the sections the store owns (`## Rules`, `## Decisions`). A `## ` line inside a fenced code
 * block is code, never a heading. Pure: no module-level state, no file I/O.
 */

/** Key of the text above a body's first level-2 heading. */
export const PREAMBLE_SECTION = "_preamble";

/** A fence-like line: its run of three or more backticks or tildes, then the rest of the line. */
const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;
const LEVEL_TWO_LINE = /^##\s+(.+?)\s*$/;
const RULES_HEADING_LINE = /^## Rules[ \t]*$/;
const DECISIONS_HEADING_LINE = /^## Decisions[ \t]*$/;
/** A level-1 or level-2 heading: where an owned section ends. */
const SECTION_BREAK_LINE = /^#{1,2}[ \t]/;

/** CRLF when the text has any, else LF. */
export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Text as compared and rejoined: LF line endings, trailing whitespace dropped. */
export function normalizedText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Per line: inside a fenced code block (fence lines included). As in CommonMark, a fence opens on
 * three or more backticks or tildes (a backtick fence's info string holds no backtick) and closes
 * only on a run of the same char at least as long with nothing after it but whitespace; any other
 * fence-like line inside is code.
 */
export function fencedLines(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((raw) => {
    const f = raw.replace(/\r$/, "").match(FENCE_LINE);
    if (fence === null) {
      if (!f || (f[1][0] === "`" && f[2].includes("`"))) return false;
      fence = f[1];
      return true;
    }
    if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === "") fence = null;
    return true;
  });
}

/** Level-2 heading lines outside fenced code, by line index; `name` is the heading text trimmed. */
export function levelTwoHeadings(lines: string[]): { index: number; name: string }[] {
  const fenced = fencedLines(lines);
  const headings: { index: number; name: string }[] = [];
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const m = line.replace(/\r$/, "").match(LEVEL_TWO_LINE);
    if (m) headings.push({ index, name: m[1] });
  });
  return headings;
}

/**
 * A body's level-2 sections in order, each with its exact text from its heading line up to the
 * next level-2 heading (so the texts concatenate back to the body). Text above the first heading
 * is a `_preamble` entry when not empty. A repeated heading is keyed `<heading> (2)`, `(3)`, … so
 * keys stay unique.
 */
export function splitSections(body: string): { heading: string; text: string }[] {
  const lines = body.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const raw of lines) {
    offsets.push(offset);
    offset += raw.length + 1;
  }
  const seen = new Map<string, number>();
  const starts = levelTwoHeadings(lines).map((h) => {
    const base = `## ${h.name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { offset: offsets[h.index], heading: count === 1 ? base : `${base} (${count})` };
  });
  const out: { heading: string; text: string }[] = [];
  const first = starts.length ? starts[0].offset : body.length;
  if (first > 0) out.push({ heading: PREAMBLE_SECTION, text: body.slice(0, first) });
  starts.forEach((s, i) => {
    out.push({ heading: s.heading, text: body.slice(s.offset, i + 1 < starts.length ? starts[i + 1].offset : body.length) });
  });
  return out;
}

/** Section texts rejoined with one blank line between them (empty ones dropped), in `eol`. */
export function joinSections(texts: string[], eol: string): string {
  const parts = texts.map(normalizedText).filter((t) => t.length > 0);
  return parts.length ? `${parts.join("\n\n")}\n`.replace(/\n/g, eol) : "";
}

/**
 * Line range `[start, end)` of the first section whose heading line matches `heading`, up to the
 * next level-1/2 heading. With `fenced`, a line inside fenced code is neither heading nor boundary.
 */
function firstSectionRange(lines: string[], heading: RegExp, fenced?: boolean[]): [number, number] | null {
  const start = lines.findIndex((line, i) => !fenced?.[i] && heading.test(line.replace(/\r$/, "")));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (fenced?.[end] || !SECTION_BREAK_LINE.test(lines[end]))) end++;
  return [start, end];
}

/** The first `## Rules` section of `lines` (fenced code not considered), or null. */
export function rulesSectionRange(lines: string[]): [number, number] | null {
  return firstSectionRange(lines, RULES_HEADING_LINE);
}

/** The first `## Decisions` section of `lines` outside fenced code, or null. */
export function decisionsSectionRange(lines: string[]): [number, number] | null {
  return firstSectionRange(lines, DECISIONS_HEADING_LINE, fencedLines(lines));
}

/**
 * Per line: inside a section the store owns apart from the node's text: the first `## Rules`
 * section, then, in what remains, the first `## Decisions` section outside fenced code. Exactly
 * what the store's `withoutOwnedSections` strips.
 */
export function ownedLines(lines: string[]): boolean[] {
  const owned = lines.map(() => false);
  const rules = rulesSectionRange(lines);
  if (rules) for (let i = rules[0]; i < rules[1]; i++) owned[i] = true;
  const rest = lines.map((_, i) => i).filter((i) => !owned[i]);
  const decisions = decisionsSectionRange(rest.map((i) => lines[i]));
  if (decisions) for (let k = decisions[0]; k < decisions[1]; k++) owned[rest[k]] = true;
  return owned;
}
