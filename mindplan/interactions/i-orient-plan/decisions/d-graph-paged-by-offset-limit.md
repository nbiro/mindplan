### d-graph-paged-by-offset-limit

- Decision: get_mindplan_graph pages nodes by offset and limit (default 200, max 500), returns edges whose source is in the page, and reports totals and next_offset.
- Alternatives:
  - Truncate at a character budget and flag it (a cut JSON array is unparseable, and the agent cannot ask for the rest)
  - Return summaries only and point to get_node_context (changes the result shape for every small project that fits in one page)
  - Cursor-based paging (a cursor adds state for a sorted, static list that an offset already addresses)
- Why: Claude Code truncates a result over 25,000 tokens silently; a page the agent can walk keeps every node and edge reachable, and a graph that fits in one page keeps the old shape plus totals.
- Consequences: Edges are partitioned by source, so a client must walk every page to see every edge; the CLI and the map projection do not use the page.
- Change: mcp-audit-fixes
- Date: 2026-10-20
