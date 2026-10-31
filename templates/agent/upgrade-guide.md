# After upgrading the graph

`upgrade_project` brought `mindplan/` to this server's migration level; its `changed_files` lists every graph file it wrote. Finish the upgrade with these steps and tell the user what you did.

1. **Remove leftovers.** Delete every path in `leftovers`: skill and rule copies older releases installed for Cursor and Claude Code. The server now serves the skills itself (`get_skill`), so the copies would only go stale. Ask first if the user edited one of them.
2. **Refresh the pointer.** When `pointer_outdated` is true, make `MINDPLAN.md` at the repository root equal the `pointer` field, and wire it the way the setup guide's first step says: `@MINDPLAN.md` in `CLAUDE.md`, and a "Read and follow MINDPLAN.md" line in `AGENTS.md` when the repository has one. Remove any older MindPlan stub section from those files (one that starts `# MindPlan` and mentions "init-installed host copies").
3. **Commit it alone.** Commit the upgrade (the graph changes plus the steps above) on its own, before other work, so reviewers can tell the migration from a feature. Teammates on an older `mindplan-mcp` must upgrade the package before they can use the graph.
4. **Check.** Run `run_check` and fix every `Blocked:` line.
