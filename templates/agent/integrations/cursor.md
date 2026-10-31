# Cursor

1. **Register MCP** — merge into `.cursor/mcp.json` (the package ships the same snippet as `templates/agent/mcp.json.example`):

```json
{
  "mcpServers": {
    "mindplan": {
      "command": "npx",
      "args": ["mindplan-mcp"]
    }
  }
}
```

`npx mindplan-mcp` runs the copy pinned in your `package.json` dev dependencies (`npm install -D mindplan-mcp`). In a project without a `package.json`, use `"args": ["-y", "mindplan-mcp@0.13"]`.

Reload MCP servers (Cursor Settings → MCP, or restart Cursor).

2. **Set up MindPlan** — ask the Cursor agent to set up MindPlan in the repository. It calls `setup_project`, which creates `mindplan/` (`config.json` as `{ sources, exclude }` with default `sources: ["src/**"]`, an empty `project.md`, `version.json`), and follows the returned guide:
   - writes `MINDPLAN.md` at the root and adds a "Read and follow MINDPLAN.md" line to `AGENTS.md`, which Cursor reads (or, if you do not use `AGENTS.md`, a rule under `.cursor/rules/` that points at `MINDPLAN.md`);
   - adds `mindplan/**` to `.cursorignore`, so Cursor never edits or indexes the graph with its own file tools (MCP is the only writer), and `.mindplan-cache/` to `.gitignore`;
   - proposes moving your standing rules (including `.cursor/rules/*` and `.cursorrules`) into the project brief, and edits those files only after you approve.

3. **Skills** — `define-entities` and `plan-project` are served by the server through `get_skill`; nothing is copied to `.cursor/skills/`.

4. **File ownership** — declare owned files with `set_implementation_files`; change the source universe with `patch_config`. See SPEC §1.2.

5. **Authority** — MCP is the only writer of `mindplan/` (nodes, attachments, `project.md`, `config.json`). Tool results include `changed_files` — inspect via Source Control (hosts often omit subprocess writes from the agent edit strip). Never hand-edit territory MDX or frontmatter.

6. **Handoff matches the graph** — before self-`ready`, `in-review`, `ship` / `resolved`, or claiming the session is done, update the graph so it matches the implementation, then run `run_check` (CLI `mindplan-mcp check`). When the implementation is done and a merge is requested, `ship` the node. Host typecheck is not a MindPlan gate. Code review is outside the MindPlan dialect — use host process or `mindplan/project.md` rules if desired.

7. **Upgrading** — after upgrading `mindplan-mcp` to a release that adds a graph migration, tools answer `Blocked: Version`: ask the agent to call `upgrade_project` and follow its guide (it deletes the old `.cursor/skills/mindplan-*` and `.cursor/rules/mindplan.mdc` copies earlier releases installed).
