# Cline

1. **Register MCP** — in Cline extension settings, open **MCP Servers** and add a stdio server:

| Field | Value |
|-------|-------|
| Name | `mindplan` |
| Command | `npx` |
| Args | `mindplan-mcp` (or `-y mindplan-mcp@0.13` without a `package.json` dev dependency) |

Or merge this JSON (the package ships it as `templates/agent/mcp.json.example`) into Cline's MCP settings file:

```json
{
  "mcpServers": {
    "mindplan": { "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

2. Enable the server in Cline and verify `get_project` is available.

3. **Set up MindPlan** — ask Cline to set up MindPlan in the repository. It calls `setup_project` and follows the returned guide: it writes `MINDPLAN.md` at the root and points your agent files at it (a line in `AGENTS.md`, or `.clinerules` if this host reads neither `AGENTS.md` nor `CLAUDE.md`), and proposes moving your standing rules into the project brief. All graph mutations go through MindPlan MCP tools.
