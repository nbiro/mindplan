### d-migrate-strip-all-live-labels

- Decision: Migration level 2 strips the live change and change_ref from every shipped, non-retired pipeline node, with or without an open next, and reports each { node_id, change } in staleChangeLabelsCleared; it runs on every upgrade.
- Alternatives:
  - Only nodes with no open next (open_next before 0.15.0 left the label on live beside the revision; after a discard that label could no longer be cleared, since change on such a node is Blocked)
  - Also make discard_next drop a live change (covers only that path; the migration already makes the invariant hold everywhere)
- Why: A shipped node's live change is never read while a revision is open (activeChange and promotion use the next slot's), so stripping it everywhere is safe and closes the gap the review found.
- Supersedes: d-migrate-strip-change-labels
- Change: graph-edges-stale-labels
- Date: 2026-10-31
