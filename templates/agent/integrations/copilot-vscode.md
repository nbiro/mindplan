# GitHub Copilot (VS Code)

1. **Register MCP** — in VS Code settings or `.vscode/mcp.json`, add the server from `mindplan/agent/mcp.json.example`:

```json
{
  "servers": {
    "mindplan": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mindplan/dist/index.js"]
    }
  }
}
```

Exact schema varies by VS Code / Copilot version — see [VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/customization/mcp).

2. **Instructions** — MCP already requires `get_project` (dialect + project brief). `init` writes that stub to `AGENTS.md` when missing. The playbook file is a fallback if tools are hidden.

3. Restart VS Code or reload MCP servers after config changes.
