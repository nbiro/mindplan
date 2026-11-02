### d-derived-in-place-stale-pass

- Decision: The plain check gives every shipped, non-retired node with no open next whose claimed files changed against the default-branch merge base the full stale-text pass (warnings); without git or a base it falls back to the missing-path pass silently.
- Alternatives:
  - Keep the full pass for labeled neighbors in run_check({ change }) only (needs the stored label this change removes)
  - Give every shipped node the full pass (noisy on untouched nodes whose text predates their code)
- Why: The files a branch edits in place are exactly the nodes whose text may now be wrong; the merge gate already maps changed paths to claims with the same probe, so the signal costs no new state.
- Consequences: The check runs git when a base exists (one memoized probe per run, shared with dirty-src and the strict gate).
- Change: graph-edges-stale-labels
- Date: 2026-10-31
