### d-open-closed-signals-warn-only

- Decision: Fan-in counts direct incoming depends_on, exposes, and mounts edges from active nodes, and every open–closed signal (hotspot, open_next fan-in, additivity) is a warning or an informational field that never Blocks.
- Alternatives:
  - Use the transitive blast radius as fan-in (the decision gate already uses it; a node deep in the graph would look widely depended on through one dependent)
  - Block open_next on a high fan-in node until a decision is recorded (the in-review decision gate already asks for one; a Block at open_next would stop legitimate revisions before the design exists)
  - Defer slot contention and extension points with this change (no graph concept for a planned change yet; deferred until a second project needs it)
- Why: Direct dependents are the nodes whose code a contract change touches first and what a split would rewire; the signals are heuristics over graph facts, and existing graphs must keep passing.
- Consequences: This repo's own check may print hotspot warnings for its core Foundations; config hotspots thresholds tune them.
- Change: open-closed
- Date: 2026-10-31
