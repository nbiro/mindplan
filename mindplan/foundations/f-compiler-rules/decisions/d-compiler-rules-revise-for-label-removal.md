### d-compiler-rules-revise-for-label-removal

- Decision: This revision reopens f-compiler-rules to delete changeNeighbors and the neighbor half of change membership and additivity.
- Alternatives:
  - A new node that depends_on f-compiler-rules (membership is defined here; a dependent cannot remove a kind from it)
- Why: The revision only removes code; the hotspot's split advice targets added responsibilities, and this shrinks one.
- Change: graph-edges-stale-labels
- Date: 2026-10-31
