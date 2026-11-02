### d-split-declared-on-revision

- Decision: A split is declared on the root's open revision with patch_node_territory split_into and recorded when it ships (for the marked parts it depends_on); live ships never infer one. Only init infers past splits from git, best-effort.
- Alternatives:
  - Infer a split when a Foundation's revision adds depends_on to Foundations first shipped while it was open (a revision that only starts using a new building block looks the same, and the false split would silence a real hotspot)
  - Infer it from claims moving from the root to the part (this repo's convention gives each node its own folder, so moved code never shows as moved claims)
  - A separate split tool (one more tool for a field that belongs with the revision's other territory metadata)
- Why: The owner asked for a split-into record that marks the revision; only the agent knows whether a new dependency is an extracted part, and a wrong split resets the hotspot rate.
- Consequences: An agent that splits a node must mark the parts, or the root keeps its rate; the hotspot warning and the plan-project skill say so.
- Change: open-closed
- Date: 2026-10-31
