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
Read and follow mindplan/agent/playbook.md. Use mindplan/agent/skills/define-entities/ when scaffolding MindPlan nodes.
```

3. Restart Continue or reload config.
