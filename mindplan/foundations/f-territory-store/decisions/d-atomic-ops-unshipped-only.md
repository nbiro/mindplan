### d-atomic-ops-unshipped-only

- Decision: Atomic Ops live only on unshipped slots: ship removes the section from the live file (and so from the mirror twin), and open_next gives the revision a fresh list of unticked defaults.
- Alternatives:
  - Reset the list only on open_next (the live node would still show the last release's ticked ledger, which is history, not current state)
  - Move ticked ops to an archive section or attachment on ship (keeps history inside the node; the owner wants nodes to show current state and git to hold history)
  - An explicit trim tool or flag (agents forget to call it, and it does not stop a revision from shipping on the previous release's ticks)
  - Untick the old ops on open_next (they describe finished work, so re-confirming them is meaningless)
- Why: A node should show its current state, and git keeps the history. A copied, fully ticked ledger also let a revision pass the Completion Check without one op of its own, and every revision made the body (and each orient reply) longer.
- Consequences: The mirror twin stays a byte copy of live. A shipped node's file no longer shows what its last release did; read git history or the PR for that. Shape rules that require an Atomic Ops checkbox apply only on transitions of unshipped slots.
- Change: lean-node-replies
- Date: 2026-10-29
