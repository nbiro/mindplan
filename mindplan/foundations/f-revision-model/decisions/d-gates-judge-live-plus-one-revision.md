### d-gates-judge-live-plus-one-revision

- Decision: Gates judge a revision against graphUnder(graph, change): live plus that change's revisions only; other changes' open revisions are invisible to it.
- Alternatives:
  - Judge against live plus every open revision (one unfinished change would block or unblock another)
- Why: Each change must be shippable on its own; the rebase after a ship re-runs the gates against the new live.
- Change: multi-revisions
- Date: 2026-11-02
