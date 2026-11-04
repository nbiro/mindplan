### d-graph-cache-derived-read-model

- Decision: loadGraph reads parsed node records from a derived cache (in memory, persisted in .mindplan-cache/graph.db) and re-parses only node folders that may have changed; the .mdx files stay the only source of truth.
- Alternatives:
  - Parse every file on every call (about 1 ms per node: ~10 s per tool call at 10,000 nodes)
  - Make the database authoritative and update it from each write tool (every outside change — git pull, checkout, merge, hand edit — would need its own path, and one missed write leaves the graph wrong)
- Why: Every tool call loads the graph, so its cost is paid everywhere; caching parse results keyed by what changed removes that cost without giving up files as the truth.
- Consequences: Every tool depends on the cache's freshness rule being sound; the cache is dropped when the package or cache schema version changes, and can be deleted at any time.
- Change: graph-cache
- Date: 2026-10-26
