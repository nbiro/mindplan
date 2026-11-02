### d-docs-check-claimed-imports-skip

- Decision: The docs for check-claimed-imports and skip-blocked-walk ship as one f-framework-docs revision under skip-blocked-walk, in one 0.18.0 release.
- Alternatives:
  - Two docs revisions in sequence (a shipped node holds one open revision, so the second change's docs would wait for the first to ship)
- Why: Both changes edit SPEC and the CHANGELOG in one PR; one revision keeps the release a single docs promotion, as d-filters-fan-out-one-change did.
- Change: skip-blocked-walk
- Date: 2026-11-02
