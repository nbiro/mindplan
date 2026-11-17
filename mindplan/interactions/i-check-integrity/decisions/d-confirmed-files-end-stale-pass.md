### d-confirmed-files-end-stale-pass

- Decision: When the plain check decides which shipped nodes get the full stale-text pass, a changed claimed file that confirm_territory pins at its current content does not count as changed.
- Alternatives:
  - Have confirm_territory touch the territory file so its modification time moves: a write with no content change, and modification times do not survive a checkout, so CI and other clones would warn again
  - Leave it: the merge gate passed the node while the check kept warning stale about the same files
- Why: The gate and the warning ask the same question about the same files, so one confirmation should answer both.
- Change: planning-friction
- Date: 2026-11-12
- Nodes: i-confirm-territory
