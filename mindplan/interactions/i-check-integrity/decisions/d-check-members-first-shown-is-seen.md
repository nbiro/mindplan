### d-check-members-first-shown-is-seen

- Decision: With change, run_check lists the warnings that name a member first and drops none; a compact reply applies the reply budget itself and counts only the warnings it lists as seen.
- Alternatives:
  - Scope the list to the change's members: it would drop the stale warnings on shipped nodes the branch edits in place, which belong to the change's work but are not members
  - Leave the cut to the reply envelope: every warning was marked seen before the cut, so the cut ones were never listed again in the session
  - Mark a cut warning seen when next_page serves it: the check would have to read the pager's cursors; at worst a paged warning is listed once more
- Why: A warning the agent was never shown must not count as seen, and the change the agent asked about must not be the part the budget cuts.
- Change: planning-friction
- Date: 2026-11-12
