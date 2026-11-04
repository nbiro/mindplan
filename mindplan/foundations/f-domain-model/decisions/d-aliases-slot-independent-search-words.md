### d-aliases-slot-independent-search-words

- Decision: Aliases are an optional frontmatter list on any node, slot-independent like tests: create_node and patch_node_territory write them in place on shipped nodes too, without open_next or a readiness reset.
- Alternatives:
  - Treat aliases as contract text that needs open_next on a shipped node (adding a search word would cost a full revision)
  - A separate patch tool (one more tool for a field patch_node_territory can carry)
- Why: Aliases change how a node is found, not what it does; they should be as cheap to add as the moment a search misses.
- Consequences: A revision cannot propose different aliases from live; each alias is a JSON string in frontmatter.
- Change: aliases
- Date: 2026-10-25
