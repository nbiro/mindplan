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

2. **Instructions** — ensure root `AGENTS.md` references MindPlan (created by `init` when missing), or add:

```markdown
Follow mindplan/agent/playbook.md for all MindPlan planning and MCP mutations.
```

3. Restart VS Code or reload MCP servers after config changes.
