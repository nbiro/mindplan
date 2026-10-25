# Continue

1. **Register MCP** — in `.continue/config.yaml` (or `config.json`), add under `mcpServers`:

```yaml
mcpServers:
  - name: mindplan
    command: npx
    args:
      - mindplan-mcp
```

`npx mindplan-mcp` runs the copy pinned in your `package.json` dev dependencies (`npm install -D mindplan-mcp`). In a project without a `package.json`, use `args: ["-y", "mindplan-mcp@0.6"]`.

See [Continue MCP docs](https://docs.continue.dev/customization/mcp) for the current schema.

2. **Instructions** — MCP already requires `get_project` (dialect + project brief). `init` writes that stub to `AGENTS.md` when missing. Point Continue rules at the stub if this host does not read `AGENTS.md`.

3. Restart Continue or reload config.
