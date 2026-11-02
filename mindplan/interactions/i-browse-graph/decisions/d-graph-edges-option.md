### d-graph-edges-option

- Decision: get_mindplan_graph takes edges: true (default) | false | edge types; false drops both edges and total_edges, an array keeps only those types and counts them over the filtered set, and unknown types fail in the handler with the valid list.
- Alternatives:
  - Keep total_edges with edges: false (a count of edges the reply does not carry invites a second call for nothing)
  - Validate edge types with a zod enum (the schema error is harder to read than the fields-style Blocked line)
  - Drop edges whenever fields is passed (couples projection to edge selection; some slices need depends_on)
- Why: On real graphs edges are most of a filtered reply; an explicit option keeps the default output unchanged while letting a question about nodes skip them.
- Change: graph-edges-stale-labels
- Date: 2026-10-31
