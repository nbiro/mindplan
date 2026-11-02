### d-version-stamp-file

- Decision: The package version that last migrated a project lives in its own file, mindplan/version.json ({ package, graph }), written only by init; a mismatch with the running package warns (get_project, run_check) and never Blocks.
- Alternatives:
  - A field in mindplan/config.json (config is user-edited through patch_config, so a stamp there could be changed without running the migrations it claims)
  - A stamp per agent file, e.g. a version line in playbook.md (does not cover graph-format migrations and makes the copies differ from the templates)
  - Block every tool on a mismatch (one stale stamp after an npm update would stop all planning until init runs)
- Why: Init is the only step that both refreshes the package-owned agent files and runs graph migrations, so the stamp must change only when init runs; projects now upgrade the package through npm, and a warning tells the agent to rerun init without stopping work.
- Consequences: A release that changes the playbook, skills, or graph format is picked up by a project only after it reruns init; a future graph-format bump can turn the ahead/behind graph case into a Block.
- Change: project-version-stamp
- Date: 2026-10-23
