### d-ledger-in-memory-per-process

- Decision: The ledger lives in the MCP server's memory: one process is one session; a fetch is stored with a fingerprint of the rules that reach the node (its own and every inherited entry, with their sources), and the gate compares it with the current fingerprint at write time.
- Alternatives:
  - Persist fetches under mindplan/ or the cache (a new session would inherit an orientation it never read)
  - Invalidate on every graph write (any unrelated write would force re-orienting on every node)
- Why: Orientation is a property of what reached this agent; the fingerprint makes only a change to the rules that reach the node invalidate it.
- Consequences: Restarting the server forgets every fetch; MINDPLAN_ORIENT_GATE=off turns the gate off for a process (legacy test suites).
- Change: summary-orient
- Date: 2026-10-25
