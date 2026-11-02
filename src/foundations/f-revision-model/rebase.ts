/**
 * Section-hash rebase: when one revision of a shipped node ships, every sibling revision is
 * carried onto the new live per level-2 section and per scalar, and its deltas are trimmed to
 * what still changes live. Pure over its arguments: no module-level state, no file I/O.
 */

import { createHash } from "crypto";
import {
  PLANNED_EDGE_TYPES,
  type EdgeDelta,
  type FoundationRole,
  type PlannedEdgeType,
  type Revision,
  type RevisionConflict,
} from "../f-domain-model/types.js";

/** Key of the text above a body's first level-2 heading. */
export const PREAMBLE_SECTION = "_preamble";

/** Sections the store owns (rules, decisions): never hashed, never rebased. */
const OWNED_HEADINGS = new Set(["## Rules", "## Decisions"]);

/** The scalars a revision carries and the rebase compares. */
export type RevisionScalars = { title: string; description: string; role?: FoundationRole };

/** One live side of a rebase: its scalars, body, and (new live only matters) outgoing lists. */
export interface RebaseLive {
  scalars: RevisionScalars;
  body: string;
  /** Live outgoing edges by type; a missing type is empty. */
  edges?: Partial<Record<PlannedEdgeType, string[]>>;
  /** Live claims; missing is empty. */
  implements?: string[];
  /** Live linked tests; missing is empty. */
  tests?: string[];
}

export interface RebaseInput {
  /** Live before the sibling shipped. Its hashes stand in for `revision.base` only when the revision recorded no base scalars. */
  liveOld: RebaseLive;
  /** Live after the sibling shipped. */
  liveNew: RebaseLive & {
    /**
     * Claim entry → id of another node that claims it live now. When given, the revision's
     * claim conflicts are recomputed from it; when omitted, existing claim conflicts are kept.
     */
    implementsOwners?: Map<string, string>;
  };
  revision: Revision;
  /** The revision file's body (frontmatter excluded). */
  revisionBody: string;
  nodeId: string;
}

/**
 * A body's level-2 sections in order, each with its exact text from its heading line up to the
 * next level-2 heading (so the texts concatenate back to the body). Text above the first heading
 * is a `_preamble` entry when not empty. A `## ` line inside a fenced code block is code. A
 * repeated heading is keyed `<heading> (2)`, `(3)`, … so keys stay unique.
 */
export function splitSections(body: string): { heading: string; text: string }[] {
  const starts: { offset: number; heading: string }[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  let offset = 0;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      if (fence === null) fence = f[1];
      else if (fence === f[1]) fence = null;
    } else if (fence === null) {
      const m = line.match(/^##\s+(.+?)\s*$/);
      if (m) {
        const base = `## ${m[1]}`;
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        starts.push({ offset, heading: count === 1 ? base : `${base} (${count})` });
      }
    }
    offset += raw.length + 1;
  }
  const out: { heading: string; text: string }[] = [];
  const first = starts.length ? starts[0].offset : body.length;
  if (first > 0) out.push({ heading: PREAMBLE_SECTION, text: body.slice(0, first) });
  starts.forEach((s, i) => {
    out.push({ heading: s.heading, text: body.slice(s.offset, i + 1 < starts.length ? starts[i + 1].offset : body.length) });
  });
  return out;
}

/** Text as compared: LF line endings, trailing whitespace dropped. */
function normalized(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/** First 8 hex characters of sha1 over the normalized text. */
function hash(text: string): string {
  return createHash("sha1").update(normalized(text)).digest("hex").slice(0, 8);
}

/**
 * Hash of each level-2 section (and the `_preamble`) of a body: the first 8 hex characters of
 * sha1 over the section text with CRLF normalized to LF and trailing whitespace dropped.
 * `## Rules` and `## Decisions` are excluded.
 */
export function sectionHashes(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of splitSections(body)) {
    if (!OWNED_HEADINGS.has(s.heading)) out[s.heading] = hash(s.text);
  }
  return out;
}

/** Hashes of the title, description, and role (a missing role hashes as empty text). */
export function scalarHashes(scalars: RevisionScalars): Record<string, string> {
  return {
    title: hash(scalars.title),
    description: hash(scalars.description),
    role: hash(scalars.role ?? ""),
  };
}

/**
 * The three-way rule per section and scalar: untouched by the revision (its hash equals base) →
 * new live; untouched by live → the revision's; both changed to the same text → the revision's;
 * otherwise the revision's, flagged as a conflict. `undefined` means absent.
 */
function carry<T>(
  base: string | undefined,
  mine: T | undefined,
  mineHash: string | undefined,
  live: T | undefined,
  liveHash: string | undefined
): { value: T | undefined; conflict: boolean } {
  if (mineHash === base) return { value: live, conflict: false };
  if (liveHash === base || mineHash === liveHash) return { value: mine, conflict: false };
  return { value: mine, conflict: true };
}

/** A delta trimmed to what still changes live: adds already live and removes no longer live drop. */
function trimDelta(delta: EdgeDelta, live: string[] | undefined): EdgeDelta {
  const have = new Set(live ?? []);
  return { add: delta.add.filter((v) => !have.has(v)), remove: delta.remove.filter((v) => have.has(v)) };
}

function conflictKey(c: RevisionConflict): string {
  return c.kind === "section" ? `section:${c.section}` : c.kind === "scalar" ? `scalar:${c.field}` : `claim:${c.path}`;
}

/**
 * Carries a sibling revision onto the new live after another revision of the node shipped.
 *
 * Body, per level-2 section (and the `_preamble`): the `carry` rule against `revision.base`.
 * The result keeps the revision body's section order, inserts sections the revision never had
 * that new live added before the revision's first `## Rules` / `## Decisions` section (else at
 * the end), and drops sections live deleted that the revision did not touch. The revision's
 * `## Rules` and `## Decisions` sections pass through unchanged; live's are ignored. Sections are
 * rejoined with one blank line between them, in the revision body's line endings.
 *
 * Scalars (title, description, role): the same rule; a revision with no `role` keeps none.
 * Deltas: an add already in new live and a remove no longer in new live drop silently; an
 * `implements` add another node claims live (`implementsOwners`) becomes a claim conflict.
 * Existing section and scalar conflicts are kept. Every base hash moves to new live.
 * The inputs are never mutated.
 */
export function rebase(input: RebaseInput): { revision: Revision; body: string } {
  const { liveOld, liveNew, revision, revisionBody, nodeId } = input;
  const recorded = Object.keys(revision.base.scalars).length > 0;
  const baseScalars = recorded ? revision.base.scalars : scalarHashes(liveOld.scalars);
  const baseSections = recorded ? revision.base.sections : sectionHashes(liveOld.body);
  const conflicts: RevisionConflict[] = revision.conflicts.filter(
    (c) => c.kind !== "claim" || !liveNew.implementsOwners
  );

  // Body.
  const eol = revisionBody.includes("\r\n") ? "\r\n" : "\n";
  const mineSections = splitSections(revisionBody);
  const liveSections = splitSections(liveNew.body).filter((s) => !OWNED_HEADINGS.has(s.heading));
  const liveText = new Map(liveSections.map((s) => [s.heading, s.text]));
  const mineHeadings = new Set(mineSections.map((s) => s.heading));
  const decide = (heading: string, mine: string | undefined): string | undefined => {
    const live = liveText.get(heading);
    const r = carry(
      baseSections[heading],
      mine,
      mine === undefined ? undefined : hash(mine),
      live,
      live === undefined ? undefined : hash(live)
    );
    if (r.conflict) conflicts.push({ kind: "section", section: heading });
    return r.value;
  };
  const kept: { owned: boolean; text: string }[] = [];
  for (const s of mineSections) {
    if (OWNED_HEADINGS.has(s.heading)) {
      kept.push({ owned: true, text: s.text });
      continue;
    }
    const text = decide(s.heading, s.text);
    if (text !== undefined) kept.push({ owned: false, text });
  }
  const added: { owned: boolean; text: string }[] = [];
  for (const s of liveSections) {
    if (mineHeadings.has(s.heading)) continue;
    const text = decide(s.heading, undefined);
    if (text !== undefined) added.push({ owned: false, text });
  }
  const at = kept.findIndex((k) => k.owned);
  kept.splice(at === -1 ? kept.length : at, 0, ...added);
  const parts = kept.map((k) => normalized(k.text)).filter((t) => t.length > 0);
  const body = parts.length ? `${parts.join("\n\n")}\n`.replace(/\n/g, eol) : "";

  // Scalars.
  const liveScalarHashes = scalarHashes(liveNew.scalars);
  const scalar = <K extends "title" | "description">(field: K): string => {
    const r = carry(baseScalars[field], revision[field], hash(revision[field]), liveNew.scalars[field], liveScalarHashes[field]);
    if (r.conflict) conflicts.push({ kind: "scalar", field });
    return r.value ?? "";
  };
  const title = scalar("title");
  const description = scalar("description");
  let role: FoundationRole | undefined;
  if (revision.role !== undefined) {
    const r = carry(baseScalars.role, revision.role, hash(revision.role), liveNew.scalars.role, liveScalarHashes.role);
    if (r.conflict) conflicts.push({ kind: "scalar", field: "role" });
    role = r.value;
  }

  // Deltas.
  const edges: Revision["edges"] = {};
  for (const type of PLANNED_EDGE_TYPES) {
    const d = revision.edges[type];
    if (!d) continue;
    const t = trimDelta(d, liveNew.edges?.[type]);
    if (t.add.length || t.remove.length) edges[type] = t;
  }
  const implementsDelta = trimDelta(revision.implements, liveNew.implements);
  if (liveNew.implementsOwners) {
    for (const entry of implementsDelta.add) {
      const owner = liveNew.implementsOwners.get(entry);
      if (owner && owner !== nodeId) conflicts.push({ kind: "claim", path: entry, owner });
    }
  }

  const unique = new Map<string, RevisionConflict>();
  for (const c of conflicts) if (!unique.has(conflictKey(c))) unique.set(conflictKey(c), c);

  const out: Revision = {
    ...revision,
    title,
    description,
    edges,
    implements: implementsDelta,
    tests: trimDelta(revision.tests, liveNew.tests),
    base: { scalars: liveScalarHashes, sections: sectionHashes(liveNew.body) },
    conflicts: [...unique.values()],
  };
  if (role === undefined) delete out.role;
  else out.role = role;
  return { revision: out, body };
}
