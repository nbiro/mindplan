### d-neighbor-cleanup-once-per-write

- Decision: Neighbor labels are cleared by one wrapper (withNeighborCleanup) around every write that can end a change membership, comparing the changes with open revisions before and after the write (carried over from d-neighbor-cleanup-by-before-after on the deprecated i-steer-plan).
- Alternatives:
  - Call the cleanup from each handler path that ends a membership (eight call sites across several actions; a new path that forgets it leaves stale labels)
  - Validate labels when reading neighbors (a neighbor-only change has no revisions by design, so it would lose its neighbors)
- Why: Only an event (a change losing its last revision during a call) tells an orphaned label apart, and one wrapper here covers every write action that can end a membership.
- Consequences: A new write action that can end a membership must run inside withNeighborCleanup.
- Change: hotspot-splits
- Date: 2026-10-31
