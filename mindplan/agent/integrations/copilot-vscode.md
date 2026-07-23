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
Always follow mindplan/agent/playbook.md for MindPlan SDLC execution (all software work). Use mindplan/agent/skills/define-entities/ when scaffolding nodes; use mindplan/agent/skills/plan-project/ for plan-only product modeling (no application code); use mindplan/agent/skills/review-work/ for Plan Review and Implementation review.
```

3. Restart VS Code or reload MCP servers after config changes.
