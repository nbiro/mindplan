### d-domain-model-revise-for-capability

- Decision: This revision reopens f-domain-model because the set of node types is its own contract, and renaming one type cannot be done beside it.
- Alternatives:
  - A new node that depends_on f-domain-model and adds the behavior without revising it: a type name cannot be added next to NODE_TYPES without keeping Journey as a second name, and ending that second name is the point of the change
- Why: NODE_TYPES and the computed state set live here and every reader imports them; a rename has to land in the one place that defines them.
- Change: capability-type
- Date: 2026-11-01
