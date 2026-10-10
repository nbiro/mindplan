# Codex

Codex CLI, the IDE extension, and the ChatGPT desktop app share MCP config for the same host. See [Codex MCP docs](https://developers.openai.com/codex/mcp).

1. **Register MCP** (from your project root):

```bash
codex mcp add mindplan --env MINDPLAN_ROOT="$(pwd)" -- node /absolute/path/to/mindplan/dist/index.js
```

Or add a project-scoped entry in `.codex/config.toml` (trusted projects only), or globally in `~/.codex/config.toml`:

```toml
[mcp_servers.mindplan]
command = "node"
args = ["/absolute/path/to/mindplan/dist/index.js"]
cwd = "/absolute/path/to/your/project"
startup_timeout_sec = 20

[mcp_servers.mindplan.env]
MINDPLAN_ROOT = "/absolute/path/to/your/project"
```

After npm publish you can use `npx` instead of a local `node` path:

```bash
codex mcp add mindplan --env MINDPLAN_ROOT="$(pwd)" -- npx -y mindplan-mcp
```

2. **Instructions** — Codex auto-reads root `AGENTS.md`. `mindplan-mcp init` creates one when missing (it points at the playbook). Ensure it includes:

```markdown
Always follow mindplan/agent/playbook.md for MindPlan SDLC execution (all software work). Use mindplan/agent/skills/define-entities/ when scaffolding nodes; use mindplan/agent/skills/plan-project/ for plan-only product modeling (no application code).
```

3. **Verify** — start Codex and run `/mcp`, or:

```bash
codex mcp list
```

Confirm `mindplan` is connected and exposes tools such as `orient_for_work` and `get_mindplan_graph`.

Set `MINDPLAN_ROOT` (as above) if Codex does not start the server with cwd at the project root.
