# Codex

Codex CLI, the IDE extension, and the ChatGPT desktop app share one MCP config ([Codex MCP docs](https://developers.openai.com/codex/mcp)). From the project root:

```bash
codex mcp add mindplan --env MINDPLAN_ROOT="$(pwd)" -- npx mindplan-mcp
```

Or add it to `.codex/config.toml` (trusted projects only) or `~/.codex/config.toml`:

```toml
[mcp_servers.mindplan]
command = "npx"
args = ["mindplan-mcp"]
cwd = "/absolute/path/to/your/project"
startup_timeout_sec = 20

[mcp_servers.mindplan.env]
MINDPLAN_ROOT = "/absolute/path/to/your/project"
```

`codex mcp list` (or `/mcp` inside Codex) should show `mindplan` connected.

Without a `package.json` that pins `mindplan-mcp` (`npm install -D mindplan-mcp`), run `codex mcp add` with `-- npx -y mindplan-mcp@0.21`, or use `args = ["-y", "mindplan-mcp@0.21"]` in the TOML. Then reload MCP servers and ask your agent to **set up MindPlan** ([what happens next](README.md)).
