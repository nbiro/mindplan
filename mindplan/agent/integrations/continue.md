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

2. **Instructions** — MCP already requires `get_project` (dialect + project brief). `init` writes that stub to `AGENTS.md` when missing. Point Continue rules at the stub if this host does not read `AGENTS.md`.

3. Restart Continue or reload config.
