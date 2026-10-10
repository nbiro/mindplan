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

2. **Instructions** — in Windsurf rules or your project's `AGENTS.md` / `.windsurfrules`, always apply:

```
Always follow mindplan/agent/playbook.md for MindPlan SDLC execution (all software work). Use mindplan/agent/skills/define-entities/ when scaffolding nodes; use mindplan/agent/skills/plan-project/ for plan-only product modeling (no application code).
```

3. Reload Cascade after MCP config changes.
