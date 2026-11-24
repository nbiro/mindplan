### d-hook-brief-not-gate

- Decision: The SessionStart hook delivers the brief into context but does not clear the server's Blocked: Rules gate; the agent still calls get_project or get_rules once per session before writing.
- Alternatives:
  - Have the hook write a marker (rules_version) the server reads to clear the gate (the server cannot tie a Claude Code session to an MCP session, so a marker in the checkout would clear the gate for every session there, including ones that never saw the rules)
  - Inject only a reminder to call get_project (leaves the read and answer path, which the server cannot gate, depending on the agent remembering)
- Why: The hook covers what the server cannot see, the turns that only read and answer. The write gate stays the server's own proof, the same in every host.
- Consequences: A Claude Code session receives the brief twice (once from the hook, once from get_project before its first write). get_rules with known_version keeps the second read cheap.
- Change: claude-plugin
- Date: 2026-11-22
