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

2. **Playbook (always apply)** — `mindplan-mcp init` installs `.cursor/rules/mindplan.mdc` (alwaysApply frontmatter + playbook body) when missing. After upgrading MindPlan, re-run `mindplan-mcp init -f` (or `--force`) to refresh playbook/skills/Cursor copies from the package templates. If that file was deleted without force, recreate it from `mindplan/agent/playbook.md` with:

```yaml
---
description: MindPlan SDLC execution process — always-on development workflow, MCP mutations, compiler rules
alwaysApply: true
---
```

Paste the playbook body below the frontmatter. This rule must apply to every session — it is the operational process for all software work. Root `AGENTS.md` (also installed by init when missing) is a second always-on copy for agents that read it.

3. **Skills** — `mindplan-mcp init` installs Cursor-native skill discovery paths when missing:
   - `.cursor/skills/mindplan-define-entities/` (scaffold Journey, Foundation, Workflow, Bug nodes)
   - `.cursor/skills/mindplan-plan-project/` (plan-only product modeling; no application code)
   - `.cursor/skills/mindplan-review-work/` (Plan Review `draft → ready` and Implementation review `in-review → ship` / `resolved`)

   Canonical copies also live under `mindplan/agent/skills/` (ignored by `.cursorignore`). Re-copy from those directories, or re-run `mindplan-mcp init -f` after a MindPlan upgrade / if the `.cursor/skills/` trees were removed.

4. **`.cursorignore`** — `mindplan-mcp init` installs `.cursorignore` at the project root when missing. It ignores the derived map and copied agent assets under `mindplan/agent/**` — **not** territory MDX — because Cursor-facing copies live under `.cursor/rules` and `.cursor/skills`:

```gitignore
mindplan/map.md
mindplan/agent/**
```

If you already have a `.cursorignore` that lists `mindplan/**/current.mdx` or `mindplan/**/next.mdx`, remove those lines so agents can edit prose with normal file tools (host “changed files” UI). Keep ignoring `mindplan/map.md` — it is not graph authority.

5. **`.cursor/permissions.json`** — `mindplan-mcp init` installs this when missing. It allowlists MindPlan MCP tools (`mindplan:*`, plus the Cursor UI server id `project-0-mindplan-mindplan:*` / `*mindplan*:*`) so Auto-review does **not** prompt on playbook-required graph mutations (`update_node_status`, `create_node`, `link_nodes`, etc.). Requires Run Mode **Auto-review** or **Allowlist** (Settings → Agents → Approvals & Execution). Defining `mcpAllowlist` in this file replaces the in-app MCP allowlist for that key type — if you already allowlisted other MCP servers in Settings, add those patterns to the same file (or `~/.cursor/permissions.json`).

6. **Layout mode** — `mindplan-mcp init` writes `mindplan/config.json`. Use `--layout free` on an existing codebase so MindPlan does **not** require `src/foundations|workflows/<id>/` packages or dirty-src ownership checks. Default / `--layout prescribed` keeps screaming architecture. See SPEC §1.2.1.

7. **Authority split & review**
   - **MCP** — create/link/status/`open_next`/`discard_next`. Graph tool results include `changed_files` (paths MCP wrote). Those writes do **not** appear in Cursor’s agent “changed files” strip — review via Source Control or by opening the cited path.
   - **File tools** — `title` / `description` / body / checkboxes at `current_path` / `next_path` from orientation. These **do** show in the agent edit UI.
   - Never hand-edit server-owned frontmatter (`state`, edges, timestamps).

8. **Git delivery** — always feature branch + PR. Never push to `main`/`master` (see playbook **Git delivery**). Run `mindplan-mcp check` on the branch; `mindplan-mcp check --for-main` before merge.

9. Reload MCP servers (Cursor Settings → MCP, or restart Cursor).
