### d-skill-routing-in-instructions-only

- Decision: Tool descriptions describe their tool only; the routing to the plan-project skill lives once in the server instructions.
- Alternatives:
  - Keep 'Follow the plan-project skill' in each graph-write description (fourteen copies of one sentence, and a pattern the connector review criteria reject as pulling behavior from an external source)
- Why: The instructions pointer already carries the routing and is read on initialize; repeating it per tool adds context on every session and fails directory review for no gain.
- Consequences: The instructions sentence must name the graph writes the skill covers, since no description will.
- Change: mcp-audit-fixes
- Date: 2026-10-20
