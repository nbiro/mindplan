# Cline

In Cline's settings, open **MCP Servers** and add a stdio server named `mindplan` with command `npx` and args `mindplan-mcp`, or merge this into Cline's MCP settings file, then enable the server:

```json
{
  "mcpServers": {
    "mindplan": { "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

Without a `package.json` that pins `mindplan-mcp` (`npm install -D mindplan-mcp`), use the args `-y` and `mindplan-mcp@0.19` (in the settings file: `"args": ["-y", "mindplan-mcp@0.19"]`). Then reload MCP servers and ask your agent to **set up MindPlan** ([what happens next](README.md)).
