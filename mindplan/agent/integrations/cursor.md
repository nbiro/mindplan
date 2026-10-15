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

2. **Always-on stub** — `mindplan-mcp init` installs `.cursor/rules/mindplan.mdc` (alwaysApply frontmatter + a short stub) when missing. The stub requires `get_project` (dialect + project brief), `get_rules` then `orient_for_work` before each action, and the `plan-project` skill before new-feature graph work. MCP `instructions` are the same short pointer (no rules body). If tools are hidden, use `.cursor/rules` + `.cursor/skills` + root `AGENTS.md` — not `mindplan/**`. After upgrading MindPlan, re-run `mindplan-mcp init -f` (or `--force`) to refresh the stub, playbook, skills, and Cursor copies. If the rule was deleted, recreate it with:

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

4. **`.cursorignore`** — `mindplan-mcp init` installs `.cursorignore` at the project root when missing. It ignores the entire `mindplan/**` tree so Cursor will not edit or index territory (MCP is the only writer). Offline fallback is `get_project` plus copies under `.cursor/rules` and `.cursor/skills`:

```gitignore
mindplan/**
```

5. **`.cursor/permissions.json`** — `mindplan-mcp init` installs this when missing. It allowlists MindPlan MCP tools (`mindplan:*`, plus the Cursor UI server id `project-0-mindplan-mindplan:*` / `*mindplan*:*`) so Auto-review does **not** prompt on playbook-required graph mutations (`update_node_status`, `create_node`, `link_nodes`, `patch_node_territory`, etc.). Requires Run Mode **Auto-review** or **Allowlist** (Settings → Agents → Approvals & Execution). Defining `mcpAllowlist` in this file replaces the in-app MCP allowlist for that key type — if you already allowlisted other MCP servers in Settings, add those patterns to the same file (or `~/.cursor/permissions.json`).

6. **File ownership** — `mindplan-mcp init` writes `mindplan/config.json` as `{ sources, exclude }` (default `sources: ["src/**"]`). Declare owned files with `set_implementation_files`. Legacy `implementation_packages` configs migrate on init. See SPEC §1.2. Change config with `patch_config`.

7. **Authority** — MCP is the only writer of `mindplan/` (nodes, attachments, `project.md`, `config.json`). Tool results include `changed_files` — inspect via Source Control (hosts often omit subprocess writes from the agent edit strip). Never hand-edit territory MDX or frontmatter.

8. **Handoff matches the graph** — before self-`ready`, `in-review`, `ship` / `resolved`, or claiming the session is done, update the graph so it matches the implementation, then run default `mindplan-mcp check`. When the implementation is done and a merge is requested, `ship` the node. Optionally `check --base <ref>` for local dirty-src hygiene — not a CI merge gate. Host typecheck is not a MindPlan gate. Code review is outside the MindPlan dialect — use host process or `mindplan/project.md` rules if desired.

9. Reload MCP servers (Cursor Settings → MCP, or restart Cursor).
