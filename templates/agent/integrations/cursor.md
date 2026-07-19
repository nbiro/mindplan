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

2. **Playbook (always apply)** — copy or symlink `mindplan/agent/playbook.md` to `.cursor/rules/mindplan.mdc` (Cursor rules use `.mdc` frontmatter):

```yaml
---
description: MindPlan SDLC execution process — always-on development workflow, MCP mutations, compiler rules
alwaysApply: true
---
```

Paste the playbook body below the frontmatter. This rule must apply to every session — it is the operational process for all software work.

3. **Skill** — copy `mindplan/agent/skills/define-entities/` to `.cursor/skills/mindplan-define-entities/` for Cursor-native skill discovery when scaffolding Journey, Foundation, Workflow, or Bug nodes.

4. **`.cursorignore`** — `mindplan-mcp init` installs `.cursorignore` at the project root when missing. It blocks agent file tools from reading `mindplan/**/current.mdx`, `mindplan/**/next.mdx`, and `mindplan/map.md` so agents orient exclusively through MCP (`orient_for_work`, `get_node_context`, `get_blast_radius`). Territory writes go through `patch_node_territory`. If you already have a `.cursorignore`, merge these patterns manually:

```gitignore
mindplan/**/current.mdx
mindplan/**/next.mdx
mindplan/map.md
mindplan/agent/**
```

5. Reload MCP servers (Cursor Settings → MCP, or restart Cursor).
