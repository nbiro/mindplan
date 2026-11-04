# GitHub Copilot (VS Code)

Add to `.vscode/mcp.json` or your VS Code settings; the schema varies by version ([VS Code MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp)):

```json
{
  "servers": {
    "mindplan": { "type": "stdio", "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

Without a `package.json` that pins `mindplan-mcp` (`npm install -D mindplan-mcp`), use `"args": ["-y", "mindplan-mcp@0.18"]`. Then reload MCP servers and ask your agent to **set up MindPlan** ([what happens next](README.md)).
