# Cursor

1. Register MCP — merge into `.cursor/mcp.json` (see `mindplan/agent/mcp.json.example`):

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

2. **Playbook** — copy or symlink `mindplan/agent/playbook.md` to `.cursor/rules/mindplan.mdc` (optional; Cursor rules use `.mdc` frontmatter):

```yaml
---
description: MindPlan SDLC — MCP mutations, taxonomy, compiler rules
alwaysApply: true
---
```

Paste the playbook body below the frontmatter.

3. **Skill** — copy `mindplan/agent/skills/define-entities/` to `.cursor/skills/mindplan-define-entities/` if you want Cursor-native skill discovery.

4. Reload MCP servers (Cursor Settings → MCP, or restart Cursor).
