### d-graph-cache-freshness-rule

- Decision: Inside git, a cached record is reused without touching its files only when it was parsed while its folder was clean at a tree T, git status does not list the folder now, and the folder did not change between T and the current tree; every other record is checked by file stamps (size and mtime), re-read and hashed when a stamp is too recent to trust, and re-parsed when the content differs. Outside git, or where git ignores plan files, every record is checked by stamp.
- Alternatives:
  - One hash of the whole plan written by MCP (hand edits leave it stale and it conflicts on every merge)
  - A file watcher (can miss events on network drives or buffer overflow, and needs a full scan as a backstop anyway)
  - Stamps only (1.4 s per call at 10,000 nodes on Windows, against about 0.45 s for git status and the tree id)
- Why: Git already keeps a content hash of the committed tree and detects working-tree edits through its own stat cache; trusting only records parsed from clean, committed content keeps the rule sound even when several servers write the cache.
- Consequences: A load inside git spawns git (about 100 ms on Windows), so small plans use stamps; a record parsed from a dirty file is re-verified until its folder is clean again.
- Change: graph-cache
- Date: 2026-10-26
