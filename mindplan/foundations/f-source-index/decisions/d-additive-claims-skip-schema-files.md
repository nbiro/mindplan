### d-additive-claims-skip-schema-files

- Decision: A shipped node with no open next may add claims in place only when no claimed file is lost, each new entry is a file in, or the directory of, a folder it dominates, and no new entry reaches a migration or schema file (config decisions.schema_files); globs, removals, moves, and schema claims need open_next.
- Alternatives:
  - Allow schema claims in place like any other file (a new migration would never reach the decision gate, since only open revisions are decision-worthy)
  - Make in-place schema claims decision-worthy without a revision (the gate runs on the move to in-review, which an in-place write never makes)
- Why: A new migration or schema file is decision-worthy by the gate's own rule, and only a revision reaches the gate; a file in a dominated folder affects no dependent's contract, but a schema change can.
- Consequences: A node whose only change is a new migration in its own folder still needs open_next and a decision; a folder entry over a schema folder is refused even when the folder is empty today.
- Supersedes: d-additive-claims-in-dominated-folders
- Change: shipped-claims-and-neighbors
- Date: 2026-10-25
