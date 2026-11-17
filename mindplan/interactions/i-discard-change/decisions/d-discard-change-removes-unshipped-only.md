### d-discard-change-removes-unshipped-only

- Decision: discard_change deletes a change's open revisions, planned edges, and never-shipped nodes with what they hold, keeps the decisions that sit beside a shipped node's live file, and refuses while a node that stays points at one that goes.
- Alternatives:
  - Cancel the never-shipped nodes instead of deleting them: a cancelled folder per abandoned plan stays in the graph for good, while a node that never shipped has no history to keep and git holds the rest
  - Delete every decision tagged with the change: a ship moves a revision's decisions beside live under the same tag, so this would delete the record of members that already shipped
  - Add a whole-change mode to discard_next: it would remove nodes and planned edges that action does not own, and reopen i-revise-node, which already changes often
  - Remove the incoming edges of a deleted node silently: another change's plan would lose an edge with no signal
  - A dry_run flag: orient_for_work({ change }), which the gate asks for anyway, already lists what goes
- Why: Dropping a seven-node change took one discard_next per revision and one unlink_nodes per planned edge, and nothing removed the nodes, so the agent used git restore and git clean on mindplan/, the one thing the graph forbids.
- Consequences: Uncommitted text is gone for good. Files the removed nodes claimed stay on disk and fail Coverage until deleted or claimed. A decision recorded beside live under the dropped change stays until someone supersedes it.
- Change: planning-friction
- Date: 2026-11-12
- Nodes: f-territory-store, if-mcp-tools
