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
  resolveRevisionChange,
  revisionFor,
  withRevision,
} from "./revision.js";
export {
  PREAMBLE_SECTION,
  rebase,
  scalarHashes,
  sectionHashes,
  splitSections,
  type RebaseInput,
  type RebaseLive,
  type RevisionScalars,
} from "./rebase.js";
