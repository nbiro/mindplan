### d-first-build-edges-ungated

- Decision: Only a shipped node's revision is gated on adding or removing depends_on edges; a first build's initial edges never count.
- Alternatives:
  - Gate every added edge (every new Interaction must add edges, so nearly every revision would be gated)
- Why: The brief keeps small single-area changes ungated; initial edges are part of creating a node, not changing a contract.
- Change: decision-records
- Date: 2026-10-20
