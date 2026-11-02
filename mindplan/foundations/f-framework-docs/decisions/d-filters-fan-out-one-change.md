### d-filters-fan-out-one-change

- Decision: Graph filters and the fan-out warning ship as one change (graph-filters-fan-out) with one docs revision and one 0.14.0 release.
- Alternatives:
  - Two changes in sequence (a shipped node holds one open revision, so the second feature's docs revision would wait for the first to ship)
- Why: Both features edit SPEC and the skills; the owner chose one PR over sequencing the docs revision.
- Change: graph-filters-fan-out
- Date: 2026-10-31
