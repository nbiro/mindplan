### d-contract-writes-reset-only-ready

- Decision: Every contract write to a revision, resolve_conflict included, sends only a ready revision back to draft; an in-review revision stays in review, and only the automatic rebase on a sibling ship (carryRevision) resets in-review.
- Alternatives:
  - Reset in-review on resolve_conflict only (round ten): one tool behaved unlike patch_node_territory, link_nodes, and set_implementation_files, the rule was bypassed by taking revision and patching, and a pure claim fix forced a full re-review
  - Reset in-review on every contract write: every small fix during review would walk the revision back through draft, ready, and in-progress
- Why: One rule across the write tools is predictable; review of an in-review revision covers the edits made during review, and the rebase reset stays because there the server, not the agent, changed the text.
- Consequences: Text changed while a revision is in review ships on that review; reviewers re-read the revision before ship.
- Date: 2026-11-03
- Nodes: f-territory-store, f-plan-writes
