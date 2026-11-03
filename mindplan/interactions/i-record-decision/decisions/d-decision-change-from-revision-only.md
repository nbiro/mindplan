### d-decision-change-from-revision-only

- Decision: record_decision tags a decision with its change argument, else the node's open revision's change, else none; it never reads or writes a label.
- Alternatives:
  - Keep the fallback to a neighbor's label (labels are removed)
- Why: Labels no longer exist; the change argument still lets a decision on a shipped node join a change's reasoning trail.
- Supersedes: d-decision-sets-no-label
- Change: graph-edges-stale-labels
- Date: 2026-10-31
