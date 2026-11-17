### d-contract-free-writes-orient-implicitly

- Decision: open_next, patch_node_territory, set_implementation_files, a planned link_nodes, and confirm_territory orient a node never oriented on in this session themselves and return its rules (oriented: true, rules); every other write still Blocks: Orientation, and all of them still Block while rule text that reaches the node has not reached the session.
- Alternatives:
  - Keep the first three only: planning one exposes edge on each of 31 shipped Interfaces, or confirming one node, paid a Blocked call and an orient first, though neither write changes text, live edges, or the rules reaching anything
  - Orient implicitly on every link: a live link or a link into a revision changes which rules reach the node, and those still deserve a read first
  - Orient implicitly on every write: a rules change would reach the agent only inside a write reply it may skim, and decisions and status moves deserve a read first
- Why: A write reply that carries the rules delivers them as surely as an orient reply. A planned edge is applied only by open_next, which orients and returns the rules the edge brings; a confirmation pins file hashes and changes nothing the rules could have shaped.
- Consequences: confirm_territory no longer forces an orient before the claim that the text still holds; its note and by-line stay the record. The orientation is recorded only after the write succeeds, so a write that Blocks for another reason orients nothing. orient_for_work({ node_ids }) still orients several nodes for the other writes in one call.
- Supersedes: d-writes-orient-implicitly
- Change: planning-friction
- Date: 2026-11-12
- Nodes: f-plan-writes, f-orientation-ledger, i-revise-node, i-edit-territory, i-claim-files, i-shape-graph, i-confirm-territory
