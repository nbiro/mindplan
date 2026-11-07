### d-light-rules-by-distance

- Decision: Rule blocks carry the full text of the focus's own rules and of every source at distance 1 (its Capability, its direct Foundations, a Bug's affected nodes); a source further away comes back as one line { node_id, node_type, via, distance, version, first, count } unless include_inherited_rules is true. orient_for_work defaults to depth "body". Write results return only the rule entries the write itself added or changed (diffed within the call), and patch_project_rules / patch_project_description return a confirmation, not the brief. The server keeps no record of which text it delivered.
- Alternatives:
  - Remember per session which rule texts were delivered and leave them out the next time (state the server must keep right across reconnects, and a client that lost its context would be served nothing)
  - Keep every inherited rule in full (a 250-node graph repeated the same 1-4 KB of distance 2-4 rules, about erasing and dashboard copy, in every orient and link reply)
  - Drop inherited rules beyond the focus entirely (the agent would not know a distant rule exists, or when it changed)
- Why: The rules that shape a node's work almost always live on the node, its Capability, or a Foundation it uses directly; distant ones reach it only through chains of depends_on. A one-line entry with its version tells the agent the rule exists and when it changed, and one flag returns the text. Distance is a property of the graph, so the reply stays the same for every session.
- Consequences: The orientation gate still fingerprints every reaching rule, so a changed distant rule still sends the node back to orient (the one-line entry shows a new version). A client that read neighborhood, blast_radius, or stability from a default orient reply must pass depth "full".
- Change: light-orient-replies
- Date: 2026-11-07
- Nodes: i-orient-plan, f-plan-views, f-plan-writes, i-edit-brief
