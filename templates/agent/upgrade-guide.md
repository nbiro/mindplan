# After upgrading the graph

`upgrade_project` brought `mindplan/` to this server's migration level; its `changed_files` lists every graph file it wrote. Finish with these steps and tell the user what you did.

1. **Remove leftovers.** Delete every path in `leftovers`: host copies of MindPlan skills and rules that would only go stale, since the server serves the skills itself (`get_skill`). Ask first if the user edited one.
2. **Refresh the pointer.** When `pointer_outdated` is true, make `MINDPLAN.md` at the repository root equal the `pointer` field and wire it as in setup: `@MINDPLAN.md` in `CLAUDE.md`, and a "Read and follow MINDPLAN.md" line in `AGENTS.md` when the repository has one. Remove any MindPlan stub section from those files (one that starts `# MindPlan` and mentions "init-installed host copies").
3. **Commit it alone.** Commit the upgrade (the graph changes plus steps 1 and 2) on its own, before other work, so reviewers can tell the migration from a feature. When `migrations.mapIgnored` is true, the upgrade ran `git rm --cached mindplan/map.md` and listed it in `mindplan/.gitignore`: commit that removal too (the file stays on disk). `migrations.revisionsMoved` lists each `<id>.next.mdx` moved to `revisions/<change>/` under its change id (`rev-<id>` when it had none). Teammates must upgrade `mindplan-mcp` before they can use the graph.
4. **Check.** Run `run_check` and fix every `Blocked:` line.
