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

2. **Instructions** — in Windsurf rules or your project's `AGENTS.md` / `.windsurfrules`, reference:

```
mindplan/agent/playbook.md
```

3. Reload Cascade after MCP config changes.
