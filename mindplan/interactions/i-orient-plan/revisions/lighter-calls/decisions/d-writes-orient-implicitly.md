### d-writes-orient-implicitly

- Decision: open_next, patch_node_territory, and set_implementation_files on a node never oriented on in this session orient it themselves and return its rules (oriented: true, rules); every other write still Blocks: Orientation, and all of them still Block when the rules reaching the node changed since they were sent.
- Alternatives:
  - Keep the Block on every write (d-orientation-write-gate): an agent revising five nodes paid a Blocked call, an orient, and a retry for each
  - Orient implicitly on every write (a rules change would then reach the agent only inside a write reply it may skim, and decisions and links deserve a read first)
- Why: The gate exists so rules reach the agent before it writes; a write reply that carries the rules delivers them as surely as an orient reply, while a changed rule still needs a deliberate read. The orientation is recorded only after the write succeeds, so a write that Blocks for another reason orients nothing.
- Consequences: The three tools' replies may carry oriented: true and rules (oriented_rules when the reply already has a rules block). orient_for_work({ node_ids }) orients several nodes for the other writes in one call.
- Supersedes: d-orientation-write-gate
- Change: lighter-calls
- Date: 2026-11-08
- Nodes: f-plan-writes, f-orientation-ledger, i-revise-node, i-edit-territory, i-claim-files
