### d-stale-server-advisory

- Decision: get_project reports a replaced package under the running server in its own advisory restart field; it gates no tool and leaves version and the version gate unchanged.
- Alternatives:
  - Fold it into version and block every gated tool until restart (forces the fix, but stops all graph work until a person reconnects the server, and the old server's graph state is still valid)
  - Report it only in doctor (agents read get_project first and seldom call doctor)
  - Check the project's node_modules/mindplan-mcp too (catches a server run from the npx cache, but a restart there does not load the installed copy, so the advice would be wrong)
- Why: Only the host can restart the server, so blocking would trap the agent; the old server can still serve the graph it understands, and the agent reported needing a signal, not a gate.
- Consequences: An agent that ignores restart keeps working on the old server; version then speaks for the old package and may miss an upgrade the installed one needs.
- Change: stale-server-notice
- Date: 2026-11-04
