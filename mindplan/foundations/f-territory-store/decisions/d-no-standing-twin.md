### d-no-standing-twin

- Decision: A shipped node keeps no standing <id>.next.mdx twin: open_next writes the next file from live, and ship, discard, unship, and retire delete it, so live writers touch one file and report no twin.
- Alternatives:
  - Keep the twin so a PR shows the revision as edits to an existing next file (the merge gate already makes every PR ship its change, so the PR's diff of <id>.mdx shows the contract change, and the twin shows it a second time)
  - Keep the twin but stop re-syncing it on live writes (a stale copy is worse than none; the drift check exists because of it)
- Why: The twin doubled every node file and every live write, needed drift checks, an init backfill, and its own bug class (missing twin paths in changed_files), and its one benefit, a diff against live while a revision is open, is covered by the shipped <id>.mdx diff the merge gate guarantees.
- Consequences: While a revision is open, a reviewer sees <id>.next.mdx as a new file; compare it with <id>.mdx to see the change. Projects from releases before 0.8.0 keep their twins until init removes them; until then they load as no revision.
- Supersedes: d-writers-return-twin-path
- Change: no-mirror-twin
- Date: 2026-10-29
