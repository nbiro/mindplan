### d-check-stays-whole

- Decision: The integrity check stays one action: every level (default, change, merge, strict) is a level of one check with one output for the CLI, run_check, and CI.
- Alternatives:
  - Split the merge gate into its own action (d-merge-gate-opt-level-existing chose one check so the output format cannot drift)
  - Split the change check out (it reuses every default rule; a second action would duplicate them)
- Why: Its revisions add checks to one behavior; the rules themselves already live in f-compiler-rules, so new checks mostly land there.
- Change: hotspot-splits
- Date: 2026-10-31
- Keep whole: true
