### d-gate-blocks-only-in-review

- Decision: Only the move to in-review Blocks a missing decision; run_check always warns, with or without change.
- Alternatives:
  - Make run_check({ change }) fail too (a draft change would fail the check the brief says should only warn)
- Why: The decision should be captured before review, but an agent mid-design needs the signal without a failing check.
- Change: decision-records
- Date: 2026-10-20
