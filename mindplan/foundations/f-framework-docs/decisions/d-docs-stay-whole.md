### d-docs-stay-whole

- Decision: The framework docs (SPEC, CHANGELOG, README, skills, playbook) stay one node: they change with every release because they describe every behavior.
- Alternatives:
  - Split SPEC from the skills and templates (each release still edits both, so both parts would be hotspots and every feature would revise two nodes)
- Why: A docs node's ship rate tracks the project's release rate by design, so a high rate here is not a smell.
- Change: hotspot-splits
- Date: 2026-10-31
- Keep whole: true
