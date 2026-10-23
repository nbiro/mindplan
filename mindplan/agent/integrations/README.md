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

- MCP `instructions` — short pointer: call `get_project` before answering or writing code
- `get_project.playbook` — bundled dialect (also installed under `mindplan/agent/` for packaging; host offline copies live under `.cursor/`)
- Host skill copies — `define-entities`, `plan-project` (Cursor: `.cursor/skills/…`)
- `mindplan/agent/mcp.json.example` — MCP server snippet (`npx mindplan-mcp`)
- `mindplan/version.json` — the package version that last ran init; rerun `mindplan-mcp init` after upgrading (`get_project` and `check` warn until you do)

If your agent reads root **`AGENTS.md`**, `init` creates the stub when missing. Otherwise add `templates/agent/agents-stub.md` yourself.

**Territory transparency:** MCP is the only writer of `mindplan/` (graph fields, territory prose, attachments, `project.md`, `config.json`). Mutate tools return `changed_files` for paths they wrote. Review those paths in Source Control or the tool result — many hosts do not list subprocess FS writes in their edit strip. Do not edit `mindplan/` with host file tools.

Set `MINDPLAN_ROOT` to your project root if the MCP server is not started from that directory.
