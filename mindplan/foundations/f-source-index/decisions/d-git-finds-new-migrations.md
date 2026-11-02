### d-git-finds-new-migrations

- Decision: A new migration is detected from git (untracked, staged, or added on the branch) as well as from claims.
- Alternatives:
  - Claims only (misses a migration added inside a folder the node already claims)
  - File modification times (a fresh checkout makes every file look new)
- Why: Migrations usually land in an already-claimed migrations folder, so the claim list does not change.
- Change: decision-records
- Date: 2026-10-20
