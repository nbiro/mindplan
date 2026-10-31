# Codex

Codex CLI, the IDE extension, and the ChatGPT desktop app share MCP config for the same host. See [Codex MCP docs](https://developers.openai.com/codex/mcp).

1. **Register MCP** (from your project root):

```bash
codex mcp add mindplan --env MINDPLAN_ROOT="$(pwd)" -- npx -y mindplan-mcp@0.13
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

`npx mindplan-mcp` runs the copy pinned in your dev dependencies (`npm install -D mindplan-mcp`); without a `package.json`, use `args = ["-y", "mindplan-mcp@0.13"]`.

2. **Verify** — start Codex and run `/mcp`, or:

```bash
codex mcp list
```

Confirm `mindplan` is connected and exposes tools such as `get_project` and `setup_project`.

3. **Set up MindPlan** — ask Codex to set up MindPlan in the repository. It calls `setup_project` and follows the returned guide: Codex auto-reads root `AGENTS.md`, so the agent writes `MINDPLAN.md` at the root and adds a "Read and follow MINDPLAN.md" line to `AGENTS.md`, then proposes moving your standing rules into the project brief.

Set `MINDPLAN_ROOT` (as above) if Codex does not start the server with cwd at the project root.
