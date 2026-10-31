# Continue

1. **Register MCP** — in `.continue/config.yaml` (or `config.json`), add under `mcpServers`:

```yaml
mcpServers:
  - name: mindplan
    command: npx
    args:
      - mindplan-mcp
```

`npx mindplan-mcp` runs the copy pinned in your `package.json` dev dependencies (`npm install -D mindplan-mcp`). In a project without a `package.json`, use `args: ["-y", "mindplan-mcp@0.13"]`.

See [Continue MCP docs](https://docs.continue.dev/customization/mcp) for the current schema.

2. Restart Continue or reload config.

3. **Set up MindPlan** — ask Continue to set up MindPlan in the repository. It calls `setup_project` and follows the returned guide: it writes `MINDPLAN.md` at the root and points your agent files at it (a line in `AGENTS.md`, or a Continue rule that references `MINDPLAN.md` if this host reads neither `AGENTS.md` nor `CLAUDE.md`), and proposes moving your standing rules into the project brief.
