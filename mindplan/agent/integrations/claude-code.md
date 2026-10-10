# Claude Code

1. **Register MCP** (from your project root):

```bash
claude mcp add mindplan -- node /absolute/path/to/mindplan/dist/index.js
```

Or add to the project MCP config (see [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp)) using the snippet in `mindplan/agent/mcp.json.example`.

2. **Instructions** — MCP already requires `get_project` (dialect + project brief). Add the stub to `CLAUDE.md` if this host does not read root `AGENTS.md`:

```markdown
Before answering any questions or writing any code, call get_project and follow the playbook plus the project description and rules it returns. If tools are unavailable, read mindplan/agent/playbook.md and mindplan/project.md.
Before planning or changing code, call orient_for_work and place the work on the graph.
Skills load on demand: define-entities, plan-project.
```

3. **Skills** (optional) — symlink or copy for Claude Code skill discovery:
   - `mindplan/agent/skills/define-entities/` → `.claude/skills/mindplan-define-entities/`
   - `mindplan/agent/skills/plan-project/` → `.claude/skills/mindplan-plan-project/`

Set `MINDPLAN_ROOT` if Claude Code does not start the server with cwd at the project root.
