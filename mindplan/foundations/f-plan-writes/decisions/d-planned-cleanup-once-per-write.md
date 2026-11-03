### d-planned-cleanup-once-per-write

- Decision: Planned edges of a change are dropped by one wrapper (withChangeCleanup) around every write that can end a change's last open revision, comparing the changes with open revisions before and after the write; it no longer touches labels.
- Alternatives:
  - Delete the wrapper with the labels and drop planned edges in each closing path (eight call sites; one forgotten path leaves planned wiring for a closed change)
- Why: Planned edges still close with their change, and the before/after comparison is still the only event that tells a closed change apart.
- Supersedes: d-neighbor-cleanup-once-per-write
- Change: graph-edges-stale-labels
- Date: 2026-10-31
