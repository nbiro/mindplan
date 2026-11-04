# Agent integrations

MindPlan works with any coding agent that speaks MCP over stdio. Setup is two steps:

1. **Register the MCP server** with your host (table below), then reload its MCP servers.
2. **Ask your agent to set up MindPlan.** It calls `setup_project`, which creates `mindplan/`, and follows the guide that call returns: it writes `MINDPLAN.md` at the root, points your agent files at it, adds the ignores, and moves your standing rules into the project brief with your approval. The server writes only `mindplan/` (and the CI workflow on request); the agent edits the files you own and shows you each change.

| Host | Register in | `MINDPLAN.md` is wired into |
|------|-------------|-----------------------------|
| [Claude Code](claude-code.md) | `claude mcp add`, or `.mcp.json` | `@MINDPLAN.md` in `CLAUDE.md` |
| [Codex](codex.md) | `codex mcp add`, or `.codex/config.toml` | `AGENTS.md` |
| [Cursor](cursor.md) | `.cursor/mcp.json` | `AGENTS.md`, else a rule under `.cursor/rules/`; setup also adds `mindplan/**` to `.cursorignore` |
| [GitHub Copilot (VS Code)](copilot-vscode.md) | `.vscode/mcp.json` | `AGENTS.md`, else `.github/copilot-instructions.md` |
| [Windsurf](windsurf.md) | Windsurf MCP config | `AGENTS.md`, else `.windsurfrules` |
| [Cline](cline.md) | Cline MCP settings | `AGENTS.md`, else `.clinerules` |
| [Continue](continue.md) | `.continue/config.yaml` | `AGENTS.md`, else a Continue rule |
| [Any MCP client](generic.md) | stdio command `npx mindplan-mcp` | `AGENTS.md`, `CLAUDE.md`, or the host's rules file |

`npx mindplan-mcp` runs the copy your `package.json` pins (`npm install -D mindplan-mcp`); without one, use `npx -y mindplan-mcp@0.19`. The package ships the JSON snippet as `templates/agent/mcp.json.example`. Set `MINDPLAN_ROOT` when the host does not start the server in the project root.

The skills (`plan-project`, `define-entities`) are served through `get_skill`; nothing is copied into your repository. Graph writes come back in each tool result's `changed_files`; some hosts leave them out of their edit list, so review them in source control.
