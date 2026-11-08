### d-store-notes-raw-plan-writes

- Decision: The territory store's few raw directory removals and renames call notePlanWrite(path) in place, instead of this revision restructuring the store.
- Alternatives:
  - Split or invert f-territory-store first (its hotspot diagnosis is unknown: 10.3 of its 11.3 rate predates recorded reasons, so there is no evidence yet which refactor it needs, and this change adds no behavior to it)
  - Route every raw fs.rmSync / renameSync through new io wrappers (more surface in f-source-index for four call sites)
- Why: The store only has to report the paths it already removes or renames; its contract is unchanged, so a refactor now would be guesswork rather than a response to a diagnosed pressure.
- Change: graph-load-memo
- Date: 2026-11-08
