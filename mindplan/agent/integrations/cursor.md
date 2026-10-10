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

2. **Always-on stub** — `mindplan-mcp init` installs `.cursor/rules/mindplan.mdc` (alwaysApply frontmatter + a short stub) when missing. The stub requires `get_project` (dialect + project brief). MCP `instructions` are the same pointer. `mindplan/agent/playbook.md` is the fallback if tools are hidden. After upgrading MindPlan, re-run `mindplan-mcp init -f` (or `--force`) to refresh the stub, playbook, skills, and Cursor copies. If the rule was deleted, recreate it with:

```yaml
---
description: MindPlan — orient on the product graph before planning or changing code
alwaysApply: true
---
```

Paste the contents of `templates/agent/agents-stub.md` below the frontmatter. Root `AGENTS.md` (also installed by init when missing) carries the same stub for agents that read it.

3. **Skills** — `mindplan-mcp init` installs Cursor-native skill discovery paths when missing:
   - `.cursor/skills/mindplan-define-entities/` (scaffold Journey, Foundation, Interaction, Interface, Bug nodes)
   - `.cursor/skills/mindplan-plan-project/` (plan-only product modeling; no application code)

   Canonical copies also live under `mindplan/agent/skills/` (ignored by `.cursorignore`). Re-copy from those directories, or re-run `mindplan-mcp init -f` after a MindPlan upgrade / if the `.cursor/skills/` trees were removed.

4. **`.cursorignore`** — `mindplan-mcp init` installs `.cursorignore` at the project root when missing. It ignores the derived map and copied agent assets under `mindplan/agent/**` — **not** territory MDX — because Cursor-facing copies live under `.cursor/rules` and `.cursor/skills`:

```gitignore
mindplan/map.md
mindplan/agent/**
```

If you already have a `.cursorignore` that lists `mindplan/**/current.mdx` or `mindplan/**/next.mdx`, remove those lines so agents can edit prose with normal file tools (host “changed files” UI). Keep ignoring `mindplan/map.md` — it is not graph authority.

5. **`.cursor/permissions.json`** — `mindplan-mcp init` installs this when missing. It allowlists MindPlan MCP tools (`mindplan:*`, plus the Cursor UI server id `project-0-mindplan-mindplan:*` / `*mindplan*:*`) so Auto-review does **not** prompt on playbook-required graph mutations (`update_node_status`, `create_node`, `link_nodes`, etc.). Requires Run Mode **Auto-review** or **Allowlist** (Settings → Agents → Approvals & Execution). Defining `mcpAllowlist` in this file replaces the in-app MCP allowlist for that key type — if you already allowlisted other MCP servers in Settings, add those patterns to the same file (or `~/.cursor/permissions.json`).

6. **File ownership** — `mindplan-mcp init` writes `mindplan/config.json` as `{ sources, exclude }` (default `sources: ["src/**"]`). Declare owned files with `set_implementation_files`. Legacy `implementation_packages` configs migrate on init. See SPEC §1.2.

7. **Authority split**
   - **MCP** — create/link/status/`open_next`/`discard_next`. Graph tool results include `changed_files` (paths MCP wrote). Those writes do **not** appear in Cursor’s agent “changed files” strip — inspect via Source Control or by opening the cited path.
   - **File tools** — `title` / `description` / body / checkboxes at `current_path` / `next_path` from orientation. These **do** show in the agent edit UI.
   - Never hand-edit server-owned frontmatter (`state`, edges, timestamps).

8. **Check at every handoff** — default `mindplan-mcp check` before self-`ready`, `in-review`, `ship` / `resolved`, or claiming the session is done. Optionally `check --base <ref>` for local dirty-src hygiene — not a CI merge gate. Host typecheck is not a MindPlan gate. Code review is outside the MindPlan dialect — use host process or `mindplan/project.md` rules if desired.

9. Reload MCP servers (Cursor Settings → MCP, or restart Cursor).
