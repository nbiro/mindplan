### d-decision-sets-no-label

- Decision: record_decision never writes the node's change label: a decision on a shipped node with no open next records its change id on the decision only and does not make the node a neighbor of that change.
- Alternatives:
  - Keep labeling and have run_check --merge and the merge gate clear neighbor labels of every change with no open revision (a check would start writing the graph, and in-flight neighbor-only changes would lose their labels at every merge check)
  - Keep labeling and rely on users clearing stale labels by hand with patch_node_territory change: "" (the stale-label bug stays the default)
- Why: A label groups live work; a decision on a shipped node is reasoning, not an in-place edit, and a change that only records decisions never opens a revision, so nothing ever cleared its labels and finished changes kept listing shipped nodes as members.
- Consequences: A neighbor that should join a change while only a decision is recorded on it is labeled explicitly with patch_node_territory, set_implementation_files, or set_test_files (change). list_decisions({ change }) still finds the decision.
- Change: graph-edges-stale-labels
- Date: 2026-10-31
