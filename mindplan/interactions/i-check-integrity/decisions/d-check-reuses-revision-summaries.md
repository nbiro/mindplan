### d-check-reuses-revision-summaries

- Decision: The check reads a node's open-revision summary from f-plan-views revisionSummaries instead of building its own copy, adding a depends_on edge to f-plan-views.
- Alternatives:
  - Keep a private copy in check.ts (a third copy of the same summary that could drift from orient and the write results)
- Why: One summary shape across orient, write results, and the check; the edge is to an infra Foundation the check's siblings already use.
- Change: simplify
- Date: 2026-11-03
- Nodes: if-mcp-tools
