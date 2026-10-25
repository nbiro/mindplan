# Claude Code

1. **Register MCP** (from your project root):

```bash
claude mcp add mindplan -- npx mindplan-mcp
```

`npx mindplan-mcp` runs the copy pinned in your dev dependencies (`npm install -D mindplan-mcp`); without a `package.json`, use `npx -y mindplan-mcp@0.8`. To share the server with everyone who opens the repo (including cloud containers), commit it to `.mcp.json` instead:

```json
{
  "mcpServers": {
    "mindplan": { "type": "stdio", "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

Or add to the project MCP config (see [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp)) using the snippet in `mindplan/agent/mcp.json.example`.

2. **Instructions** — MCP already requires `get_project` (dialect + project brief). Add the stub to `CLAUDE.md` if this host does not read root `AGENTS.md`:

```markdown
Before answering any questions or writing any code, call get_project and follow the playbook plus the project description and rules it returns. If tools are unavailable, use AGENTS.md / host skill copies — do not read or edit mindplan/** with host file tools.
Before planning or changing code, call orient_for_work and place the work on the graph.
Skills load on demand: define-entities, plan-project.
```

3. **Skills** — `mindplan-mcp init --host claude` writes `CLAUDE.md` (`@AGENTS.md`) and copies the skills below. To do it by hand, symlink or copy for Claude Code skill discovery:
   - `mindplan/agent/skills/define-entities/` → `.claude/skills/mindplan-define-entities/`
   - `mindplan/agent/skills/plan-project/` → `.claude/skills/mindplan-plan-project/`

Set `MINDPLAN_ROOT` if Claude Code does not start the server with cwd at the project root.
