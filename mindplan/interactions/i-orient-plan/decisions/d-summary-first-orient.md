### d-summary-first-orient

- Decision: orient_for_work with only a query returns ranked rows (id, type, state, title, a 70-character description, area, score; default 8) and the full node only for a clear winner (its exact id, the only match, or twice the next score: auto_focus); orient_for_work({ node_id }) returns the full node.
- Alternatives:
  - Keep the full payload for the top match (about 22 KB on a 54-node graph, mostly for a node the agent may not work on)
  - Rows only, never auto-focus (an exact id or an obvious winner would always cost a second call)
- Why: A summary list costs about 2 KB for 10 rows and lets the agent pick; with hybrid ranking the top row is usually right, and the second call happens only when the choice is unclear.
- Consequences: A client that read context, rules, or blast_radius from a query-only reply must pass node_id or read auto_focus; row descriptions are cut, so a node's full description comes with its full reply.
- Change: summary-orient
- Date: 2026-10-25
