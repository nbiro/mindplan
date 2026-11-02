### d-computed-decision-status

- Decision: A decision's status is computed from whether an active decision supersedes it, never written into the old entry.
- Alternatives:
  - Write superseded into the old entry (cross-node writes into shipped files, and a stale mark when the superseding revision is discarded)
- Why: Supersession often crosses nodes (an Interaction replacing its Foundation's decision), and the superseding record can still be discarded with its revision.
- Consequences: Readers of a raw .mdx do not see that an entry is superseded; list_decisions and orient_for_work do.
- Change: decision-records
- Date: 2026-10-20
