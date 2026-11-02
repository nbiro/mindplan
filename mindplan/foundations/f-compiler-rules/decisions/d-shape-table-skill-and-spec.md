### d-shape-table-skill-and-spec

- Decision: The required sections per type live in one constant (TERRITORY_SHAPE) that the gate, shapeReport, shapeWarning, and shapeTableMarkdown read; the define-entities skill and SPEC embed the generated table between markers, a test fails when an embedded copy differs, and the playbook carries a one-line pointer to shape, the skill, and get_spec.
- Alternatives:
  - Embed the table in the playbook too (the playbook loads every session and is held to one screen with no checklist procedure text; the table broke both)
  - Substitute the table at install and serve time (the template files and SPEC.md readers outside MCP would not show it)
  - Keep the sections inline in the gate and document them by hand (the drift that made agents learn the shape one Blocked at a time)
- Why: Agents read the skill and get_spec when they create nodes; generated copies checked by the suite stay equal to the gate, and the per-call shape field reaches agents that read neither.
- Consequences: Changing a required section means regenerating the embedded tables (the test prints the expected table) in the same PR.
- Supersedes: d-shape-one-constant-docs-embed
- Change: agent-guidance
- Date: 2026-10-30
