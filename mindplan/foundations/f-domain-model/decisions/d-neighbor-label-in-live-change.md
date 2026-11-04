### d-neighbor-label-in-live-change

- Decision: A change's neighbor is a shipped node with no open next whose live <id>.mdx carries the change id in its existing change: scalar; one label per node, a new id replaces the old one.
- Alternatives:
  - A new neighbor_of list field so one node can sit in several changes (new schema field and merge noise for a case not yet seen)
  - Keep change ids revision-only and return a hint instead of Blocked (agents keep guessing and the change-scoped tools never see neighbors)
- Why: The live change scalar already exists, is cleared on first ship, and is ignored by activeChange for shipped nodes, so the label needs no schema change; two concurrent features on one shipped helper has not happened yet.
- Consequences: A node labeled by a second change silently leaves the first (the result reports replaced_change); open_next on a neighbor inherits its label as the revision's change because the mirror twin copies live.
- Change: shipped-claims-and-neighbors
- Date: 2026-10-23
