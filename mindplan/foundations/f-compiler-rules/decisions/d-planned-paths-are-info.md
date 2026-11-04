### d-planned-paths-are-info

- Decision: A node whose active slot is draft or ready and none of whose claimed files exist yet reports missing named paths as one planned: info line per node, not stale: warnings; a path on an "at build time" line is planned on every node.
- Alternatives:
  - Drop missing-path signals for plan-only nodes entirely (a typo in a planned path would never surface)
  - Keep stale: warnings (a 60-node plan buried the real warnings under one line per planned path)
- Why: A plan names files it has not built; that is information, not drift, and one line per node keeps it visible without drowning real warnings.
- Consequences: run_check gains an info list and Info: output lines; the moment a node's first claimed file exists its missing paths are stale: again.
- Change: agent-guidance
- Date: 2026-10-30
