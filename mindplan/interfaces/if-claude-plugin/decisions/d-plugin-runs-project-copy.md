### d-plugin-runs-project-copy

- Decision: The plugin pins no mindplan-mcp version: it registers the MCP server as the README's exact `npx mindplan-mcp` command and runs every hook through a launcher that uses the project's installed copy and stays silent without one.
- Alternatives:
  - Bundle or pin a mindplan-mcp version in the plugin (each teammate's plugin version, not the lockfile, would pick the server, so CI's merge gate and version.json would disagree with local sessions and the version gate would block)
  - Run `npx -y mindplan-mcp` (latest) for hooks and the server (drifts from the lockfile, and every hook would hit the network in projects without a local install)
  - Ship hooks only and leave MCP registration to the project (keeps the separate .mcp.json step that the plugin exists to remove)
- Why: Per-project pinning is what keeps the CLI, the CI merge gate, and the graph's migration level on one version for everyone. Using the README's exact command lets Claude Code dedupe the plugin's server against a project registration instead of running two.
- Consequences: The plugin only does something in projects that have mindplan-mcp as a dependency; other projects keep .mcp.json and install_hook. The SessionStart and Stop hooks need a release that has those subcommands, and the launcher skips older pins quietly.
- Change: claude-plugin
- Date: 2026-11-22
- Nodes: if-cli
