### d-churn-from-decision-changes

- Decision: A node's churn is the number of distinct change ids on its decisions (live and open next, superseded included) plus its open revision's change; the node stores no revision log.
- Alternatives:
  - Store a revision log on each node (change id, date, sections, files): the owner's rule is that a node holds its current state and git holds history
  - Count commits that changed shipped_at in git log of <id>.mdx (needs git and history depth in every caller, and a shallow CI clone would read churn 0)
- Why: Decisions already persist with their change id after ship and are written at exactly the revisions that mattered (the gate asks for one on every shipped Foundation revision and wide-radius change), so they count churn and name the reasons with no new state.
- Consequences: A revision that recorded no decision does not count; churn is a lower bound. Hotspot groups are per change and list decision sentences, not files or sections.
- Change: open-closed
- Date: 2026-10-31
