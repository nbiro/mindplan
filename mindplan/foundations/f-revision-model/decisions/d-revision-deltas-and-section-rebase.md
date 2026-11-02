### d-revision-deltas-and-section-rebase

- Decision: A revision stores edges, claims, and test links as add/remove deltas against live and records a hash of each live scalar and level-2 section at open; shipping one revision rebases its siblings per section (untouched carries live, both-edited becomes a conflict resolved by resolve_conflict before in-review).
- Alternatives:
  - Full snapshots per revision (the second ship silently reverts the first one's edges and claims)
  - Line-level three-way merge (needs stored base text and a merge engine; section granularity matches how territory is edited)
- Why: Deltas commute when they touch different targets, and a section hash is enough to tell untouched from edited without keeping base text.
- Consequences: Two revisions that edit the same section always conflict, even when the edits do not overlap.
- Change: multi-revisions
- Date: 2026-11-02
