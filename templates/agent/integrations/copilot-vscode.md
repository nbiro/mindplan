# GitHub Copilot (VS Code)

1. **Register MCP** — in VS Code settings or `.vscode/mcp.json`, add the server:

```json
{
  "servers": {
    "mindplan": {
      "type": "stdio",
      "command": "npx",
      "args": ["mindplan-mcp"]
    }
  }
}
```

`npx mindplan-mcp` runs the copy pinned in your `package.json` dev dependencies (`npm install -D mindplan-mcp`). In a project without a `package.json`, use `"args": ["-y", "mindplan-mcp@0.13"]`.

Exact schema varies by VS Code / Copilot version — see [VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/customization/mcp).

2. Restart VS Code or reload MCP servers after config changes.

3. **Set up MindPlan** — ask Copilot to set up MindPlan in the repository. It calls `setup_project` and follows the returned guide: it writes `MINDPLAN.md` at the root and points your agent files at it (a line in `AGENTS.md`, or `.github/copilot-instructions.md` if your Copilot setup reads neither `AGENTS.md` nor `CLAUDE.md`), and proposes moving your standing rules into the project brief.
