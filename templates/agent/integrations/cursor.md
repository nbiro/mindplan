# Cursor

Merge into `.cursor/mcp.json` (reload it in Cursor Settings → MCP):

```json
{
  "mcpServers": {
    "mindplan": { "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

Without a `package.json` that pins `mindplan-mcp` (`npm install -D mindplan-mcp`), use `"args": ["-y", "mindplan-mcp@0.21"]`. Then reload MCP servers and ask your agent to **set up MindPlan** ([what happens next](README.md)).
