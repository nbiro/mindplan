### d-tests-presence-blocks-coverage-warns

- Decision: A `tests` entry that matches nothing on disk is Blocked once the node (live or its next) is in-review or shipped, like implements presence; a pipeline revision reaching in-review with no tests only warns.
- Alternatives:
  - Block in-review without at least one linked test (every consumer's existing nodes and every docs-only node would need a test before their next revision)
  - Only check that entries exist, with no signal for an untested revision
- Why: A broken link is a lie the graph tells, so it fails like a missing claim; an untested node may be legitimate (docs, workflow files), so the check nudges and never stops work.
- Consequences: Draft plans may list tests that do not exist yet; the presence rule only bites at in-review and after ship.
- Change: node-tests
- Date: 2026-10-25
