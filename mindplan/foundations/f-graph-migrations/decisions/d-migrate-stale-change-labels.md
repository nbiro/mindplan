### d-migrate-stale-change-labels

- Decision: Migration level 2 clears the change label of every shipped neighbor whose change has no open revision and no pre-ship member, and reports each { node_id, change } in staleChangeLabelsCleared.
- Alternatives:
  - Clear only labels whose change also holds a decision on that node (misses labels left by older decision-then-claim sequences, and cannot tell which write set the label)
  - No migration: leave existing stale labels for users to clear by hand (every repo keeps finished changes listing shipped nodes)
- Why: A label with no open revision behind it cannot be told apart from the stale labels record_decision left, and upgrade_project is a reviewed commit of its own, so the report shows what was cleared.
- Consequences: A neighbor-only change in flight at upgrade time (shipped nodes labeled, no revision yet) loses its labels; relabel with patch_node_territory change. Raises MIGRATION_LEVEL to 2, so every project runs upgrade_project once.
- Change: graph-edges-stale-labels
- Date: 2026-10-31
