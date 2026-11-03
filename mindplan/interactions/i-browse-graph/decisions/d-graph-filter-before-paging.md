### d-graph-filter-before-paging

- Decision: get_mindplan_graph filters (state, type, change; AND across, OR within) before sorting and paging, so the page totals describe the filtered set, total_edges counts edges whose source is in the filtered set, and change matches an open revision's change, else the record's change field.
- Alternatives:
  - Filter each page after slicing (pages would come back short or empty and next_offset would not walk the answer)
  - Match change on the live change field only (an open revision's change lives on next, so every revision of the change would be missed)
- Why: A filtered call should answer a question in one page that fits the host's result limit; totals that describe the answer let the agent trust it.
- Consequences: total_edges no longer means every edge once a filter is passed; with no filter the output is unchanged.
- Change: graph-filters-fan-out
- Date: 2026-10-31
