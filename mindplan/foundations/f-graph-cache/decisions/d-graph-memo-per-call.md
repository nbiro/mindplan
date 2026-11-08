### d-graph-memo-per-call

- Decision: Within one tool call (or one CLI check), a graph load reuses the call's previous load for every node folder that no plan write noted by this process touched since; the first load of each call still runs the full freshness rule.
- Alternatives:
  - Pass one loaded graph through every handler (77 loadGraph call sites, and each write path must remember to reload: a larger change with the same staleness risk spread across handlers)
  - Reuse the whole memo until any write, then re-check every folder (measured: write calls still re-check and re-hash every folder, so rebase-flow only went from 26 s to 23 s; per-folder invalidation took it to 18 s)
  - Trust the memo across calls (an edit made between calls by git, an editor, or another server would be missed: the freshness rule exists for exactly that)
  - Shorten RACY_MS so recent files are not hashed (it guards filesystems with coarse mtimes; only tests keep every file inside the window)
- Why: Profiling showed about four graph loads per tool call, each stat-ing every node folder and hashing every recently written one: loads were 70% of server time. Within one call only this process's own writes can change what it loads in between, and every plan write already goes through f-source-index io wrappers, so noting the written path there invalidates exactly the folders that changed.
- Consequences: Every write under mindplan/ that bypasses writeFileRetry / copyFileRetry / unlinkRetry must call notePlanWrite(path); CI runs npm test with MINDPLAN_GRAPH_MEMO=verify, which compares each reuse with a full load and fails on a missed note. Within a call the graph is a snapshot: an outside edit made during the call is seen by the next call. MINDPLAN_GRAPH_MEMO=off disables reuse.
- Change: graph-load-memo
- Date: 2026-11-08
- Nodes: f-source-index, f-territory-store, f-graph-migrations, i-check-integrity, if-mcp-tools
