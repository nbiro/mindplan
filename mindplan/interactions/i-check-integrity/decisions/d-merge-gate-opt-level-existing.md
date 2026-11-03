### d-merge-gate-opt-level-existing

- Decision: The merge gate is an opt-in level of the existing check (`check --merge`, `run_check({ merge })`), failing on in-review active slots and in-review Bugs, with a strict level for in-progress nodes whose claimed files changed against the base.
- Alternatives:
  - Fail in-review nodes in the default check (every branch with a node in review would fail CI, though in-review on a branch is the normal pre-merge state)
  - A separate `mindplan-mcp gate` command (a second output format and exit path that could drift from run_check)
  - Make strict the only level (blocks every incremental PR of a large in-progress feature)
- Why: In review is legal on a branch and illegal on the default branch, so only a check that knows it is guarding a merge can fail on it; reusing the check keeps one output format for the CLI, run_check, and CI.
- Consequences: CI must opt in (the init workflow, or a required status check the repository configures); strict needs git history and a resolvable base.
- Change: merge-gate
- Date: 2026-10-28
