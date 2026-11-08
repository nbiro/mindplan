### d-hook-install-opt-in

- Decision: setup_project and upgrade_project install the Claude Code mindplan/ hook only when called with install_hook: true; otherwise a Claude Code project gets a one-line offer in the reply.
- Alternatives:
  - Install it on every setup and upgrade (writes .claude/settings.json, a file the user owns, without asking)
  - Ship only a documented snippet (agents kept reading mindplan/ with host tools; the rule stayed prose)
- Why: The hook turns the mindplan/-through-tools rule into a gate, but settings.json is the user's file: the agent asks, the user decides, and the server merges without touching other keys.
- Consequences: The setup tools still write nothing outside mindplan/ unless install_hook is passed. The hook command runs mindplan-mcp from the project's node_modules (npx --no-install).
- Change: lighter-calls
- Date: 2026-11-08
- Nodes: i-upgrade-graph, f-agent-hook, if-cli
