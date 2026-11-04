### d-migrate-strip-change-labels

- Decision: Migration level 2 strips the change scalar (and any change_ref) from every shipped, non-retired node with no open next and reports each { node_id, change } in staleChangeLabelsCleared; it runs on every upgrade (idempotent, a no-op once no label exists).
- Alternatives:
  - Clear only labels whose change has no open revision (labels no longer exist as a concept, so a live one is as meaningless as a stale one)
  - Rename the report field to changeLabelsCleared (0.15.0 is unreleased, but the existing name already reached tests and docs; keeping it avoids churn)
- Why: With labels removed, any change scalar on such a node is leftover state; stripping all of them makes the invariant hold, and an old branch merged later is cleaned on the next upgrade instead of keeping its labels.
- Supersedes: d-migrate-stale-change-labels
- Change: graph-edges-stale-labels
- Date: 2026-10-31
