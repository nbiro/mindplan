### d-root-argument-async-scope

- Decision: The graph root is chosen per tool call by an optional root argument that mount() resolves and installs in an AsyncLocalStorage scope read by projectRoot() and every root resolver.
- Alternatives:
  - Mutate process.env.MINDPLAN_ROOT around each call (breaks with interleaved async handlers)
  - One server per worktree (depends on host config per worktree)
- Why: The user chose a root argument; an async scope keeps every existing caller of projectRoot() working without threading root through hundreds of signatures.
- Change: worktree-writes
- Date: 2026-11-03
- Nodes: f-territory-store, f-source-index, f-orientation-ledger, f-mcp-runtime
