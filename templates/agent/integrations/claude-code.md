# Claude Code

1. **Register MCP** (from your project root):

```bash
claude mcp add mindplan -- node /absolute/path/to/mindplan/dist/index.js
```

Or add to the project MCP config (see [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp)) using the snippet in `mindplan/agent/mcp.json.example`.

2. **Instructions** — add to `CLAUDE.md` at the project root:

```markdown
Always follow mindplan/agent/playbook.md for MindPlan SDLC execution (all software work). Use mindplan/agent/skills/define-entities/ when creating planning nodes.
```

3. **Skills** (optional) — symlink or copy `mindplan/agent/skills/define-entities/` to `.claude/skills/mindplan-define-entities/` for Claude Code skill discovery.

Set `MINDPLAN_ROOT` if Claude Code does not start the server with cwd at the project root.
