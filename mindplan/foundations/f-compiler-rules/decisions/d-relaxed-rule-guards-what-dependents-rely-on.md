### d-relaxed-rule-guards-what-dependents-rely-on

- Decision: Under the relaxed dependency rule, everything a shipped dependent relied on stays put until the dependency ships: moving it back from in-review, unticking its build items, cancelling it, and discarding a revision whose files a dependent imports are all Blocked, naming the dependents.
- Alternatives:
  - Re-check dependents later and warn (a stable node would keep resting on work that may never ship)
  - Drop the relaxed rule (the build chain would again wait on human review items)
- Why: The relaxed rule lets a dependent ship on an in-review dependency; that is only safe if the state it shipped on cannot quietly regress.
- Change: review-fixes
- Date: 2026-11-03
- Nodes: i-change-status, i-revise-node, i-edit-territory
