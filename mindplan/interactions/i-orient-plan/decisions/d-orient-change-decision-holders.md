### d-orient-change-decision-holders

- Decision: orient_for_work({ change }) also lists and records the active nodes holding an active decision under the change, as kind "decision", without making them change members anywhere else (check, blast radius, graph filter, scoped walks).
- Alternatives:
  - Add decision holders to changeMembership (run_check and get_blast_radius would treat a node a decision only describes as edited, undoing d-decision-sets-no-label)
  - Leave them out (after a reconnect a second record_decision or rules read on that node needs its own orient call, and the change's reasoning trail is invisible in the change-wide reply)
- Why: A decision is part of the change's reasoning, so orienting on the change should surface it and its rules, but only an in-place edit makes a node a member that the check and walks act on.
- Consequences: A closed change whose decisions remain still orients (on its decision holders) instead of being Blocked; a holder that is also a revision or neighbor keeps that kind.
- Change: graph-edges-stale-labels
- Date: 2026-10-31
