# Windsurf

1. **Register MCP** — open Windsurf Settings → MCP, or edit the Windsurf MCP config file and add (the package ships the same snippet as `templates/agent/mcp.json.example`):

```json
{
  "mcpServers": {
    "mindplan": {
      "command": "npx",
      "args": ["mindplan-mcp"]
    }
  }
}
```

`npx mindplan-mcp` runs the copy pinned in your `package.json` dev dependencies (`npm install -D mindplan-mcp`). In a project without a `package.json`, use `"args": ["-y", "mindplan-mcp@0.13"]`.

2. Reload Cascade after MCP config changes.

3. **Set up MindPlan** — ask Cascade to set up MindPlan in the repository. It calls `setup_project` and follows the returned guide: it writes `MINDPLAN.md` at the root and points your agent files at it (a line in `AGENTS.md`, or `.windsurfrules` if this host reads neither `AGENTS.md` nor `CLAUDE.md`), and proposes moving your standing rules into the project brief.
