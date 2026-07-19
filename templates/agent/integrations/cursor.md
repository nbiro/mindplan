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

3. **Skills** — copy for Cursor-native skill discovery:
   - `mindplan/agent/skills/define-entities/` → `.cursor/skills/mindplan-define-entities/` (scaffold Journey, Foundation, Workflow, Bug nodes)
   - `mindplan/agent/skills/plan-project/` → `.cursor/skills/mindplan-plan-project/` (plan-only product modeling; no application code)

4. **`.cursorignore`** — `mindplan-mcp init` installs `.cursorignore` at the project root when missing. It ignores the derived map and copied agent assets — **not** territory MDX:

```gitignore
mindplan/map.md
mindplan/agent/**
```

If you already have a `.cursorignore` that lists `mindplan/**/current.mdx` or `mindplan/**/next.mdx`, remove those lines so agents can edit prose with normal file tools (host “changed files” UI). Keep ignoring `mindplan/map.md` — it is not graph authority.

5. **`.cursor/permissions.json`** — `mindplan-mcp init` installs this when missing. It allowlists MindPlan MCP tools (`mindplan:*`, plus the Cursor UI server id `project-0-mindplan-mindplan:*` / `*mindplan*:*`) so Auto-review does **not** prompt on playbook-required graph mutations (`update_node_status`, `create_node`, `link_nodes`, etc.). Requires Run Mode **Auto-review** or **Allowlist** (Settings → Agents → Approvals & Execution). Defining `mcpAllowlist` in this file replaces the in-app MCP allowlist for that key type — if you already allowlisted other MCP servers in Settings, add those patterns to the same file (or `~/.cursor/permissions.json`).

6. **Authority split & review**
   - **MCP** — create/link/status/`open_next`/`discard_next`. Graph tool results include `changed_files` (paths MCP wrote). Those writes do **not** appear in Cursor’s agent “changed files” strip — review via Source Control or by opening the cited path.
   - **File tools** — `title` / `description` / body / checkboxes at `current_path` / `next_path` from orientation. These **do** show in the agent edit UI.
   - Never hand-edit server-owned frontmatter (`state`, edges, timestamps).

7. Reload MCP servers (Cursor Settings → MCP, or restart Cursor).
