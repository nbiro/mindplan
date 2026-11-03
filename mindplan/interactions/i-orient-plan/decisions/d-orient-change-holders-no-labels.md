### d-orient-change-holders-no-labels

- Decision: orient_for_work({ change }) lists and records its revisions, planned sources, and the other active nodes holding an active decision under the change (kind "decision"); decision holders are members of the change-wide orientation only, not of the check, blast radius, graph filter, or scoped walks.
- Alternatives:
  - Add decision holders to changeMembership (run_check and get_blast_radius would treat a node a decision only describes as edited)
  - Leave them out (after a reconnect a second record_decision or rules read on that node needs its own orient call, and the change's reasoning trail is invisible in the change-wide reply)
- Why: A decision is part of the change's reasoning, so orienting on the change should surface it and its rules; with neighbor labels gone, it is also the only way a shipped node a change touched in place shows up in that reply.
- Consequences: A closed change whose decisions remain still orients (on its decision holders) instead of being Blocked; a holder that is also a revision keeps that kind.
- Supersedes: d-orient-change-decision-holders
- Change: graph-edges-stale-labels
- Date: 2026-10-31
