### d-merge-gate-stale-territory

- Decision: The merge gate (run_check({ merge }), check --merge) Blocks a shipped node with no open revision whose claimed files changed against the base while its live territory file did not; the fix is open_next and ship, or a territory patch in place.
- Alternatives:
  - Keep it a stale: warning (acknowledgeable, so a branch can merge a graph that still describes the old behavior)
  - Block it in the default check (fails every intermediate run on a branch while the code is still moving; the merge is the moment the graph must be true)
  - Compare body updated_at with file mtimes (mtimes lie across checkouts; the diff against the base is what CI has)
- Why: The owner requires that the graph reflect the code by merge time whatever order the agent worked in; the merge gate already probes changed paths against the base for strict, so the rule costs no new probe.
- Consequences: A branch that edits a shipped node's files must also touch that node's territory (any patch counts; the gate cannot judge the text), a cosmetic edit included; without git or a base the rule is skipped with an Info line.
- Change: lean-dialect
- Date: 2026-11-07
