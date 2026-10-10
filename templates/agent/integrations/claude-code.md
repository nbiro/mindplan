# Claude Code

1. **Register MCP** (from your project root):

```bash
claude mcp add mindplan -- node /absolute/path/to/mindplan/dist/index.js
```

Or add to the project MCP config (see [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp)) using the snippet in `mindplan/agent/mcp.json.example`.

2. **Instructions** — add to `CLAUDE.md` at the project root:

```markdown
Always follow mindplan/agent/playbook.md for MindPlan SDLC execution (all software work). Use mindplan/agent/skills/define-entities/ when creating planning nodes; use mindplan/agent/skills/plan-project/ for plan-only product modeling (no application code).
```

3. **Skills** (optional) — symlink or copy for Claude Code skill discovery:
   - `mindplan/agent/skills/define-entities/` → `.claude/skills/mindplan-define-entities/`
   - `mindplan/agent/skills/plan-project/` → `.claude/skills/mindplan-plan-project/`

Set `MINDPLAN_ROOT` if Claude Code does not start the server with cwd at the project root.
