### d-seen-in-memory-acks-local

- Decision: Warnings a compact run_check already returned are remembered in memory per MCP server process and root (one session); acknowledged warnings are kept per checkout in the root's git-ignored cache folder, keyed by a warning id that hashes its text.
- Alternatives:
  - A seen file in the cache folder (review: it hid warnings from other agents and fresh sessions sharing the checkout)
- Why: Each agent must see every warning at least once in its own session, while acknowledging stays a reviewer's local triage that returns when the text changes.
- Supersedes: d-acks-and-seen-local-cache
- Date: 2026-11-03
