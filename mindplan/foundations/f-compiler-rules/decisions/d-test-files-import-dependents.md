### d-test-files-import-dependents

- Decision: A node's test files may import, read-only and without an edge, files owned by the node and by its direct dependents; test_imports lists were not added.
- Alternatives:
  - A per-node test_imports list (one more field to keep in step, for the same common case)
- Why: The failing case was a template's test importing the registry that reads it, which is always a direct dependent; one rule covers it with nothing to declare.
- Change: test-import-scope
- Date: 2026-11-03
