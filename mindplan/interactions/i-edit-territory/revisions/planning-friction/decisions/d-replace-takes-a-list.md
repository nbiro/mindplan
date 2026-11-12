### d-replace-takes-a-list

- Decision: patch_node_territory replace takes one entry or a list of entries, applied in order to one in-memory body and written once, all or none.
- Alternatives:
  - A second field, replaces: two fields that cannot be combined, and every list of text fields (reason text's included) grows by one
  - Match every entry against the original body: entries could not build on each other, and overlapping matches would need a rule of their own
  - Apply the entries that match and report the rest: a half-applied rewording of a contract that the agent must diff against what it meant
- Why: Rewording eight places of one shipped body took eight calls, each rewriting the file. The store already edits an in-memory body and writes once, so a list costs a loop.
- Change: planning-friction
- Date: 2026-11-12
- Nodes: f-territory-store
