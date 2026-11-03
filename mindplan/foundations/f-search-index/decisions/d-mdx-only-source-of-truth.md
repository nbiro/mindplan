### d-mdx-only-source-of-truth

- Decision: The <id>.mdx files stay the only source of truth for the graph; the search index is a derived cache and nothing reads graph facts back from it.
- Alternatives:
  - Make a SQLite database authoritative and render the .mdx files from it (git branches, PR diffs, merges and history stop describing the plan)
- Why: Git branches, PR diffs, merges and history work on files; a database would need its own merge story and would hide plan changes from review.
- Consequences: Every search re-checks the index against the loaded graph; a lost or corrupt cache is rebuilt, never repaired.
- Change: semantic-search
- Date: 2026-10-25
