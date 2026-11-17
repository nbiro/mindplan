### d-link-batch-all-or-none

- Decision: link_nodes takes edges, a list checked on one in-memory graph and written only when every edge passes, with one rules block in the reply; unlink_nodes stays one pair per call.
- Alternatives:
  - A separate link_many tool: a second tool with the same checks, gate, and rules reply to keep in step
  - Try every edge and report partial: true, as update_node_status({ revisions }) does: a half-wired plan the agent has to diff against its intent
  - Batch unlink_nodes too: discard_change covers bulk removal, and nothing measured asks for more
- Why: Wiring ten new nodes took about 45 calls, and one exposes edge on each of 31 Interfaces took 31, each reloading the graph and returning its own rules block.
- Consequences: Each edge is checked against the graph the earlier edges of the batch leave, so the cycle checks run on accumulated edges, not one proposed edge at a time.
- Change: planning-friction
- Date: 2026-11-12
