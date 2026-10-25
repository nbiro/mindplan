# Codex

Codex CLI, the IDE extension, and the ChatGPT desktop app share MCP config for the same host. See [Codex MCP docs](https://developers.openai.com/codex/mcp).

1. **Register MCP** (from your project root):

```bash
codex mcp add mindplan --env MINDPLAN_ROOT="$(pwd)" -- npx -y mindplan-mcp@0.7
```

Or add a project-scoped entry in `.codex/config.toml` (trusted projects only), or globally in `~/.codex/config.toml`:

```toml
[mcp_servers.mindplan]
command = "npx"
args = ["mindplan-mcp"]
cwd = "/absolute/path/to/your/project"
startup_timeout_sec = 20

[mcp_servers.mindplan.env]
MINDPLAN_ROOT = "/absolute/path/to/your/project"
```

`npx mindplan-mcp` runs the copy pinned in your dev dependencies (`npm install -D mindplan-mcp`); without a `package.json`, use `args = ["-y", "mindplan-mcp@0.7"]`.

2. **Instructions** — Codex auto-reads root `AGENTS.md`. `mindplan-mcp init` writes the stub there when missing. MCP already requires `get_project` (dialect + project brief). The playbook file is a fallback if tools are hidden.

3. **Verify** — start Codex and run `/mcp`, or:

```bash
codex mcp list
```

Confirm `mindplan` is connected and exposes tools such as `orient_for_work` and `get_mindplan_graph`.

Set `MINDPLAN_ROOT` (as above) if Codex does not start the server with cwd at the project root.
