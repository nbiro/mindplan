### d-hotspot-answered-by-naming-decision

- Decision: A change's hotspot on a node is answered, and its change group gets its reasons, from the decisions under that change that the node holds or that name it in nodes; the open-closed module is revised where it is.
- Alternatives:
  - Count any decision under the change, as the decision gate does: one decision would silence the hotspot of every node in the change, also those its author never considered
  - Keep the node's own decisions only: a choice that shapes several nodes had to be recorded once per node to quiet each hotspot, which the define-entities skill calls noise
  - Move open-closed.ts into its own Foundation that depends_on f-compiler-rules, the refactor the warning names: nine nodes import it and each would reopen for one wiring edge, to keep two small edits out of one module
- Why: record_decision tells the agent to record a multi-node choice once with nodes; the hotspot summary then said "no decision recorded" on every listed node, and the check kept warning about hotspots that had been answered.
- Consequences: nodeChurn, answeredUnder, and answeredForOpenWork take the graph; their callers in i-orient-plan, i-revise-node, and i-check-integrity pass it.
- Change: planning-friction
- Date: 2026-11-12
- Nodes: i-check-integrity, i-revise-node, i-orient-plan
