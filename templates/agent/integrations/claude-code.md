# Claude Code

1. **Register MCP** (from your project root):

```bash
claude mcp add mindplan -- npx mindplan-mcp
```

`npx mindplan-mcp` runs the copy pinned in your dev dependencies (`npm install -D mindplan-mcp`); without a `package.json`, use `npx -y mindplan-mcp@0.13`. To share the server with everyone who opens the repo (including cloud containers), commit it to `.mcp.json` instead (see [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp); the package ships the same snippet as `templates/agent/mcp.json.example`):

```json
{
  "mcpServers": {
    "mindplan": { "type": "stdio", "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

2. **Set up MindPlan** — ask Claude Code to set up MindPlan in the repository. It calls `setup_project` and follows the returned guide: it writes `MINDPLAN.md` at the root and adds `@MINDPLAN.md` to `CLAUDE.md`, adds `.mindplan-cache/` to `.gitignore`, and proposes moving your standing rules into the project brief. Review and approve the changes it shows you.

Skills (`define-entities`, `plan-project`) are served by the server through `get_skill`; nothing is copied to `.claude/skills/`.

Set `MINDPLAN_ROOT` if Claude Code does not start the server with cwd at the project root.
