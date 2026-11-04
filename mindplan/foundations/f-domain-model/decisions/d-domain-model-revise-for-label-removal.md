### d-domain-model-revise-for-label-removal

- Decision: This revision reopens f-domain-model because it removes a field meaning (the neighbor label) rather than adding behavior.
- Alternatives:
  - A new node that depends_on f-domain-model (a removal cannot be added beside the node it removes from)
- Why: The change field's documented meaning and the shared predicate live here; leaving them would keep the removed concept in the model every node reads.
- Change: graph-edges-stale-labels
- Date: 2026-10-31
