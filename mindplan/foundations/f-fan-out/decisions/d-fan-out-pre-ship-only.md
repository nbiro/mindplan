### d-fan-out-pre-ship-only

- Decision: Fan-out is counted only for never-shipped Foundations, Interactions, and Interfaces; a shipped node's open revision is not counted, and a target counts only when it has never shipped and carries a change id other than the node's own.
- Alternatives:
  - Also count a shipped node's open revision over its next depends_on (no measured case yet; the reported problem was a planned node)
  - Count every unshipped depends_on target, change id or not (a target with no change id is not part of another feature's change)
- Why: The case that motivated it was a planned action wired to four unbuilt features; shipped targets are settled substrate, and same-change targets are one feature.
- Consequences: A revision that adds many cross-change depends_on edges is still caught by the depends_on decision trigger, not by fan-out.
- Change: graph-filters-fan-out
- Date: 2026-10-31
