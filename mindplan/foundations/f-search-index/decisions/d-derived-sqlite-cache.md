### d-derived-sqlite-cache

- Decision: Search runs on a derived SQLite cache at .mindplan-cache/index.db: gitignored, rebuilt from the files, and safe to delete at any time.
- Alternatives:
  - Rank in memory on every call with no cache (embeddings would be recomputed for every node at every server start)
  - Store vectors next to each node under mindplan/ (graph files would churn with every model change and show up in PR diffs)
- Why: Embedding every node is the slow step; a cache keyed by content hash re-embeds only what changed, and keeping it outside mindplan/ keeps it out of git and changed_files.
- Consequences: A schema version, model id, or vector size change drops and rebuilds the whole cache.
- Change: semantic-search
- Date: 2026-10-25
