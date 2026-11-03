### d-neighbor-cleanup-by-before-after

- Decision: Neighbor labels are cleared by one wrapper around every write that can end a change membership, which compares the changes with open revisions before and after the write and clears the labels of each change that lost its last revision.
- Alternatives:
  - Call the cleanup from each handler path that ends a membership (eight call sites; a new path that forgets it leaves stale labels, and a scoped walk reloads the graph at every step)
  - Validate labels when reading neighbors, ignoring those whose change has no revisions (a neighbor-only change has no revisions by design, so it would lose its neighbors)
- Why: A neighbor-only change is legitimate, so only an event (a change losing its last revision during a call) can tell an orphaned label apart; checking it once per call covers every write path and costs two graph loads instead of one per step.
- Consequences: A new write tool that can end a membership must run inside withNeighborCleanup; the store keeps the invariant that an open revision's live label names its own change, so discard_next needs no special case.
- Change: shipped-claims-and-neighbors
- Date: 2026-10-25
