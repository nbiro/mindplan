### d-planned-edges-on-live-by-change

- Decision: Wiring a shipped node will gain is a planned edge: a live-file list of { change, type, target } entries, outside graph.edges, written by link_nodes with change, applied to the next slot when open_next opens the node with that change, kept on live until that revision ships (a discard leaves it planned), and dropped when its change closes.
- Alternatives:
  - Queued revisions: several pending next drafts per shipped node keyed by change id, each rebased when another ships (covers contract text too, but needs a rebase and conflict model for sections, claims, and decisions)
  - Write the edge live at once (it already works for a node with no open next, but the live graph would claim a shipped node exposes or depends on what is not built, and no gate reviews it)
  - Keep the wiring as prose in the feature's body (what the field report did; the check cannot validate prose)
- Why: The report's blocker was edges, not text: about 14 features each needed wiring on one shipped Interface. A planned edge records and validates that wiring without locking the node in a revision and without telling the live graph it already exists.
- Consequences: Contract text for a shipped node still waits for open_next; one revision per node at a time is unchanged. A change that ships without opening a node it planned wiring on loses those entries (reported as cleared_planned).
- Change: agent-guidance
- Date: 2026-10-30
