### d-block-on-pending-migration

- Decision: mindplan/version.json records the migration level the graph reached ({ package, graph, migrations }); every gated tool and the check are Blocked while that level is below the server's newest migration (call upgrade_project), above it or on a newer graph format (upgrade mindplan-mcp), or while no graph exists (call setup_project); a release without a new migration changes nothing.
- Alternatives:
  - Keep warning on any package mismatch and never Block (d-version-stamp-file): an agent on a new server keeps writing an old-format graph it may misread
  - Block on any package version difference: every patch release forces an upgrade commit in every repo even when no migration changed anything
  - Run pending migrations automatically at server start: an unasked-for diff lands in whatever change the agent is working on, and a teammate on an older server cannot read it
- Why: Migrations change the graph's shape, so code that expects the new shape must not read or write the old one; tying the Block to the migration level, not the package version, keeps releases without migrations free.
- Consequences: A release that adds a migration must raise MIGRATION_LEVEL; every project then runs upgrade_project once in its own commit. A branch opened before an upgrade that adds an old-format node is caught by the check, and rerunning upgrade_project fixes it. Test fixtures without a stamp set MINDPLAN_VERSION_GATE=off.
- Supersedes: d-version-stamp-file
- Change: setup-upgrade
- Date: 2026-10-31
