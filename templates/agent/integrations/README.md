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
- `mindplan/agent/skills/plan-project/` — plan-only product modeling (no application code)
- `mindplan/agent/mcp.json.example` — MCP server snippet (adjust the path)

If your agent reads root **`AGENTS.md`**, `init` creates one when missing. Otherwise, point the agent at `mindplan/agent/playbook.md` manually.

**Territory transparency:** MCP owns graph mutations (`create_node`, links, status, `open_next` / `discard_next`) and returns `changed_files` for paths it wrote. Interactive agents SHOULD edit territory prose (`title` / `description` / body / checkboxes) with host file tools so native “changed files” UIs show the diff. Review MCP side-effects via those paths, Source Control, or the tool result — many hosts do not list subprocess FS writes in their edit strip.

Set `MINDPLAN_ROOT` to your project root if the MCP server is not started from that directory.
