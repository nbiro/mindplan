### d-decisions-one-file-each

- Decision: Decisions are append-only files, one per decision (decisions/<decision-id>.md), in the node folder or in the revision folder while it is open; ship moves a revision's files to the node folder.
- Alternatives:
  - Keep the ## Decisions body section (two branches recording decisions on one node conflict in git)
- Why: The user chose it so parallel worktrees can record decisions on the same node without merge conflicts.
- Supersedes: d-decisions-slot-bound
- Change: multi-revisions
- Date: 2026-11-02
