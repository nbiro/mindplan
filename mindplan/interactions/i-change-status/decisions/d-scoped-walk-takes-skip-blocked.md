### d-scoped-walk-takes-skip-blocked

- Decision: A scoped walk takes `skip_blocked: true` to walk every member that passes its gates and leave each blocked member (and whatever cannot move without it) where it is, listing them in `blocked`; the default stays all-or-nothing.
- Alternatives:
  - An explicit `scope: "nodes"` with `node_ids` (the agent must first work out which members are finished, which the walk's own validation already knows)
  - Make partial walks the default (an agent expecting the whole change to ship would silently leave members behind)
- Why: The user chose it: a change that holds finished and blocked members should ship its finished ones in one call, and the walk already validates each step, so it can tell which members pass.
- Consequences: A blocked member moves no step at all, so it is never left half-walked; callers must read `blocked` to see what stayed behind.
- Change: skip-blocked-walk
- Date: 2026-11-02
