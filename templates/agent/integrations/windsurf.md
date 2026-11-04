# Windsurf

Add in Windsurf Settings → MCP, or in the Windsurf MCP config file (reload Cascade after the change):

```json
{
  "mcpServers": {
    "mindplan": { "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

Without a `package.json` that pins `mindplan-mcp` (`npm install -D mindplan-mcp`), use `"args": ["-y", "mindplan-mcp@0.19"]`. Then reload MCP servers and ask your agent to **set up MindPlan** ([what happens next](README.md)).
