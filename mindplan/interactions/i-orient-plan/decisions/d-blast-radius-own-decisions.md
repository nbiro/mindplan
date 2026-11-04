### d-blast-radius-own-decisions

- Decision: get_blast_radius returns the focus's own decisions by default plus dependent_decisions: { count, nodes }; include_dependent_decisions: true adds the dependents' one-line entries as before.
- Alternatives:
  - Reuse include_inherited_decisions for dependents (dependents' decisions are downstream, not inherited, and the flag would mean two things)
  - Always list dependents' decisions (they made up most of an orient_for_work full reply through its embedded blast radius)
- Why: The radius answers who a change reaches; the count and node ids say whose reasoning to read, and the list stays one flag away.
- Consequences: orient_for_work at depth full embeds the default radius, so its reply no longer carries dependents' decisions.
- Change: own-decisions
- Date: 2026-10-25
