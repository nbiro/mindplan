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
import { detectEol, joinSections, normalizedText, splitSections } from "./sections.js";

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

/** First 8 hex characters of sha1 over the normalized text. */
function hash(text: string): string {
  return createHash("sha1").update(normalizedText(text)).digest("hex").slice(0, 8);
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

/** A conflict as one short label: `section:## Spec`, `scalar:title`, `claim:<path>@<owner>`. */
export function conflictLabel(c: RevisionConflict): string {
  if (c.kind === "section") return `section:${c.section}`;
  if (c.kind === "scalar") return `scalar:${c.field}`;
  return `claim:${c.path}@${c.owner}`;
}

/** A conflict's identity: its label, with a claim keyed by its path alone (owner dropped). */
function conflictKey(c: RevisionConflict): string {
  return c.kind === "claim" ? `claim:${c.path}` : conflictLabel(c);
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
 * Existing section and scalar conflicts are kept unless new live now reads the revision's text. Every base hash moves to new live.
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
  const eol = detectEol(revisionBody);
  const mineSections = splitSections(revisionBody);
  const liveSections = splitSections(liveNew.body).filter((s) => !OWNED_HEADINGS.has(s.heading));
  const liveText = new Map(liveSections.map((s) => [s.heading, s.text]));
  const mineHeadings = new Set(mineSections.map((s) => s.heading));
  // A conflict kept from an earlier rebase is settled once new live reads what the revision reads.
  const mineText = new Map(mineSections.map((s) => [s.heading, s.text]));
  const hashOf = (text: string | undefined) => (text === undefined ? undefined : hash(text));
  const newLiveScalars = scalarHashes(liveNew.scalars);
  for (let i = conflicts.length - 1; i >= 0; i--) {
    const c = conflicts[i];
    const settled =
      c.kind === "section"
        ? hashOf(mineText.get(c.section)) === hashOf(liveText.get(c.section))
        : c.kind === "scalar"
          ? hash(c.field === "role" ? revision.role ?? "" : revision[c.field]) === newLiveScalars[c.field]
          : false;
    if (settled) conflicts.splice(i, 1);
  }
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
  const body = joinSections(kept.map((k) => k.text), eol);

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
