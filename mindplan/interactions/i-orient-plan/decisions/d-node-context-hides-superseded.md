### d-node-context-hides-superseded

- Decision: get_node_context leaves superseded decisions out of decisions and next.decisions unless include_superseded, the same default and flag as list_decisions and orient_for_work.
- Alternatives:
  - Keep returning every entry because the full read is meant for history (a node with a long trail buries its current decisions, and the two readers disagree on the same default)
  - Return every entry with status and let the caller filter (every caller reimplements the same filter that list_decisions already applies)
- Why: Every decision reader should answer the same question by default: what currently applies. The trail stays one flag away.
- Consequences: A client that relied on superseded entries in get_node_context must pass include_superseded.
- Change: node-context-superseded
- Date: 2026-10-20
