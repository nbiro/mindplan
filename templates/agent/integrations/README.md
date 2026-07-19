# Agent integrations

MindPlan works with any coding agent that supports **Model Context Protocol (MCP)** over stdio. After `mindplan-mcp init`, wire the server using the guide for your tool.

| Agent | Guide |
|-------|-------|
| [Cursor](cursor.md) | `.cursor/mcp.json` |
| [Claude Code](claude-code.md) | `claude mcp add` or project MCP config |
| [Codex](codex.md) | `codex mcp add` or `.codex/config.toml` |
| [GitHub Copilot (VS Code)](copilot-vscode.md) | VS Code MCP settings |
| [Windsurf](windsurf.md) | Cascade MCP config |
| [Cline](cline.md) | Cline MCP settings |
| [Continue](continue.md) | `config.yaml` mcpServers |
| [Any MCP client](generic.md) | stdio transport |

**Shared assets** (installed by `init`):

- `mindplan/agent/playbook.md` — always-on SDLC execution process for all software work
- `mindplan/agent/skills/define-entities/` — entity creation guide (scaffolding)
- `mindplan/agent/mcp.json.example` — MCP server snippet (adjust the path)

If your agent reads root **`AGENTS.md`**, `init` creates one when missing. Otherwise, point the agent at `mindplan/agent/playbook.md` manually.

Set `MINDPLAN_ROOT` to your project root if the MCP server is not started from that directory.
