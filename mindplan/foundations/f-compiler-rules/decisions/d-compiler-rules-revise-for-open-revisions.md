### d-compiler-rules-revise-for-open-revisions

- Decision: This revision reopens f-compiler-rules so its gates read graphUnder(graph, change) and Block in-review on rebase conflicts; the revision logic itself lives in f-revision-model.
- Alternatives:
  - A wrapper Foundation that re-implements the gates per revision (duplicates every rule the gates already encode)
- Why: The gates are its contract; only the graph they judge changes.
- Change: multi-revisions
- Date: 2026-11-02
