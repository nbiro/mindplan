### d-plugin-hooks-only

- Decision: The plugin ships hooks only and pins no mindplan-mcp version: the project keeps registering the MCP server in its own .mcp.json, and every hook runs the project's installed copy through a launcher that stays silent without one.
- Alternatives:
  - Register the server as `npx mindplan-mcp` (Claude Code merges it with a matching project registration, but on native Windows npx needs `cmd /c`, and projects without an install download the package)
  - Register the server through the launcher (works on every OS and never downloads, but a project that also keeps .mcp.json for teammates without the plugin, or for Cursor, gets two servers with every tool listed twice)
  - Bundle or pin a mindplan-mcp version in the plugin (the plugin's version, not the lockfile, would pick the server, so CI's merge gate and version.json would disagree with local sessions)
- Why: The project's .mcp.json is already pinned, shared with teammates and other hosts, and is the one registration that works on every OS. The plugin's value is enforcement, not registration, so it should add no second server.
- Consequences: Install stays two steps: register the server (step 2), then add the plugin. The plugin does something only in projects that have mindplan-mcp as a dependency, and the SessionStart and Stop hooks need 0.27.0 or later.
- Supersedes: d-plugin-runs-project-copy
- Change: claude-plugin
- Date: 2026-11-22
- Nodes: if-cli
