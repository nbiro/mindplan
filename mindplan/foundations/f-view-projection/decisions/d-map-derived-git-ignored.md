### d-map-derived-git-ignored

- Decision: mindplan/map.md is derived: it is rebuilt on write but git-ignored and never listed in changed_files.
- Alternatives:
  - Keep it committed and regenerate it after a merge (every parallel branch still conflicts on it)
- Why: The user chose it: a file every write rewrites is the one guaranteed merge conflict between parallel branches.
- Change: multi-revisions
- Date: 2026-11-02
