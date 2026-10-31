# Agent integrations

MindPlan works with any coding agent that supports **Model Context Protocol (MCP)** over stdio. Setup is two steps:

1. **Register the MCP server** with your agent, using the guide for your tool below.
2. **Ask your agent to set up MindPlan.** It calls `setup_project`, which creates `mindplan/` (default `config.json`, an empty `project.md`, `version.json`), then follows the guide that call returns: it writes `MINDPLAN.md` at the repository root, wires it into the files your agent reads (`@MINDPLAN.md` in `CLAUDE.md`, a line in `AGENTS.md`, or the host's rules file when it reads neither), adds the ignores, and moves your standing rules into the project brief with your approval.

There is no CLI setup command. The server writes only `mindplan/` (and, on request, the CI workflow); the agent edits the files you own and shows you the changes.

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

**Shared assets** (served by the MCP server; nothing is copied into your repository):

- MCP `instructions` — short pointer: call `get_project` before answering or writing code
- `get_project.playbook` — the bundled dialect
- `get_skill` — the bundled skills `define-entities` and `plan-project`, loaded when the playbook routes the agent to them
- `templates/agent/mcp.json.example` (in the package) — MCP server snippet (`npx mindplan-mcp`)
- `templates/agent/agents-stub.md` (in the package) — the text `setup_project` returns as `pointer`; the agent writes it to `MINDPLAN.md`
- `mindplan/version.json` — `{ package, graph, migrations }`, stamped by `setup_project` and `upgrade_project`. After upgrading `mindplan-mcp` to a release that adds a graph migration, ask the agent to call `upgrade_project`: until then graph tools answer `Blocked: Version` and `mindplan-mcp check` fails.

**Territory transparency:** MCP is the only writer of `mindplan/` (graph fields, territory prose, attachments, `project.md`, `config.json`). Mutate tools return `changed_files` for paths they wrote. Review those paths in Source Control or the tool result — many hosts do not list subprocess FS writes in their edit strip. Do not edit `mindplan/` with host file tools.

Set `MINDPLAN_ROOT` to your project root if the MCP server is not started from that directory.
