### d-tests-as-file-list

- Decision: A node links its tests through an optional `tests` list of repo-relative test files, directories, or globs on its frontmatter, not through a new node type or edge.
- Alternatives:
  - A Test node type with a verifies edge (changes the taxonomy, the SPEC tables, and the lifecycle; every suite becomes a node to create and ship)
  - Move each suite under the node it tests and rely on implements claims (no many-to-many: a suite covering several nodes can be claimed by only one)
- Why: Tests are files, and one suite often verifies several nodes; a non-exclusive file list beside implements says exactly that with one optional field, so GRAPH_VERSION stays 1.
- Consequences: Ownership of a test file stays with whoever claims it in implements; tests only says which nodes it verifies. The graph cannot hold per-case test names, only files.
- Change: node-tests
- Date: 2026-10-25
