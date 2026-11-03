### d-no-neighbor-labels

- Decision: A node's change id belongs to an open revision only (the next slot's, or a pre-ship node's live change); a shipped node with no open next carries no change id, and editing its files in place needs none.
- Alternatives:
  - Keep neighbor labels and fix how they clear (stored state that every write path must set, replace, and clear; the stale-label bug came from exactly that, and the label bought only a full stale-text pass and listings)
  - Keep the label but ignore it everywhere except the change check (dead state on disk that agents would still be told to write)
- Why: Editing a shipped node's files is already legal and the plain check already runs import and ownership rules on every node's files; the only real benefit (a full stale-text pass on files the change touched) can be derived from the git diff instead of stored.
- Consequences: A change's members are its open revisions and planned sources; in-place edits are invisible to change-scoped tools. Migration level 2 strips existing labels. change on a shipped node with no open next is Blocked.
- Supersedes: d-neighbor-label-in-live-change
- Change: graph-edges-stale-labels
- Date: 2026-10-31
