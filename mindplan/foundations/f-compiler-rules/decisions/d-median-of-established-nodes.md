### d-median-of-established-nodes

- Decision: The hotspot baseline is the median rate of established nodes only: those shipped at least twice since their last split.
- Alternatives:
  - Every shipped node (the hotspot-splits refactor added 13 nodes shipped once and reset two roots, which dropped the median from 4.8 to 1 and flagged nine ordinary nodes)
  - Nodes older than one half-life (a young node that ships often is a real pace sample, and age needs a creation date the rate does not carry)
  - A fixed floor instead of the median (back to static thresholds the owner rejected)
- Why: A node shipped once, or a root whose rate a split just reset, says nothing yet about how often things change here; counting them lets structure changes, not change frequency, move the baseline.
- Change: hotspot-baseline
- Date: 2026-10-31
