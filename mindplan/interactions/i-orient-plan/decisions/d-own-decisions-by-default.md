### d-own-decisions-by-default

- Decision: orient_for_work, get_node_context, and get_blast_radius return only the focus node's own decisions by default (a Bug: those of the nodes it affects directly), plus inherited_decisions: { count, nodes }; include_inherited_decisions: true adds the inherited entries, whole at distance 1 and as one line { id, node_id, distance, decision } beyond.
- Alternatives:
  - Keep returning every inherited decision in full (on a 54-node graph one orient reply carried 13 decisions and about 60% of 22 KB, mostly from nodes three links away)
  - Drop inherited decisions entirely (the agent would not know they exist, and could simplify a Foundation's design back into the problem it avoided)
- Why: Orientation runs before every action; the decisions that shape the focus itself are what an edit there must respect, and a count with the holding nodes is enough to ask for the rest when a change reaches them.
- Consequences: A client that read inherited decisions from decisions.entries must pass include_inherited_decisions; list_decisions still returns any node's full records.
- Change: own-decisions
- Date: 2026-10-25
