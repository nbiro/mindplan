# Windsurf

1. **Register MCP** — open Windsurf Settings → MCP, or edit the Windsurf MCP config file and add:

```json
{
  "mcpServers": {
    "mindplan": {
      "command": "node",
      "args": ["/absolute/path/to/mindplan/dist/index.js"]
    }
  }
}
```

Use `mindplan/agent/mcp.json.example` as the starting point.

2. **Instructions** — MCP already requires `get_project` (dialect + project brief). `init` writes that stub to `AGENTS.md` when missing. Add the stub to `.windsurfrules` if this host does not read `AGENTS.md`.

3. Reload Cascade after MCP config changes.
