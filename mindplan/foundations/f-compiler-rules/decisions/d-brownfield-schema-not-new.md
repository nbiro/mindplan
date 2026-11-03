### d-brownfield-schema-not-new

- Decision: A first build's claimed schema file counts as new only when the branch adds it, or when there is no git repository.
- Alternatives:
  - Every schema file a first build claims is new (every brownfield node modeling existing migrations would need a decision)
- Why: Adopting MindPlan on an existing codebase means creating nodes for files that are not new; the gate is for schema changes, not for modeling.
- Change: decision-records
- Date: 2026-10-20
