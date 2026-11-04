/**
 * Revision model (f-revision-model): the pure rules for a shipped node's open revisions. Types
 * live in f-domain-model; this Foundation adds only functions.
 */

export {
  applyDelta,
  diffDelta,
  emptyDelta,
  graphUnder,
  openChanges,
  pickRevision,
  resolveRevisionChange,
  revisionFor,
  splitPartLinked,
  splitParts,
  withRevision,
} from "./revision.js";
export {
  conflictLabel,
  rebase,
  scalarHashes,
  sectionHashes,
  type RebaseInput,
  type RebaseLive,
  type RevisionScalars,
} from "./rebase.js";
export {
  PREAMBLE_SECTION,
  decisionsSectionRange,
  detectEol,
  fenceBlockEnds,
  fencedLines,
  joinSections,
  levelTwoHeadings,
  normalizedText,
  ownedLines,
  rulesSectionRange,
  splitSections,
} from "./sections.js";
