### d-shape-one-constant-docs-embed

- Decision: The required sections per type live in one constant (TERRITORY_SHAPE) that the gate, shapeReport, shapeWarning, and shapeTableMarkdown read; the skill, playbook, and SPEC embed the generated table between markers, and a test fails when an embedded copy differs.
- Alternatives:
  - Substitute the table into the skill and playbook at install and serve time (the template files in the repo and the npm tarball would not show the table, and SPEC.md readers outside MCP would not see it)
  - Keep the sections inline in the gate and document them by hand (the drift that made agents learn the shape one Blocked at a time)
- Why: Agents read the skill, the playbook, and get_spec; only a generated table checked by the test suite keeps all three equal to what the gate enforces.
- Consequences: Changing a required section means regenerating the embedded tables (the test prints the expected table) in the same PR.
- Change: agent-guidance
- Date: 2026-10-30
