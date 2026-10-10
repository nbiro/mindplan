# Continue

1. **Register MCP** — in `.continue/config.yaml` (or `config.json`), add under `mcpServers`:

```yaml
mcpServers:
  - name: mindplan
    command: node
    args:
      - /absolute/path/to/mindplan/dist/index.js
```

See [Continue MCP docs](https://docs.continue.dev/customization/mcp) for the current schema.

2. **Instructions** — reference in Continue rules or root `AGENTS.md`:

```
Always follow mindplan/agent/playbook.md for MindPlan SDLC execution (all software work). Use mindplan/agent/skills/define-entities/ when scaffolding MindPlan nodes; use mindplan/agent/skills/plan-project/ for plan-only product modeling (no application code).
```

3. Restart Continue or reload config.
