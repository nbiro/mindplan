### d-capability-migration-moves-folders

- Decision: Migration level 3 moves each mindplan/journeys/<id>/ folder to mindplan/capabilities/<id>/ and rewrites its type frontmatter, and nothing reads the old folder or the old type name at load time.
- Alternatives:
  - Accept both Journey and Capability when loading: a compatibility layer the project rules rule out, and two names for one type is what the rename removes
  - Also rename ids (j- to c-): ids are stable names that commits, decisions, code comments, and other branches reference, so renaming them breaks more than it tidies
  - Rewrite Journey in node bodies too: prose may use the word in its UX sense, and the migration cannot tell which
- Why: The version gate already Blocks every tool until upgrade_project runs, so a one-way move in code is enough and the loader stays single-named.
- Consequences: A branch cut before the upgrade that adds a node under journeys/ needs upgrade_project again after it merges; graphStatus reports upgrade while journeys/ holds a node folder, whatever the stamp says.
- Change: capability-type
- Date: 2026-11-01
